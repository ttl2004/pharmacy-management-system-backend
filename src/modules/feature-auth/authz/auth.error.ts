import { UnauthorizedException } from '@nestjs/common';
import { ErrorCode } from 'src/common/types/error-code';

export type AuthErrorCode =
  | ErrorCode.LOGIN_INVALID
  | ErrorCode.INVALID_TOKEN
  | ErrorCode.TOKEN_EXPIRED
  | ErrorCode.TOKEN_REUSED
  | ErrorCode.SESSION_REVOKED;

const authMessages: Record<AuthErrorCode, string> = {
  [ErrorCode.LOGIN_INVALID]: 'Thông tin đăng nhập không chính xác',
  [ErrorCode.INVALID_TOKEN]: 'Token không hợp lệ hoặc không được cung cấp',
  [ErrorCode.TOKEN_EXPIRED]: 'Token đã hết hạn',
  [ErrorCode.TOKEN_REUSED]: 'Refresh token đã bị dùng lại; phiên đăng nhập đã bị thu hồi',
  [ErrorCode.SESSION_REVOKED]: 'Phiên đăng nhập đã bị thu hồi',
};

export function authError(code: AuthErrorCode) {
  return new UnauthorizedException({ code, message: authMessages[code] });
}
