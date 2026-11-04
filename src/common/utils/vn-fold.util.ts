/**
 * Bỏ dấu tiếng Việt để tìm kiếm: NFD, bỏ dấu kết hợp (U+0300–U+036F), đ/Đ → d, chữ thường,
 * gộp khoảng trắng, trim. Hàm SQL `vn_fold` (migration nhat_ky_v21) phải cho kết quả y hệt.
 */
export function foldVn(input: string | null | undefined): string {
  if (input == null) return '';
  return input.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase().replace(/\s+/g, ' ').trim();
}
