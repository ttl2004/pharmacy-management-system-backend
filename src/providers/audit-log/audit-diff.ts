import type { AuditJson } from './audit-log.types';

/** `Date` → ISO, `bigint` → chuỗi số, `undefined` → `null`: dạng ghi được vào `jsonb` mà không mất thông tin. */
export function toAuditJson(value: unknown): AuditJson {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item) => toAuditJson(item));
  if (typeof value === 'object') {
    const result: Record<string, AuditJson> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) result[key] = toAuditJson(item);
    return result;
  }
  // Hàm, symbol: không phải dữ liệu nghiệp vụ, không có dạng JSON có nghĩa.
  return null;
}

/**
 * Chỉ giữ các trường **thực sự đổi** trong `fields` — nhật ký không chụp nguyên bản ghi, đỡ phình bảng và người đọc
 * thấy ngay cái gì đổi. Trả `null` khi không có trường nào đổi (caller bỏ qua, không ghi dòng rỗng).
 */
export function diffFields<T extends object>(
  before: T,
  after: Partial<T>,
  fields: readonly (keyof T & string)[],
): { before: Record<string, AuditJson>; after: Record<string, AuditJson> } | null {
  const changedBefore: Record<string, AuditJson> = {};
  const changedAfter: Record<string, AuditJson> = {};

  for (const field of fields) {
    if (!(field in after)) continue;
    const oldValue = toAuditJson(before[field]);
    const newValue = toAuditJson(after[field]);
    if (JSON.stringify(oldValue) === JSON.stringify(newValue)) continue;
    changedBefore[field] = oldValue;
    changedAfter[field] = newValue;
  }

  return Object.keys(changedAfter).length ? { before: changedBefore, after: changedAfter } : null;
}

/** Ảnh chụp một tập trường — dùng cho CREATE (`after`) và DELETE (`before`). */
export function pickAuditFields<T extends object>(
  row: T,
  fields: readonly (keyof T & string)[],
): Record<string, AuditJson> {
  const result: Record<string, AuditJson> = {};
  for (const field of fields) result[field] = toAuditJson(row[field]);
  return result;
}
