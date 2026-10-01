import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { ErrorCode } from 'src/common/types/error-code';
import { authError } from '../auth.error';

@Injectable()
export class AuthzGuard extends AuthGuard(AUTH_JWT) {
  handleRequest<TUser>(err: unknown, user: TUser | false | null, info: { name?: string } | undefined): TUser {
    if (err instanceof Error) throw err;
    if (err) throw authError(ErrorCode.INVALID_TOKEN);
    if (!user) {
      throw authError(info?.name === 'TokenExpiredError' ? ErrorCode.TOKEN_EXPIRED : ErrorCode.INVALID_TOKEN);
    }
    return user;
  }
}
