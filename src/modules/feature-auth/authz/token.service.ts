import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Cron } from '@nestjs/schedule';
import { Auth, Prisma, Role, User } from '@prisma/client';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { AuthConfig } from './auth.config';
import { authError, AuthErrorCode } from './auth.error';
import { SessionStore, SessionTransactions } from './session.store';
import { RecordStatusEnum } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';

export interface TokenMetadata {
  userAgent?: string;
  ip?: string;
}
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

type UserWithRole = User & { role: Role };

@Injectable()
export class TokenService {
  constructor(
    private readonly transactions: SessionTransactions,
    private readonly sessions: SessionStore,
    private readonly jwt: JwtService,
    private readonly config: AuthConfig,
  ) {}

  private hash(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  private async issue(tx: Prisma.TransactionClient, user: UserWithRole, sid: string, metadata: TokenMetadata) {
    const raw = randomBytes(64).toString('base64url');
    await tx.refreshToken.create({
      data: {
        userId: user.id,
        sid,
        tokenHash: this.hash(raw),
        expiresAt: new Date(Date.now() + this.config.refreshTtl * 1000),
        revokedAt: null,
        replacedById: null,
        lastUsedAt: null,
        userAgent: metadata.userAgent?.slice(0, 1024) ?? null,
        ip: metadata.ip ?? null,
      },
    });
    const accessToken = await this.jwt.signAsync({ sub: user.id, role: user.role.code, sid, jti: randomUUID() });
    return { accessToken, refreshToken: raw };
  }

  async login(auth: Auth, metadata: TokenMetadata): Promise<TokenPair> {
    const sid = randomUUID();
    const result = await this.transactions.write(async (tx) => {
      // Kiểm tra lại thông tin đăng nhập sau khi lấy khóa: mật khẩu có thể đã được đổi
      // trong lúc bcrypt đang so sánh với thông tin đăng nhập trước đó.
      const current = await tx.auth.findFirst({ where: { id: auth.id, isDeleted: false } });
      const user = await tx.user.findFirst({
        where: { id: auth.userId, isDeleted: false, status: RecordStatusEnum.ACTIVE },
        include: { role: true },
      });
      if (!current || current.password !== auth.password || !user) throw authError(ErrorCode.LOGIN_INVALID);
      const oldTokens = await tx.refreshToken.findMany({
        where: { userId: user.id, revokedAt: null },
        select: { sid: true },
      });
      await tx.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return {
        pair: await this.issue(tx, user, sid, metadata),
        oldSids: [...new Set(oldTokens.map((token) => token.sid))],
      };
    });
    for (const oldSid of result.oldSids) await this.sessions.revoke(oldSid);
    await this.sessions.activate(sid, auth.userId, this.config.refreshTtl);
    return result.pair;
  }

  async refresh(raw: string | undefined): Promise<{ accessToken: string }> {
    if (!raw) throw authError(ErrorCode.INVALID_TOKEN);
    const result = await this.transactions.write(
      async (tx): Promise<{ accessToken: string } | { error: AuthErrorCode; sid?: string }> => {
        const token = await tx.refreshToken.findFirst({ where: { tokenHash: this.hash(raw) } });
        if (!token) return { error: ErrorCode.INVALID_TOKEN };
        if (token.revokedAt) return { error: ErrorCode.SESSION_REVOKED };
        if (token.expiresAt.getTime() <= Date.now()) return { error: ErrorCode.TOKEN_EXPIRED };
        const now = new Date();
        const user = await tx.user.findFirst({
          where: { id: token.userId, isDeleted: false, status: RecordStatusEnum.ACTIVE },
          include: { role: true },
        });
        if (!user) {
          await tx.refreshToken.updateMany({
            where: { sid: token.sid, revokedAt: null },
            data: { revokedAt: now },
          });
          return { error: ErrorCode.SESSION_REVOKED, sid: token.sid };
        }
        // RT cố định cho cả phiên: chỉ cấp AT mới và cập nhật lần sử dụng.
        // Không tạo bản ghi, không đổi hash, sid hoặc mốc hết hạn của RT.
        const accessToken = await this.jwt.signAsync({
          sub: user.id,
          role: user.role.code,
          sid: token.sid,
          jti: randomUUID(),
        });
        await tx.refreshToken.updateMany({ where: { id: token.id }, data: { lastUsedAt: now } });
        return { accessToken };
      },
    );
    // Chỉ ném lỗi SAU khi commit; ném lỗi trong transaction sẽ hoàn tác việc thu hồi phiên.
    if ('error' in result) {
      if (result.sid) await this.sessions.revoke(result.sid);
      throw authError(result.error);
    }
    return result;
  }

  async logout(sid: string, raw: string | undefined) {
    await this.transactions.write(async (tx) => {
      const now = new Date();
      if (raw) {
        // Chỉ ghi nhận lần sử dụng khi token khớp. Cookie cũ hoặc thuộc phiên khác không được
        // thu hồi phiên khác hay ngăn đăng xuất sid đã được xác thực.
        await tx.refreshToken.updateMany({ where: { sid, tokenHash: this.hash(raw) }, data: { lastUsedAt: now } });
      }
      await tx.refreshToken.updateMany({ where: { sid, revokedAt: null }, data: { revokedAt: now } });
    });
    await this.sessions.revoke(sid);
  }

  @Cron('0 0 3 * * *')
  async cleanup() {
    await this.transactions.write(async (tx) => {
      const now = new Date();
      const cutoff = new Date(now.getTime() - 30 * 86400000);
      await tx.refreshToken.deleteMany({
        where: { OR: [{ expiresAt: { lt: now } }, { revokedAt: { lt: cutoff } }] },
      });
    });
  }
}
