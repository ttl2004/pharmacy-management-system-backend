import { BadRequestException, Injectable } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from 'src/common/databases/prisma.service';
import { SessionStore, SessionTransactions } from './session.store';
import { ErrorCode } from 'src/common/types/error-code';
import { authError } from './auth.error';
import { JwtUser } from './types/authz.types';
import { ChangePasswordRequest } from './dtos/password.request';

@Injectable()
export class PasswordService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transactions: SessionTransactions,
    private readonly sessions: SessionStore,
  ) {}

  async change(user: JwtUser, dto: ChangePasswordRequest) {
    const credentials = await this.prisma.auth.findFirst({ where: { userId: user.userId, isDeleted: false } });
    if (!credentials || !(await bcrypt.compare(dto.currentPassword, credentials.password)))
      throw authError(ErrorCode.LOGIN_INVALID);
    const hash = await this.hash(dto.newPassword);
    await this.transactions.write(async (tx) => {
      const active = await tx.refreshToken.findFirst({
        where: { sid: user.sid, userId: user.userId, revokedAt: null, expiresAt: { gt: new Date() } },
      });
      if (!active) throw authError(ErrorCode.SESSION_REVOKED);
      const updated = await tx.auth.updateMany({
        where: { id: credentials.id, password: credentials.password },
        data: { password: hash, lastChangedPasswordAt: new Date(), updatedAt: new Date() },
      });
      if (updated.count !== 1) throw authError(ErrorCode.LOGIN_INVALID);
      await tx.refreshToken.updateMany({
        where: { userId: user.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
    await this.sessions.revokeAllByUser(user.userId);
  }

  // Chỉ dùng nội bộ. Luồng khôi phục sau này phải xác minh bằng chứng khôi phục dùng một lần
  // (hoặc quyền của quản trị viên) TRƯỚC khi gọi phương thức này.
  // Không mở trực tiếp phương thức này thành endpoint HTTP không yêu cầu xác thực.
  async resetPassword(userId: string, newPassword: string) {
    const hash = await this.hash(newPassword);
    await this.transactions.write(async (tx) => {
      const updated = await tx.auth.updateMany({
        where: { userId, isDeleted: false },
        data: { password: hash, lastChangedPasswordAt: new Date(), updatedAt: new Date() },
      });
      if (!updated.count) throw authError(ErrorCode.LOGIN_INVALID);
      await tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    });
    await this.sessions.revokeAllByUser(userId);
  }

  private async hash(password: string) {
    // bcrypt cắt dữ liệu đầu vào vượt quá 72 byte, kể cả ký tự được mã hóa bằng nhiều byte.
    if (password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) {
      throw new BadRequestException('Mật khẩu phải có ít nhất 8 ký tự và tối đa 72 byte UTF-8');
    }
    return bcrypt.hash(password, 10);
  }
}
