/**
 * Dữ liệu nền của nhà thuốc. Tách khỏi script để test đọc được mà không chạy bootstrap().
 * `code` là khoá upsert — đổi code là tạo bản ghi mới chứ không cập nhật bản ghi cũ.
 */
export const SEED_BRANCHES = [
  {
    code: 'CN001',
    name: 'Nhà thuốc Trung tâm',
    phone: '0243123456',
    address: '123 Phố Huế, Hai Bà Trưng, Hà Nội',
    openingHours: '07:00 - 22:00',
  },
  {
    code: 'CN002',
    name: 'Nhà thuốc Cầu Giấy',
    phone: '0243234567',
    address: '45 Xuân Thuỷ, Cầu Giấy, Hà Nội',
    openingHours: '07:00 - 22:00',
  },
  {
    code: 'CN003',
    name: 'Nhà thuốc Hà Đông',
    phone: '0243345678',
    address: '78 Quang Trung, Hà Đông, Hà Nội',
    openingHours: '07:30 - 21:30',
  },
] as const;
