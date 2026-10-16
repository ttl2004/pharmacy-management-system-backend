import { normalizeVietnamPhone } from './phone.util';

/**
 * Chuẩn hoá mã/số lô trước khi kiểm (`@Transform` chạy trước class-validator): bỏ khoảng trắng hai đầu, viết hoa —
 * `ncc001 ` và `NCC001` là một. Giá trị không phải chuỗi để nguyên cho validator báo lỗi kiểu.
 */
export const trimUpperCase = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

/** Email so khớp không phân biệt hoa/thường (cột UNIQUE): `An@Mail.com ` và `an@mail.com` là một. */
export const trimLowerCase = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

/** SĐT về dạng chuẩn trong nước — xem `normalizeVietnamPhone`. */
export const toVietnamPhone = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? normalizeVietnamPhone(value) : value;
