import { ErrorCode } from '../types/error-code';
import { afterCursorDesc, decodeCursor, encodeCursor, toKeysetPage } from './keyset-cursor';

describe('keyset cursor', () => {
  const cursor = { createdAt: new Date('2026-10-14T03:04:05.678Z'), id: 'abc-123' };

  it('mã hoá rồi giải mã giữ nguyên giá trị', () => {
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('cursor rác → 1002, không phải 500', () => {
    let caught: unknown;
    try {
      decodeCursor('khong-phai-cursor');
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ errorCode: ErrorCode.HTTP_BAD_REQUEST });
  });

  it('điều kiện "sau con trỏ" xử lý cả hai dòng trùng createdAt', () => {
    expect(afterCursorDesc(cursor)).toEqual({
      OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: 'abc-123' } }],
    });
  });

  it('lấy limit + 1 dòng: còn trang thì trả nextCursor của dòng cuối trang', () => {
    const rows = [1, 2, 3].map((n) => ({ id: `r${n}`, createdAt: new Date(2026, 0, n) }));
    const page = toKeysetPage(rows, 2);
    expect(page.items.map((row) => row.id)).toEqual(['r1', 'r2']);
    expect(decodeCursor(page.nextCursor!).id).toBe('r2');
    expect(toKeysetPage(rows.slice(0, 2), 2).nextCursor).toBeNull();
  });
});
