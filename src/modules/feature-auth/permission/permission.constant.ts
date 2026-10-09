/**
 * Danh mục quyền của hệ thống — nguồn chân lý duy nhất.
 *
 * Thêm nghiệp vụ mới thì thêm dòng vào đây rồi chạy `npm run seed:permissions`.
 * Không có API tạo quyền vì một quyền không gắn endpoint nào là quyền chết.
 */
export const PERMISSION_CATALOG = [
  { code: 'permission:read', name: 'Xem ma trận phân quyền', module: 'permission', sortOrder: 1 },
  { code: 'permission:update', name: 'Sửa ma trận phân quyền', module: 'permission', sortOrder: 2 },
  { code: 'user:role:update', name: 'Đổi vai trò người dùng', module: 'user', sortOrder: 1 },
  { code: 'user:read', name: 'Xem danh sách người dùng', module: 'user', sortOrder: 2 },
  { code: 'user:create', name: 'Tạo người dùng', module: 'user', sortOrder: 3 },
  { code: 'user:update', name: 'Sửa người dùng', module: 'user', sortOrder: 4 },
  { code: 'user:delete', name: 'Xoá người dùng', module: 'user', sortOrder: 5 },
] as const;

export type PermissionCode = (typeof PERMISSION_CATALOG)[number]['code'];

export const PERMISSION_CODES: readonly PermissionCode[] = PERMISSION_CATALOG.map((item) => item.code);
