import { BatchStatus, StockMovementType, StockRefType } from '@prisma/client';
import { ErrorCode } from 'src/common/types/error-code';
import { InventoryEvents, StockChangedEvent } from './inventory-events';
import type { AfterCommitHook, InventoryTxContext } from './inventory-transactions';
import type { LockedBatch, MovementRow } from './stock-ledger.repository';
import { LedgerEntry, StockLedgerService } from './stock-ledger.service';

const ACTOR = 'actor-1';

function batch(id: string, quantityOnHand: number, overrides: Partial<LockedBatch> = {}): LockedBatch {
  return {
    id,
    branchId: 'branch-1',
    productId: `product-of-${id}`,
    batchNumber: `LO-${id}`,
    expiryDate: new Date('2027-01-01T00:00:00.000Z'),
    quantityOnHand,
    reservedQuantity: 0,
    importPrice: 1000,
    status: BatchStatus.AVAILABLE,
    ...overrides,
  };
}

function entry(batchId: string, quantity: number, overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    batchId,
    type: quantity > 0 ? StockMovementType.IMPORT : StockMovementType.TRANSFER_OUT,
    quantity,
    unitCost: 1000,
    refType: StockRefType.GOODS_RECEIPT,
    refId: 'doc-1',
    ...overrides,
  };
}

/** Repository giả mô phỏng đúng điều kiện SQL: tồn mới >= phần đang giữ thì mới cập nhật. */
function makeLedger(stock: LockedBatch[]) {
  const byId = new Map(stock.map((item) => [item.id, { ...item }]));
  const inserted: MovementRow[] = [];
  const repository = {
    lockBatches: jest.fn((_tx: unknown, ids: string[]) =>
      Promise.resolve(ids.filter((id) => byId.has(id)).map((id) => ({ ...byId.get(id)! }))),
    ),
    applyDeltas: jest.fn((_tx: unknown, deltas: { batchId: string; delta: number }[]) =>
      Promise.resolve(
        deltas.flatMap(({ batchId, delta }) => {
          const row = byId.get(batchId)!;
          if (row.quantityOnHand + delta < row.reservedQuantity) return [];
          row.quantityOnHand += delta;
          return [{ id: batchId, quantityOnHand: row.quantityOnHand }];
        }),
      ),
    ),
    insertMovements: jest.fn((_tx: unknown, rows: MovementRow[]) => {
      inserted.push(...rows);
      return Promise.resolve();
    }),
  };
  const events = new InventoryEvents();
  const emitted: StockChangedEvent[] = [];
  events.onStockChanged((event) => {
    emitted.push(event);
  });

  const hooks: AfterCommitHook[] = [];
  const ctx: InventoryTxContext = { tx: {} as never, afterCommit: (hook) => hooks.push(hook) };
  const commit = async () => {
    for (const hook of hooks) await hook();
  };

  return { ledger: new StockLedgerService(repository as never, events), repository, inserted, emitted, ctx, commit };
}

describe('StockLedgerService.apply', () => {
  it('ghi tồn và sổ kho với balanceAfter đúng, 3 câu lệnh cho nhiều lô', async () => {
    const { ledger, repository, inserted, ctx } = makeLedger([batch('a', 10), batch('b', 0)]);

    const applied = await ledger.apply(ctx, [entry('a', -4), entry('b', 7)], ACTOR);

    expect(applied.map((item) => item.balanceAfter)).toEqual([6, 7]);
    expect(inserted).toHaveLength(2);
    expect(inserted[0]).toMatchObject({ batchId: 'a', quantity: -4, balanceAfter: 6, createdBy: ACTOR });
    expect(repository.lockBatches).toHaveBeenCalledTimes(1);
    expect(repository.applyDeltas).toHaveBeenCalledTimes(1);
    expect(repository.insertMovements).toHaveBeenCalledTimes(1);
  });

  it('một lô xuất hiện nhiều lần: số dư chạy theo thứ tự bút toán', async () => {
    const { ledger, repository, ctx } = makeLedger([batch('a', 10)]);

    const applied = await ledger.apply(ctx, [entry('a', -3), entry('a', -2), entry('a', 5)], ACTOR);

    expect(applied.map((item) => item.balanceAfter)).toEqual([7, 5, 10]);
    // Tổng delta = 0 → không cần UPDATE, nhưng vẫn ghi đủ 3 bút toán.
    expect(repository.applyDeltas).toHaveBeenCalledWith(expect.anything(), [], ACTOR);
  });

  it('lô thiếu hàng: báo 1700 kèm số lô, không ghi sổ dòng nào', async () => {
    const { ledger, inserted, ctx } = makeLedger([batch('a', 10), batch('b', 2)]);

    await expect(ledger.apply(ctx, [entry('a', -1), entry('b', -3)], ACTOR)).rejects.toMatchObject({
      errorCode: ErrorCode.INSUFFICIENT_STOCK,
      message: expect.stringContaining('LO-b') as string,
    });
    expect(inserted).toHaveLength(0);
  });

  it('không được xuất vào phần đang giữ cho đơn online', async () => {
    const { ledger, ctx } = makeLedger([batch('a', 10, { reservedQuantity: 8 })]);

    await expect(ledger.apply(ctx, [entry('a', -3)], ACTOR)).rejects.toMatchObject({
      errorCode: ErrorCode.INSUFFICIENT_STOCK,
    });
  });

  it('chi nhánh và sản phẩm của bút toán lấy từ lô, không từ caller', async () => {
    const { ledger, inserted, ctx } = makeLedger([batch('a', 0, { branchId: 'CN-A', productId: 'P-1' })]);

    await ledger.apply(ctx, [entry('a', 5)], ACTOR);

    expect(inserted[0]).toMatchObject({ branchId: 'CN-A', productId: 'P-1' });
  });

  it.each([0, 1.5])('từ chối bút toán số lượng %p (lỗi lập trình, không phải lỗi người dùng)', async (quantity) => {
    const { ledger, ctx } = makeLedger([batch('a', 10)]);
    await expect(ledger.apply(ctx, [entry('a', quantity)], ACTOR)).rejects.toThrow('số nguyên khác 0');
  });

  it('lô không tồn tại là lỗi lập trình', async () => {
    const { ledger, ctx } = makeLedger([]);
    await expect(ledger.apply(ctx, [entry('ghost', 1)], ACTOR)).rejects.toThrow('Lô không tồn tại');
  });

  it('preLocked: không khoá lại lô caller đã khoá', async () => {
    const stock = [batch('a', 10)];
    const { ledger, repository, ctx } = makeLedger(stock);

    await ledger.apply(ctx, [entry('a', -1)], ACTOR, { preLocked: stock });

    expect(repository.lockBatches).not.toHaveBeenCalled();
  });

  it('chỉ phát sự kiện tồn kho SAU commit, gom theo chi nhánh', async () => {
    const { ledger, emitted, ctx, commit } = makeLedger([
      batch('a', 0, { branchId: 'CN-A', productId: 'P-1' }),
      batch('b', 0, { branchId: 'CN-A', productId: 'P-2' }),
      batch('c', 0, { branchId: 'CN-B', productId: 'P-1' }),
    ]);

    await ledger.apply(ctx, [entry('a', 1), entry('b', 1), entry('c', 1)], ACTOR);
    expect(emitted).toHaveLength(0);

    await commit();
    expect(emitted).toHaveLength(2);
    expect(emitted.find((event) => event.branchId === 'CN-A')?.productIds.sort()).toEqual(['P-1', 'P-2']);
  });
});
