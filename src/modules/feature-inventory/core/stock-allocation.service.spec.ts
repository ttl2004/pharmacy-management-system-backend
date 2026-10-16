import { BatchStatus } from '@prisma/client';
import { ErrorCode } from 'src/common/types/error-code';
import type { InventoryTxContext } from './inventory-transactions';
import { pickFefo, StockAllocationService } from './stock-allocation.service';
import type { LockedBatch } from './stock-ledger.repository';

function batch(id: string, expiry: string, quantityOnHand: number, overrides: Partial<LockedBatch> = {}): LockedBatch {
  return {
    id,
    branchId: 'branch-1',
    productId: 'P-1',
    batchNumber: `LO-${id}`,
    expiryDate: new Date(`${expiry}T00:00:00.000Z`),
    quantityOnHand,
    reservedQuantity: 0,
    importPrice: 1000,
    status: BatchStatus.AVAILABLE,
    ...overrides,
  };
}

describe('pickFefo', () => {
  it('lấy lô hết hạn trước, tách một dòng ra nhiều lô, giá vốn theo từng lô', () => {
    const batches = [
      batch('xa', '2028-01-01', 50, { importPrice: 900 }),
      batch('gan', '2027-01-01', 3, { importPrice: 1100 }),
    ];

    expect(pickFefo(batches, [{ productId: 'P-1', quantity: 5 }])).toEqual([
      { lineIndex: 0, productId: 'P-1', batchId: 'gan', quantity: 3, unitCost: 1100 },
      { lineIndex: 0, productId: 'P-1', batchId: 'xa', quantity: 2, unitCost: 900 },
    ]);
  });

  it('không lấy vào phần đang giữ cho đơn khác', () => {
    const batches = [batch('gan', '2027-01-01', 10, { reservedQuantity: 8 }), batch('xa', '2028-01-01', 10)];

    const picked = pickFefo(batches, [{ productId: 'P-1', quantity: 4 }]);

    expect(picked.map((item) => [item.batchId, item.quantity])).toEqual([
      ['gan', 2],
      ['xa', 2],
    ]);
  });

  it('hai dòng cùng sản phẩm dùng chung lượng còn lại; mỗi sản phẩm chỉ lấy lô của nó', () => {
    const batches = [batch('a', '2027-01-01', 5), batch('b', '2027-01-01', 5, { productId: 'P-2' })];

    const picked = pickFefo(batches, [
      { productId: 'P-1', quantity: 3 },
      { productId: 'P-2', quantity: 5 },
      { productId: 'P-1', quantity: 2 },
    ]);

    expect(picked.map((item) => [item.lineIndex, item.batchId, item.quantity])).toEqual([
      [0, 'a', 3],
      [1, 'b', 5],
      [2, 'a', 2],
    ]);
  });

  it('thiếu hàng: báo 1700 nêu dòng và lượng thiếu', () => {
    const pick = () => pickFefo([batch('a', '2027-01-01', 2)], [{ productId: 'P-1', quantity: 5 }]);

    expect(pick).toThrow('dòng 1 thiếu 3');
    expect(pick).toThrow(expect.objectContaining({ errorCode: ErrorCode.INSUFFICIENT_STOCK }) as Error);
  });

  it('cùng hạn dùng: thứ tự theo id, kết quả ổn định', () => {
    const picked = pickFefo(
      [batch('b', '2027-01-01', 1), batch('a', '2027-01-01', 1)],
      [{ productId: 'P-1', quantity: 1 }],
    );

    expect(picked[0].batchId).toBe('a');
  });

  it.each([0, -1, 1.5])('số lượng %p là lỗi lập trình', (quantity) => {
    expect(() => pickFefo([batch('a', '2027-01-01', 5)], [{ productId: 'P-1', quantity }])).toThrow('số nguyên dương');
  });
});

describe('StockAllocationService.allocateFefo', () => {
  it('khoá lô bán được của các sản phẩm (không trùng) một lần, trả kèm lô đã khoá', async () => {
    const locked = [batch('a', '2027-01-01', 5)];
    const repository = { lockSellable: jest.fn().mockResolvedValue(locked) };
    const service = new StockAllocationService(repository as never);
    const ctx = { tx: {} } as InventoryTxContext;

    const result = await service.allocateFefo(
      ctx,
      'branch-1',
      [
        { productId: 'P-1', quantity: 2 },
        { productId: 'P-1', quantity: 1 },
      ],
      '2026-10-16',
    );

    expect(repository.lockSellable).toHaveBeenCalledWith(ctx.tx, 'branch-1', ['P-1'], '2026-10-16');
    expect(result.locked).toBe(locked);
    expect(result.allocations).toHaveLength(2);
  });

  it('không có dòng thì không chạm DB', async () => {
    const repository = { lockSellable: jest.fn() };
    const service = new StockAllocationService(repository as never);

    const result = await service.allocateFefo({} as never, 'branch-1', []);

    expect(result).toEqual({ allocations: [], locked: [] });
    expect(repository.lockSellable).not.toHaveBeenCalled();
  });
});
