/** Che SĐT còn 4 số cuối: `0912345678` → `******5678`. Chuỗi ≤ 4 ký tự che hết. */
export function maskPhone(phone: string | null | undefined): string | null {
  if (phone == null) return null;
  if (phone.length <= 4) return '*'.repeat(phone.length);
  return '*'.repeat(phone.length - 4) + phone.slice(-4);
}

/** Che email còn ký tự đầu và tên miền: `an.nguyen@x.vn` → `a***@x.vn`. Không có `@` thì che hết. */
export function maskEmail(email: string | null | undefined): string | null {
  if (email == null) return null;
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  return `${email[0]}***${email.slice(at)}`;
}
