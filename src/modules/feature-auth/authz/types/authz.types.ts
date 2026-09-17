import { AuthRole } from 'src/common/types/common.enum';

export interface AuthJwtPayload {
  sub: string; // userId
  email: string;
  role: AuthRole;
  permissionId?: string;
}

export interface JwtUser {
  userId: string;
  email: string;
  role: AuthRole;
  permissionId?: string;
}
