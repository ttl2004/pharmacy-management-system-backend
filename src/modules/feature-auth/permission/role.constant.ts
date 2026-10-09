import { AuthRole } from 'src/common/types/common.enum';
import type { PermissionCode } from './permission.constant';

/** Năm vai trò hệ thống. `level` dùng để sắp thứ tự hiển thị và so cấp bậc. */
export const ROLE_CATALOG = [
  {
    code: AuthRole.SUPER_ADMIN,
    name: 'Quản trị toàn hệ thống',
    description: 'Toàn quyền trên hệ thống',
    level: 100,
  },
  {
    code: AuthRole.ADMIN,
    name: 'Quản trị viên',
    description: 'Quản trị trong phạm vi được phân quyền',
    level: 80,
  },
  {
    code: AuthRole.PHARMACY_MANAGER,
    name: 'Quản lý nhà thuốc',
    description: 'Quản lý một chi nhánh nhà thuốc',
    level: 60,
  },
  {
    code: AuthRole.SALES_STAFF,
    name: 'Nhân viên bán hàng',
    description: 'Nhân viên bán hàng / dược sĩ',
    level: 40,
  },
  { code: AuthRole.CUSTOMER, name: 'Khách hàng', description: 'Khách hàng mua thuốc', level: 20 },
] as const;

export type RoleCode = (typeof ROLE_CATALOG)[number]['code'];

/**
 * Quyền cấp sẵn ở lần seed đầu tiên.
 *
 * SUPER_ADMIN không có mặt vì luôn bỏ qua mọi kiểm tra quyền. `permission:update` và
 * `user:role:update` cố ý không cấp cho ai: SUPER_ADMIN vẫn làm được nhờ luật bỏ qua, còn
 * ADMIN chỉ xem được ma trận. Muốn mở cho vai trò khác thì tự tick trên giao diện.
 *
 * CẢNH BÁO khi mở `permission:update` cho vai trò khác: dịch vụ chưa có rào chống leo thang
 * đặc quyền. Ai có `permission:update` thì cấp được `user:role:update` cho chính vai trò mình,
 * rồi dùng quyền đó gán vai trò SUPER_ADMIN cho một tài khoản khác và đăng nhập bằng tài khoản
 * đó. Muốn mở thì phải thêm rào so cấp bậc (`level`) trước — xem mục 7 của spec.
 */
export const DEFAULT_ROLE_GRANTS: Partial<Record<RoleCode, readonly PermissionCode[]>> = {
  [AuthRole.ADMIN]: ['permission:read'],
};
