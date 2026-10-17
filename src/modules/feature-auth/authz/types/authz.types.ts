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
  /**
   * Cấp bậc của vai trò (`roles.level`: SUPER_ADMIN 100 · ADMIN 80 · PHARMACY_MANAGER 60 · SALES_STAFF 40 ·
   * CUSTOMER 20), đọc từ DB mỗi request. Dùng để chặn thao tác lên người/vai trò cùng cấp hoặc cao hơn.
   */
  roleLevel: number;
}
