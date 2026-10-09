import { AuthRole } from 'src/common/types/common.enum';

export interface AuthJwtPayload {
  sub: string; // Mã người dùng
  role: AuthRole; // Chỉ để đọc khi debug — nguồn thật là bảng users
  sid: string;
  jti: string;
  iat: number;
  exp: number;
}

export interface JwtUser {
  userId: string;
  sid: string;
  /** Nullable: khách mua tại quầy không có email. */
  email: string | null;
  role: AuthRole;
}
