import { AuthRole } from 'src/common/types/common.enum';

export interface AuthJwtPayload {
  sub: string; // Mã người dùng
  role: AuthRole;
  sid: string;
  jti: string;
  iat: number;
  exp: number;
}

export interface JwtUser {
  userId: string;
  sid: string;
  email: string;
  role: AuthRole;
  permissionId?: string;
}
