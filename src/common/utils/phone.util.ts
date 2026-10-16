/**
 * SĐT là định danh khách hàng (cột UNIQUE) nên phải về MỘT dạng trước khi lưu hay tra: `0901 234 567`,
 * `+84901234567` và `84-901-234-567` là cùng một người. Dạng chuẩn: số trong nước bắt đầu bằng `0` — di động 10 số,
 * cố định 11 số.
 */
export const VIETNAM_PHONE_PATTERN = /^0\d{9,10}$/;

const SEPARATORS = /[\s.\-()]/g;

/**
 * Đưa về dạng chuẩn. Không nhận ra được thì trả chuỗi đã bỏ dấu phân cách để `VIETNAM_PHONE_PATTERN` báo lỗi — không
 * đoán bừa.
 */
export function normalizeVietnamPhone(value: string): string {
  const digits = value.trim().replace(SEPARATORS, '');
  if (digits.startsWith('+84')) return `0${digits.slice(3)}`;
  // Số trong nước luôn bắt đầu bằng 0, nên `84` đứng đầu với đúng độ dài (9–10 số sau mã) là mã quốc gia thiếu `+`.
  if (digits.startsWith('84') && (digits.length === 11 || digits.length === 12)) return `0${digits.slice(2)}`;
  return digits;
}

/**
 * Từ khoá tìm kiếm trông như SĐT (chỉ có số, `+` và dấu phân cách) thì chuẩn hoá để `+84 901` tìm ra `0901…`. Từ khoá
 * khác (tên, email) giữ nguyên — không được bỏ khoảng trắng trong tên.
 */
export function normalizePhoneSearch(search: string): string {
  return /^[+\d\s.\-()]+$/.test(search) ? normalizeVietnamPhone(search) : search;
}
