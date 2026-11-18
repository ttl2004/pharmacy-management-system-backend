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

/** SĐT Việt Nam trong chuỗi tự do: `0` + 9 số hoặc `84` + 9 số, không dính liền chữ số khác. */
const PHONE_IN_TEXT = /(?<!\d)(?:84|0)\d{9}(?!\d)/g;

/**
 * Che mọi SĐT xuất hiện trong một chuỗi (URL, thông điệp log), giữ 3 số cuối: `?search=0901234567` →
 * `?search=*******567`. Dùng cho log — URL tìm đơn/khách theo SĐT không được ghi nguyên số ra file log.
 */
export function maskPhonesInText(text: string): string {
  return text.replace(PHONE_IN_TEXT, (phone) => '*'.repeat(phone.length - 3) + phone.slice(-3));
}
