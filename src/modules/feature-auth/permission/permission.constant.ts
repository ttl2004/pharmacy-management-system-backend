/**
 * Danh mục quyền của hệ thống — nguồn chân lý duy nhất.
 *
 * Thêm nghiệp vụ mới thì thêm dòng vào đây rồi chạy `npm run seed:permissions`.
 * Không có API tạo quyền vì một quyền không gắn endpoint nào là quyền chết.
 */
export const PERMISSION_CATALOG = [
  { code: 'branch:read', name: 'Xem chi nhánh', module: 'branch', sortOrder: 1 },
  { code: 'branch:create', name: 'Tạo chi nhánh', module: 'branch', sortOrder: 2 },
  { code: 'branch:update', name: 'Sửa chi nhánh', module: 'branch', sortOrder: 3 },
  { code: 'branch:delete', name: 'Xoá chi nhánh', module: 'branch', sortOrder: 4 },
  { code: 'permission:read', name: 'Xem ma trận phân quyền', module: 'permission', sortOrder: 1 },
  { code: 'permission:update', name: 'Sửa ma trận phân quyền', module: 'permission', sortOrder: 2 },
  { code: 'user:role:update', name: 'Đổi vai trò người dùng', module: 'user', sortOrder: 1 },
  { code: 'user:read', name: 'Xem danh sách người dùng', module: 'user', sortOrder: 2 },
  { code: 'user:create', name: 'Tạo người dùng', module: 'user', sortOrder: 3 },
  { code: 'user:update', name: 'Sửa người dùng', module: 'user', sortOrder: 4 },
  { code: 'user:delete', name: 'Xoá người dùng', module: 'user', sortOrder: 5 },
  { code: 'category:read', name: 'Xem nhóm sản phẩm', module: 'category', sortOrder: 1 },
  { code: 'category:create', name: 'Tạo nhóm sản phẩm', module: 'category', sortOrder: 2 },
  { code: 'category:update', name: 'Sửa nhóm sản phẩm', module: 'category', sortOrder: 3 },
  { code: 'category:delete', name: 'Xoá nhóm sản phẩm', module: 'category', sortOrder: 4 },
  { code: 'manufacturer:read', name: 'Xem hãng sản xuất', module: 'manufacturer', sortOrder: 1 },
  { code: 'manufacturer:create', name: 'Tạo hãng sản xuất', module: 'manufacturer', sortOrder: 2 },
  { code: 'manufacturer:update', name: 'Sửa hãng sản xuất', module: 'manufacturer', sortOrder: 3 },
  { code: 'manufacturer:delete', name: 'Xoá hãng sản xuất', module: 'manufacturer', sortOrder: 4 },
  { code: 'unit:read', name: 'Xem đơn vị tính', module: 'unit', sortOrder: 1 },
  { code: 'unit:create', name: 'Tạo đơn vị tính', module: 'unit', sortOrder: 2 },
  { code: 'unit:update', name: 'Sửa đơn vị tính', module: 'unit', sortOrder: 3 },
  { code: 'unit:delete', name: 'Xoá đơn vị tính', module: 'unit', sortOrder: 4 },
  { code: 'product:read', name: 'Xem sản phẩm', module: 'product', sortOrder: 1 },
  { code: 'product:create', name: 'Tạo sản phẩm', module: 'product', sortOrder: 2 },
  { code: 'product:update', name: 'Sửa sản phẩm', module: 'product', sortOrder: 3 },
  { code: 'product:delete', name: 'Xoá sản phẩm', module: 'product', sortOrder: 4 },
] as const;

export type PermissionCode = (typeof PERMISSION_CATALOG)[number]['code'];

export const PERMISSION_CODES: readonly PermissionCode[] = PERMISSION_CATALOG.map((item) => item.code);
