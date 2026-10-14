/**
 * Chuẩn hoá mã/số lô trước khi kiểm (`@Transform` chạy trước class-validator): bỏ khoảng trắng hai đầu, viết hoa —
 * `ncc001 ` và `NCC001` là một. Giá trị không phải chuỗi để nguyên cho validator báo lỗi kiểu.
 */
export const trimUpperCase = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;
