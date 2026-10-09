/**
 * Tài khoản mẫu cho các vai trò nội bộ. KHÔNG có SUPER_ADMIN (đã có `seed:super-admin`)
 * và KHÔNG có CUSTOMER (chưa có luồng tạo khách hàng).
 *
 * `branchCode` theo luật 10 của spec: bắt buộc với vai trò nhân viên, phải null với ADMIN.
 * Seed đi thẳng qua Prisma nên không bị tầng service chặn — phải gán đúng bằng tay ở đây.
 */
export const SEED_USERS = [
  {
    username: 'admin',
    password: 'Admin@12345',
    roleCode: 'ADMIN',
    branchCode: null,
    fullName: 'Quản trị viên',
    phoneNumber: '0911111111',
    email: 'admin@pos-ndm.local',
    address: 'Hà Nội',
  },
  {
    username: 'quanly',
    password: 'QuanLy@12345',
    roleCode: 'PHARMACY_MANAGER',
    branchCode: 'CN001',
    fullName: 'Quản lý nhà thuốc',
    phoneNumber: '0922222222',
    email: 'quanly@pos-ndm.local',
    address: 'Hà Nội',
  },
  {
    username: 'nhanvien',
    password: 'NhanVien@12345',
    roleCode: 'SALES_STAFF',
    branchCode: 'CN002',
    fullName: 'Nhân viên bán hàng',
    phoneNumber: '0933333333',
    email: 'nhanvien@pos-ndm.local',
    address: 'Hà Nội',
  },
] as const;
