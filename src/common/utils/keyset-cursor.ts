import { ErrorException } from 'src/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';

/**
 * Con trỏ phân trang theo khoá (`createdAt`, `id`) cho bảng chỉ tăng (sổ kho, nhật ký). `OFFSET` càng về sau càng
 * chậm và lệch trang khi có dòng mới chen vào; con trỏ thì mỗi trang tốn như nhau và không trùng/sót dòng.
 * Client coi chuỗi này là hộp đen — chỉ gửi lại nguyên văn `nextCursor`.
 */
export interface KeysetCursor {
  createdAt: Date;
  id: string;
}

export function encodeCursor(cursor: KeysetCursor): string {
  return Buffer.from(`${cursor.createdAt.toISOString()}|${cursor.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): KeysetCursor {
  const [iso, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  const createdAt = new Date(iso ?? '');
  if (!id || Number.isNaN(createdAt.getTime())) {
    throw new ErrorException({ code: ErrorCode.HTTP_BAD_REQUEST, message: 'cursor không hợp lệ' });
  }
  return { createdAt, id };
}

/** Điều kiện "đứng sau con trỏ" theo thứ tự giảm dần (`createdAt` DESC, `id` DESC). */
export function afterCursorDesc(cursor: KeysetCursor) {
  return {
    OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }],
  };
}

/** Lấy `limit + 1` dòng để biết còn trang sau không, rồi cắt về `limit`. */
export function toKeysetPage<T extends { createdAt: Date; id: string }>(rows: T[], limit: number) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? encodeCursor(last) : null };
}
