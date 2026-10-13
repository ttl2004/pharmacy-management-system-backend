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
  /**
   * Chi nhánh của người gọi, đọc từ bảng `users` ở mỗi request (không lấy từ token) — đổi chi nhánh có hiệu
   * lực ngay request kế tiếp. `null` với SUPER_ADMIN, ADMIN, CUSTOMER.
   */
  branchId: string | null;
}
