import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Cron } from '@nestjs/schedule';
import { Auth, Prisma, Role, User, UserStatus } from '@prisma/client';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { PrismaService } from 'src/common/databases/prisma.service';
import { ErrorCode } from 'src/common/types/error-code';
import type { RequestContext } from 'src/common/decorators/request-context';
import { SecurityEventService } from 'src/providers/security-event/security-event.service';
import { isStaffRole } from '../permission/staff-role';
import { AuthConfig } from './auth.config';
import { authError } from './auth.error';
import { SessionStore, SessionTransactions } from './session.store';

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
  private readonly logger = new Logger(TokenService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly transactions: SessionTransactions,
    private readonly sessions: SessionStore,
    private readonly jwt: JwtService,
    private readonly config: AuthConfig,
    private readonly security: SecurityEventService,
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
        // Cắt theo đúng độ dài cột: userAgent varchar(300), ip varchar(45).
        userAgent: metadata.userAgent?.slice(0, 300) ?? null,
        ip: metadata.ip?.slice(0, 45) ?? null,
      },
    });
    const accessToken = await this.jwt.signAsync({ sub: user.id, role: user.role.code, sid, jti: randomUUID() });
    return { accessToken, refreshToken: raw };
  }

  /** Đăng nhập một máy: thu hồi mọi phiên cũ và cấp phiên mới trong cùng transaction, khoá theo người dùng. */
  async login(auth: Auth, ctx: RequestContext): Promise<TokenPair> {
    const metadata: TokenMetadata = { userAgent: ctx.userAgent ?? undefined, ip: ctx.ip ?? undefined };
    const sid = randomUUID();
    const pair = await this.transactions.forUser(auth.userId, async (tx) => {
      // Kiểm tra lại thông tin đăng nhập sau khi lấy khóa: mật khẩu có thể đã được đổi
      // trong lúc bcrypt đang so sánh với thông tin đăng nhập trước đó.
      const current = await tx.auth.findFirst({ where: { id: auth.id, isDeleted: false } });
      const user = await tx.user.findFirst({
        where: { id: auth.userId, isDeleted: false, status: UserStatus.ACTIVE },
        include: { role: true },
      });
      if (!current || current.password !== auth.password || !user) throw authError(ErrorCode.LOGIN_INVALID);
      await tx.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      const issued = await this.issue(tx, user, sid, metadata);
      // Cùng transaction: đăng nhập rollback thì không còn dòng LOGIN_OK.
      if (isStaffRole(user.role.code)) {
        await this.security.record(
          [{ type: 'AUTH.LOGIN_OK', actorId: user.id, actorRoleCode: user.role.code, sessionId: sid, context: ctx }],
          tx,
        );
      }
      return issued;
    });
    await this.sessions.activate(sid, auth.userId, this.config.refreshTtl);
    return pair;
  }

  /**
   * Cấp AT mới từ RT. Không cần transaction hay khoá: chỉ đọc phiên và ghi lần sử dụng. Phiên bị thu hồi xen giữa
   * thì AT vừa cấp cũng không dùng được — mỗi request đều kiểm phiên (`SessionStore.isActive`).
   */
  async refresh(raw: string | undefined, ctx: RequestContext): Promise<{ accessToken: string }> {
    if (!raw) throw authError(ErrorCode.INVALID_TOKEN);
    const token = await this.prisma.refreshToken.findFirst({ where: { tokenHash: this.hash(raw) } });
    if (!token) throw authError(ErrorCode.INVALID_TOKEN);
    if (token.revokedAt) throw authError(ErrorCode.SESSION_REVOKED);
    if (token.expiresAt.getTime() <= Date.now()) throw authError(ErrorCode.TOKEN_EXPIRED);

    // Đọc không lọc trạng thái để biết vai trò khi từ chối; một câu truy vấn như trước.
    const found = await this.prisma.user.findFirst({ where: { id: token.userId }, include: { role: true } });
    const user = found && !found.isDeleted && found.status === UserStatus.ACTIVE ? found : null;
    if (!user) {
      await this.sessions.revoke(token.sid);
      if (found && isStaffRole(found.role.code)) {
        // Lỗi ghi audit không được đổi SESSION_REVOKED thành 500.
        await this.security
          .record([
            {
              type: 'AUTH.REFRESH_DENIED_INACTIVE',
              actorId: found.id,
              actorRoleCode: found.role.code,
              sessionId: token.sid,
              context: ctx,
            },
          ])
          .catch((error: unknown) =>
            this.logger.error(
              'Không ghi được AUTH.REFRESH_DENIED_INACTIVE',
              error instanceof Error ? error.stack : String(error),
            ),
          );
      }
      throw authError(ErrorCode.SESSION_REVOKED);
    }
    // RT cố định cho cả phiên: chỉ cấp AT mới và cập nhật lần sử dụng.
    // Không tạo bản ghi, không đổi hash, sid hoặc mốc hết hạn của RT.
    const accessToken = await this.jwt.signAsync({
      sub: user.id,
      role: user.role.code,
      sid: token.sid,
      jti: randomUUID(),
    });
    await this.prisma.refreshToken.updateMany({ where: { id: token.id }, data: { lastUsedAt: new Date() } });
    return { accessToken };
  }

  async logout(sid: string, raw: string | undefined) {
    if (raw) {
      // Chỉ ghi nhận lần sử dụng khi token khớp. Cookie cũ hoặc thuộc phiên khác không được
      // thu hồi phiên khác hay ngăn đăng xuất sid đã được xác thực.
      await this.prisma.refreshToken.updateMany({
        where: { sid, tokenHash: this.hash(raw) },
        data: { lastUsedAt: new Date() },
      });
    }
    await this.sessions.revoke(sid);
  }

  /** Xoá phiên đã hết hạn hoặc đã thu hồi quá 30 ngày — không đụng phiên còn sống nên không cần khoá. */
  @Cron('0 0 3 * * *')
  async cleanup() {
    const now = new Date();
    const cutoff = new Date(now.getTime() - 30 * 86400000);
    await this.prisma.refreshToken.deleteMany({
      where: { OR: [{ expiresAt: { lt: now } }, { revokedAt: { lt: cutoff } }] },
    });
  }
}
