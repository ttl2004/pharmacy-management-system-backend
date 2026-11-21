import {
  accumulateProductBalance,
  buildBalanceSegments,
  type BalanceRow,
  type SegmentSums,
} from './movement-product-balance';

const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s));
const row = (id: string, s: number, quantity: number, productId = 'P1', branchId = 'B1'): BalanceRow => ({
  id,
  createdAt: at(s),
  branchId,
  productId,
  quantity,
});

describe('buildBalanceSegments', () => {
  it('mỗi dòng nhận cận trên là dòng liền trước CÙNG (chi nhánh, sản phẩm); dòng đầu không có cận trên', () => {
    const rows = [row('c', 30, -1), row('x', 25, 4, 'P2'), row('b', 20, 5), row('a', 10, 7)];
    const segments = buildBalanceSegments(rows);
    expect(segments.map((s) => [s.id, s.upperId])).toEqual([
      ['c', null],
      ['x', null],
      ['b', 'c'],
      ['a', 'b'],
    ]);
    expect(segments[3].upperCreatedAt).toEqual(at(20));
  });

  it('cùng sản phẩm nhưng khác chi nhánh là hai chuỗi riêng', () => {
    const segments = buildBalanceSegments([row('b2', 20, 1, 'P1', 'B2'), row('b1', 10, 1, 'P1', 'B1')]);
    expect(segments.map((s) => s.upperId)).toEqual([null, null]);
  });
});

describe('accumulateProductBalance', () => {
  it('dòng mới nhất = tồn hiện tại − đoạn của nó; dòng cũ hơn trừ thêm các đoạn mới hơn', () => {
    // Lịch sử sản phẩm: +7 (a), +5 (b), -1 (c), +2 (d, mới nhất) → tồn hiện tại 13.
    const rows = [row('d', 40, 2), row('c', 30, -1), row('b', 20, 5), row('a', 10, 7)];
    const sums = new Map<string, SegmentSums>([
      ['d', { onHand: 13, segment: 0 }],
      ['c', { onHand: 13, segment: 2 }], // (c, d] = +2
      ['b', { onHand: 13, segment: -1 }], // (b, c] = -1
      ['a', { onHand: 13, segment: 5 }], // (a, b] = +5
    ]);
    const balance = accumulateProductBalance(rows, sums);
    expect([...balance]).toEqual([
      ['d', 13],
      ['c', 11],
      ['b', 12],
      ['a', 7],
    ]);
  });

  it('trang lọc thưa (chỉ dòng a và c, bỏ b): đoạn của a gồm cả b nên vẫn đúng tồn thuốc', () => {
    const rows = [row('c', 30, -1), row('a', 10, 7)];
    const sums = new Map<string, SegmentSums>([
      ['c', { onHand: 11, segment: 0 }],
      ['a', { onHand: 11, segment: 4 }], // (a, c] = +5 (b) + -1 (c)
    ]);
    expect([...accumulateProductBalance(rows, sums)]).toEqual([
      ['c', 11],
      ['a', 7],
    ]);
  });

  it('thiếu tổng đoạn → lỗi rõ ràng, không im lặng ra số sai', () => {
    expect(() => accumulateProductBalance([row('a', 1, 1)], new Map())).toThrow('Thiếu tổng đoạn');
  });
});
