/**
 * Từ khoá tìm kiếm cho `LIKE`/`ILIKE` phải là văn bản thuần: không escape thì khách gõ `%` khớp mọi bản ghi, gõ `_`
 * khớp mọi ký tự. Prisma `contains` KHÔNG tự escape (đã thử trên PostgreSQL), còn PostgreSQL mặc định dùng `\` làm
 * ký tự escape — nên escape sẵn bằng `\` là dùng được cho cả `contains` lẫn `ILIKE` thô.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** `%từ khoá%` đã escape, cho `ILIKE` viết tay. */
export function containsPattern(value: string): string {
  return `%${escapeLike(value)}%`;
}
