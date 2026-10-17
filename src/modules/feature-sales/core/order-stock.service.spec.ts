import { BatchStatus, StockMovementType, StockRefType } from '@prisma/client';
import { ErrorCode } from 'src/common/types/error-code';
import type { InventoryTxContext } from 'src/modules/feature-inventory/core/inventory-transactions';
import type { LockedBatch } from 'src/modules/feature-inventory/core/stock-ledger.repository';
import { OrderStockRepository, ReservedAllocation } from './order-stock.repository';
import { OrderStockService } from './order-stock.service';

const TODAY = '2026-10-16';
const ctx = { tx: {}, afterCommit: jest.fn() } as unknown as InventoryTxContext;

const batch = (id: string, overrides: Partial<LockedBatch> = {}): LockedBatch => ({
  id,
  branchId: 'b1',
  productId: 'p1',
  batchNumber: `L-${id}`,
  expiryDate: new Date('2027-01-01'),
  quantityOnHand: 100,
  reservedQuantity: 10,
  importPrice: 700,
  status: BatchStatus.AVAILABLE,
  ...overrides,
});

const allocation = (id: string, batchId: string, quantity: number): ReservedAllocation => ({
  id,
  orderItemId: 'item-1',
  batchId,
  quantity,
  unitCost: 500,
});

describe('OrderStockService', () => {
  const allocator = { allocateFefo: jest.fn() };
  const ledger = { reserve: jest.fn(), release: jest.fn(), lockBatches: jest.fn(), apply: jest.fn() };
  const repository = {
    findAllocations: jest.fn(),
    insertAllocations: jest.fn(),
    deleteAllocations: jest.fn(),
    setUnitCosts: jest.fn(),
  };
  const service = new OrderStockService(
    allocator as never,
    ledger as never,
    repository as unknown as OrderStockRepository,
  );

  beforeEach(() => jest.clearAllMocks());

  it('reserve: chọn FEFO theo số lượng cơ bản, giữ trên đúng lô đã khoá, nối phân bổ về dòng đơn qua lineIndex', async () => {
    const locked = [batch('l1'), batch('l2')];
    allocator.allocateFefo.mockResolvedValue({
      locked,
      allocations: [
        { lineIndex: 0, productId: 'p1', batchId: 'l1', quantity: 5, unitCost: 700 },
        { lineIndex: 0, productId: 'p1', batchId: 'l2', quantity: 7, unitCost: 650 },
        { lineIndex: 1, productId: 'p2', batchId: 'l3', quantity: 1, unitCost: 100 },
      ],
    });

    await service.reserve(
      ctx,
      {
        orderId: 'o1',
        branchId: 'b1',
        actorId: 'u1',
        items: [
          { orderItemId: 'i1', productId: 'p1', baseQuantity: 12 },
          { orderItemId: 'i2', productId: 'p2', baseQuantity: 1 },
        ],
      },
      TODAY,
    );

    expect(allocator.allocateFefo).toHaveBeenCalledWith(
      ctx,
      'b1',
      [
        { productId: 'p1', quantity: 12 },
        { productId: 'p2', quantity: 1 },
      ],
      TODAY,
    );
    expect(ledger.reserve).toHaveBeenCalledWith(
      ctx,
      [
        { batchId: 'l1', quantity: 5 },
        { batchId: 'l2', quantity: 7 },
        { batchId: 'l3', quantity: 1 },
      ],
      { refType: StockRefType.ORDER, refId: 'o1' },
      'u1',
      { preLocked: locked },
    );
    expect(repository.insertAllocations).toHaveBeenCalledWith(ctx.tx, [
      { orderItemId: 'i1', batchId: 'l1', quantity: 5, unitCost: 700 },
      { orderItemId: 'i1', batchId: 'l2', quantity: 7, unitCost: 650 },
      { orderItemId: 'i2', batchId: 'l3', quantity: 1, unitCost: 100 },
    ]);
  });

  it('release: nhả đúng lượng đã giữ ở từng lô, không xoá phân bổ', async () => {
    repository.findAllocations.mockResolvedValue([allocation('a1', 'l1', 5), allocation('a2', 'l2', 7)]);
    await service.release(ctx, 'o1', 'u1');
    expect(ledger.release).toHaveBeenCalledWith(
      ctx,
      [
        { batchId: 'l1', quantity: 5 },
        { batchId: 'l2', quantity: 7 },
      ],
      { refType: StockRefType.ORDER, refId: 'o1' },
      'u1',
    );
    expect(repository.deleteAllocations).not.toHaveBeenCalled();
  });

  it('discard: nhả rồi xoá phân bổ của đơn', async () => {
    repository.findAllocations.mockResolvedValue([allocation('a1', 'l1', 5)]);
    await service.discard(ctx, 'o1', 'u1');
    expect(ledger.release).toHaveBeenCalled();
    expect(repository.deleteAllocations).toHaveBeenCalledWith(ctx.tx, 'o1');
  });

  it('consume: chốt giá vốn hiện tại của lô, ghi SALE âm từ phần đã giữ, refItemId là dòng phân bổ', async () => {
    const locked = [batch('l1', { importPrice: 720 }), batch('l2', { importPrice: 640 })];
    repository.findAllocations.mockResolvedValue([allocation('a1', 'l1', 5), allocation('a2', 'l2', 7)]);
    ledger.lockBatches.mockResolvedValue(locked);

    await service.consume(ctx, 'o1', 'u1', TODAY);

    expect(repository.setUnitCosts).toHaveBeenCalledWith(ctx.tx, [
      { id: 'a1', unitCost: 720 },
      { id: 'a2', unitCost: 640 },
    ]);
    const sale = (refItemId: string, batchId: string, quantity: number, unitCost: number) => ({
      batchId,
      type: StockMovementType.SALE,
      quantity,
      unitCost,
      refType: StockRefType.ORDER,
      refId: 'o1',
      refItemId,
      fromReserved: true,
    });
    expect(ledger.apply).toHaveBeenCalledWith(ctx, [sale('a1', 'l1', -5, 720), sale('a2', 'l2', -7, 640)], 'u1', {
      preLocked: locked,
    });
  });

  it.each([
    ['bị thu hồi', { status: BatchStatus.RECALLED }],
    ['hết hạn đúng hôm nay', { expiryDate: new Date('2026-10-16') }],
  ])('consume: lô đã giữ %s → 1704, không ghi sổ', async (_name, overrides) => {
    repository.findAllocations.mockResolvedValue([allocation('a1', 'l1', 5)]);
    ledger.lockBatches.mockResolvedValue([batch('l1', overrides)]);
    await expect(service.consume(ctx, 'o1', 'u1', TODAY)).rejects.toMatchObject({
      errorCode: ErrorCode.BATCH_NOT_AVAILABLE,
    });
    expect(ledger.apply).not.toHaveBeenCalled();
    expect(repository.setUnitCosts).not.toHaveBeenCalled();
  });

  it('consume: đơn không có phân bổ là lỗi lập trình (Error thường)', async () => {
    repository.findAllocations.mockResolvedValue([]);
    await expect(service.consume(ctx, 'o1', 'u1', TODAY)).rejects.toThrow('không có phân bổ lô');
  });
});
