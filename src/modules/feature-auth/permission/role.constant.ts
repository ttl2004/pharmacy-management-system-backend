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
 * Quyền mặc định của từng vai trò. Seed cấp theo từng cặp (vai trò, quyền) chưa từng có bản ghi: thêm mã vào
 * đây rồi chạy lại `npm run seed:permissions` là vai trò đã có ma trận cũng nhận được; quyền đã bị thu hồi trên
 * giao diện thì không bị cấp lại.
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
  // `user:create` cố ý KHÔNG có mặt: tài khoản các vai trò nội bộ chỉ super admin tạo.
  // Xem spec mục 4.5 — cùng nhóm với `permission:update` và `user:role:update`.
  [AuthRole.ADMIN]: [
    'permission:read',
    'branch:read',
    'branch:create',
    'branch:update',
    'branch:delete',
    'user:read',
    'user:update',
    'user:delete',
    'category:read',
    'category:create',
    'category:update',
    'category:delete',
    'manufacturer:read',
    'manufacturer:create',
    'manufacturer:update',
    'manufacturer:delete',
    'unit:read',
    'unit:create',
    'unit:update',
    'unit:delete',
    'product:read',
    'product:create',
    'product:update',
    'product:delete',
    'supplier:read',
    'supplier:create',
    'supplier:update',
    'supplier:delete',
    'goods-receipt:read',
    'goods-receipt:create',
    'goods-receipt:confirm',
    'goods-receipt:cancel',
    'stock:read',
    'branch-product:read',
    'branch-product:update',
    'audit-log:read',
    'transfer:read',
    'transfer:create',
    'transfer:ship',
    'transfer:receive',
    'transfer:cancel',
    'stock-adjustment:read',
    'stock-adjustment:create',
    'stock-adjustment:confirm',
    'stock-adjustment:cancel',
    'stock-batch:block',
  ],
  [AuthRole.PHARMACY_MANAGER]: [
    'branch:read',
    // Chỉ thấy người dùng thuộc chi nhánh mình — phạm vi do branch-scope.ts ép ở tầng service.
    'user:read',
    'category:read',
    'manufacturer:read',
    'unit:read',
    'product:read',
    // Kho: mọi thao tác ghi đều gói trong chi nhánh mình — phạm vi do service ép (ma trận kho duyệt 2026-10-14).
    'supplier:read',
    'goods-receipt:read',
    'goods-receipt:create',
    'goods-receipt:confirm',
    'goods-receipt:cancel',
    'stock:read',
    'branch-product:read',
    'branch-product:update',
    'audit-log:read',
    'transfer:read',
    'transfer:create',
    'transfer:ship',
    'transfer:receive',
    'transfer:cancel',
    'stock-adjustment:read',
    'stock-adjustment:create',
    'stock-adjustment:confirm',
    'stock-adjustment:cancel',
    'stock-batch:block',
  ],
  // Dược sĩ chỉ ĐỌC dữ liệu kho của chi nhánh mình; mọi thao tác ghi kho là của PM hoặc ADMIN (K9, K10).
  [AuthRole.SALES_STAFF]: [
    'branch:read',
    'category:read',
    'manufacturer:read',
    'unit:read',
    'product:read',
    'supplier:read',
    'goods-receipt:read',
    'stock:read',
    'branch-product:read',
    'transfer:read',
    'stock-adjustment:read',
  ],
};
