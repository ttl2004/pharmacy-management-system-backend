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
 * SUPER_ADMIN không có mặt vì luôn bỏ qua mọi kiểm tra quyền. `permission:update` cố ý không cấp cho ai
 * (ADMIN chỉ xem được ma trận); muốn mở cho vai trò khác thì tự tick trên giao diện. `user:role:update` đã
 * cấp cho ADMIN và PHARMACY_MANAGER (đợt 1 tích hợp).
 *
 * Rào chống leo thang đặc quyền đã có: (1) cấp bậc `level` — `assertOutranks` ở `role-hierarchy.ts`; (2) chỉ
 * cấp được quyền mình đang có — `assertGrantable` cho ma trận quyền; (3) gán vai trò / tạo người dùng chỉ với
 * vai trò có tập quyền ⊆ quyền người gọi — `role-grant-guard.ts` (1509). SUPER_ADMIN bỏ qua (2) và (3).
 */
export const DEFAULT_ROLE_GRANTS: Partial<Record<RoleCode, readonly PermissionCode[]>> = {
  // Đợt 1 tích hợp: ADMIN được tạo người dùng và đổi vai trò (luật cấp bậc ở `role-hierarchy.ts` vẫn áp dụng).
  [AuthRole.ADMIN]: [
    'permission:read',
    'branch:read',
    'branch:create',
    'branch:update',
    'branch:delete',
    'user:read',
    'user:create',
    'user:update',
    'user:delete',
    'user:role:update',
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
    // Bán hàng — phạm vi chi nhánh do service ép (ma trận bán hàng 2026-10-16).
    'order:read',
    'order:create',
    'order:pay',
    'order:cancel',
    // Khai trước cho màn giao diện đã có (khách hàng, công nợ, giá, báo cáo, DQG).
    'customer:read',
    'customer:create',
    'customer:update',
    'customer:delete',
    'customer-debt:read',
    'supplier-debt:read',
    'supplier-debt:write',
    'price-book:update',
    'report:read',
    'dqg:read',
    'dqg:write',
    'dqg:connect',
  ],
  [AuthRole.PHARMACY_MANAGER]: [
    'branch:read',
    'permission:read',
    // Quản lý nhân viên chi nhánh mình — phạm vi do branch-scope.ts, cấp bậc do role-hierarchy.ts ép ở tầng service.
    'user:read',
    'user:create',
    'user:update',
    'user:delete',
    'user:role:update',
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
    // Bán hàng — phạm vi chi nhánh do service ép (ma trận bán hàng 2026-10-16).
    'order:read',
    'order:create',
    'order:pay',
    'order:cancel',
    // Kết nối tài khoản CSDL Dược là việc cấp chuỗi — chỉ ADMIN.
    'customer:read',
    'customer:create',
    'customer:update',
    'customer:delete',
    'customer-debt:read',
    'supplier-debt:read',
    'supplier-debt:write',
    'price-book:update',
    'report:read',
    'dqg:read',
    'dqg:write',
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
    // Bán hàng — phạm vi chi nhánh do service ép (ma trận bán hàng 2026-10-16).
    'order:read',
    'order:create',
    'order:pay',
    'order:cancel',
    // Tại quầy: tra cứu / thêm khách và xem công nợ, không xoá khách.
    'customer:read',
    'customer:create',
    'customer:update',
    'customer-debt:read',
  ],
};
