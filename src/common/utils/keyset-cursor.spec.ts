import { ErrorCode } from '../types/error-code';
import { afterCursorDesc, decodeCursor, encodeCursor, toKeysetPage } from './keyset-cursor';

describe('keyset cursor', () => {
  const cursor = { createdAt: new Date('2026-10-14T03:04:05.678Z'), id: '9b2f6c1e-4a7d-4f3b-8c2e-1d5a6b7c8d9e' };

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

  it('cursor tự chế: ngày hợp lệ nhưng id không phải UUID → 1002, không để lọt xuống DB thành 500', () => {
    const forged = Buffer.from('2026-10-14T00:00:00.000Z|abc', 'utf8').toString('base64url');
    let caught: unknown;
    try {
      decodeCursor(forged);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ errorCode: ErrorCode.HTTP_BAD_REQUEST });
  });

  it('điều kiện "sau con trỏ" xử lý cả hai dòng trùng createdAt', () => {
    expect(afterCursorDesc(cursor)).toEqual({
      OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }],
    });
  });

  it('lấy limit + 1 dòng: còn trang thì trả nextCursor của dòng cuối trang', () => {
    const uuid = (n: number) => `0000000${n}-0000-4000-8000-000000000000`;
    const rows = [1, 2, 3].map((n) => ({ id: uuid(n), createdAt: new Date(2026, 0, n) }));
    const page = toKeysetPage(rows, 2);
    expect(page.items.map((row) => row.id)).toEqual([uuid(1), uuid(2)]);
    expect(decodeCursor(page.nextCursor!).id).toBe(uuid(2));
    expect(toKeysetPage(rows.slice(0, 2), 2).nextCursor).toBeNull();
  });
});
