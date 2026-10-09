import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { AuthRole, RecordStatusEnum } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';
import { UserRepository } from '../../user/repositories/user.repository';
import { AuthJwtPayload, JwtUser } from '../types/authz.types';
import { AuthConfig } from '../auth.config';
import { SessionStore } from '../session.store';
import { authError } from '../auth.error';

@Injectable()
export class AuthzStrategy extends PassportStrategy(Strategy, AUTH_JWT) {
  constructor(
    config: AuthConfig,
    private readonly users: UserRepository,
    private readonly sessions: SessionStore,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.secret,
      algorithms: ['HS256'],
    });
  }
  async validate(payload: AuthJwtPayload): Promise<JwtUser> {
    if (
      typeof payload.sub !== 'string' ||
      !payload.sub ||
      typeof payload.sid !== 'string' ||
      !payload.sid ||
      typeof payload.jti !== 'string' ||
      !Number.isFinite(payload.iat) ||
      !Number.isFinite(payload.exp)
    ) {
      throw authError(ErrorCode.INVALID_TOKEN);
    }
    if (!(await this.sessions.isActive(payload.sid))) throw authError(ErrorCode.SESSION_REVOKED);
    const user = await this.users.findByIdWithRole(payload.sub);
    if (!user || user.status !== RecordStatusEnum.ACTIVE) throw authError(ErrorCode.SESSION_REVOKED);
    return {
      userId: user.id,
      sid: payload.sid,
      email: user.email,
      // Đọc vai trò từ DB chứ không tin token: đổi vai trò có hiệu lực ngay ở request kế tiếp,
      // không phải chờ access token hết hạn và không cần thu hồi phiên.
      role: user.role.code as AuthRole,
    };
  }
}
