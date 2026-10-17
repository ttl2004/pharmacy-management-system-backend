import { BatchStatus, StockMovementType, StockRefType } from '@prisma/client';
import { ErrorCode } from 'src/common/types/error-code';
import { parseDateOnly } from 'src/common/utils/date-only.util';
import type { InventoryTxContext } from './inventory-transactions';
import { IntakeBatch, NewBatchRow, StockBatchRepository } from './stock-batch.repository';
import { costAfterWithdraw, IntakeLine, StockIntakeService, weightedAverageCost } from './stock-intake.service';

const EXPIRY = parseDateOnly('2028-01-31');

const line = (overrides: Partial<IntakeLine> = {}): IntakeLine => ({
  productId: 'p1',
  batchNumber: 'L1',
  manufacturingDate: null,
  expiryDate: EXPIRY,
  quantity: 50,
  unitCost: 1300,
  supplierId: 's1',
  goodsReceiptItemId: 'i1',
  refItemId: 'i1',
  ...overrides,
});

const locked = (overrides: Partial<IntakeBatch> = {}): IntakeBatch => ({
  id: 'b1',
  branchId: 'br',
  productId: 'p1',
  batchNumber: 'L1',
  expiryDate: EXPIRY,
  quantityOnHand: 100,
  reservedQuantity: 0,
  importPrice: 1000,
  status: BatchStatus.AVAILABLE,
  recallReason: null,
  recalledBy: null,
  ...overrides,
});

function makeIntake(lockedRows: IntakeBatch[]) {
  const batches = {
    lockBatchNumbers: jest.fn(),
    insertSkipExisting: jest.fn().mockResolvedValue({ count: 0 }),
    lockByKey: jest.fn().mockResolvedValue(lockedRows),
    markRecalled: jest.fn(),
    updateCosts: jest.fn(),
    findWithNonImportMovements: jest.fn().mockResolvedValue(new Set<string>()),
    resetDates: jest.fn(),
  };
  const ledger = { apply: jest.fn().mockResolvedValue([]), lockBatches: jest.fn().mockResolvedValue(lockedRows) };
  const ctx: InventoryTxContext = { tx: {} as never, afterCommit: jest.fn() };
  const audit = { record: jest.fn() };
  const intake = new StockIntakeService(batches as never, ledger as never, audit as never);
  return { intake, batches, ledger, audit, ctx };
}

const request = (lines: IntakeLine[]) => ({
  branchId: 'br',
  type: StockMovementType.IMPORT,
  refType: StockRefType.GOODS_RECEIPT,
  refId: 'r1',
  lines,
  actorId: 'actor',
});

describe('StockIntakeService', () => {
  it('lô đã có: gộp, giá vốn bình quân, ghi sổ với lô đã khoá (không khoá lại)', async () => {
    const rows = [locked()];
    const { intake, batches, ledger, ctx } = makeIntake(rows);

    const result = await intake.intake(ctx, request([line()]));

    expect(batches.updateCosts).toHaveBeenCalledWith({}, [{ id: 'b1', importPrice: 1100 }], 'actor');
    expect(ledger.apply).toHaveBeenCalledWith(
      ctx,
      [expect.objectContaining({ batchId: 'b1', quantity: 50, unitCost: 1300, type: 'IMPORT', refItemId: 'i1' })],
      'actor',
      { preLocked: rows },
    );
    expect(result.batchIdByRefItem.get('i1')).toBe('b1');
  });

  it('lô mới tạo mang NCC, dòng phiếu nhập đầu tiên và giá của lần nhập', async () => {
    const { intake, batches, ctx } = makeIntake([locked({ quantityOnHand: 0, importPrice: 1300 })]);

    await intake.intake(ctx, request([line()]));

    const [, rows] = batches.insertSkipExisting.mock.calls[0] as [unknown, Record<string, unknown>[]];
    expect(rows[0]).toMatchObject({ branchId: 'br', supplierId: 's1', goodsReceiptItemId: 'i1', importPrice: 1300 });
  });

  it('cùng số lô khác hạn → 1703, không ghi gì', async () => {
    const { intake, ledger, ctx } = makeIntake([locked({ expiryDate: parseDateOnly('2028-02-01') })]);
    await expect(intake.intake(ctx, request([line()]))).rejects.toMatchObject({
      errorCode: ErrorCode.BATCH_EXPIRY_MISMATCH,
    });
    expect(ledger.apply).not.toHaveBeenCalled();
  });

  it('lô trống chỉ từng nhận hàng từ phiếu đã huỷ (nhập nhầm hạn) → nhận hạn mới, nhập bình thường', async () => {
    const rows = [locked({ quantityOnHand: 0, expiryDate: parseDateOnly('2027-01-15') })];
    const { intake, batches, ledger, ctx } = makeIntake(rows);

    await intake.intake(ctx, request([line()]));

    expect(batches.findWithNonImportMovements).toHaveBeenCalledWith({}, ['b1']);
    expect(batches.resetDates).toHaveBeenCalledWith(
      {},
      [{ id: 'b1', expiryDate: '2028-01-31', manufacturingDate: null }],
      'actor',
    );
    expect(batches.updateCosts).toHaveBeenCalledWith({}, [{ id: 'b1', importPrice: 1300 }], 'actor');
    expect(ledger.apply).toHaveBeenCalled();
  });

  it('lô trống nhưng từng bán/chuyển/điều chỉnh → hạn đã có thật, vẫn 1703', async () => {
    const { intake, batches, ledger, ctx } = makeIntake([
      locked({ quantityOnHand: 0, expiryDate: parseDateOnly('2027-01-15') }),
    ]);
    batches.findWithNonImportMovements.mockResolvedValue(new Set(['b1']));

    await expect(intake.intake(ctx, request([line()]))).rejects.toMatchObject({
      errorCode: ErrorCode.BATCH_EXPIRY_MISMATCH,
    });
    expect(batches.resetDates).not.toHaveBeenCalled();
    expect(ledger.apply).not.toHaveBeenCalled();
  });

  it('lô còn hàng mà khác hạn → 1703, không cần hỏi lịch sử lô', async () => {
    const { intake, batches, ctx } = makeIntake([locked({ expiryDate: parseDateOnly('2028-02-01') })]);
    await expect(intake.intake(ctx, request([line()]))).rejects.toMatchObject({
      errorCode: ErrorCode.BATCH_EXPIRY_MISMATCH,
    });
    expect(batches.findWithNonImportMovements).not.toHaveBeenCalled();
  });

  it('lô đang cách ly → 1704', async () => {
    const { intake, ctx } = makeIntake([locked({ status: BatchStatus.QUARANTINE })]);
    await expect(intake.intake(ctx, request([line()]))).rejects.toMatchObject({
      errorCode: ErrorCode.BATCH_NOT_AVAILABLE,
    });
  });

  it('lô đã thu hồi vẫn nhận hàng (tồn đúng thực tế), không đổi trạng thái', async () => {
    const { intake, batches, ledger, ctx } = makeIntake([locked({ status: BatchStatus.RECALLED })]);
    await intake.intake(ctx, request([line()]));
    expect(ledger.apply).toHaveBeenCalled();
    expect(batches.markRecalled).not.toHaveBeenCalled();
  });

  it('khoá số lô TRƯỚC khi tạo lô, để thu hồi theo số lô chạy nối tiếp với lần đưa hàng vào', async () => {
    const { intake, batches, ctx } = makeIntake([locked()]);
    await intake.intake(ctx, request([line()]));
    expect(batches.lockBatchNumbers).toHaveBeenCalledWith({}, [{ productId: 'p1', batchNumber: 'L1' }]);
    expect(batches.lockBatchNumbers.mock.invocationCallOrder[0]).toBeLessThan(
      batches.insertSkipExisting.mock.invocationCallOrder[0],
    );
  });

  describe('lô vừa tạo thừa hưởng thu hồi của cùng số lô ở chi nhánh khác', () => {
    /** lockByKey trả về đúng id mà intake vừa sinh cho lô mới — tức là lô được tạo ở lần này. */
    function intakeCreating(overrides: Partial<IntakeBatch>) {
      const setup = makeIntake([]);
      setup.batches.lockByKey.mockImplementation(() => {
        const [, rows] = setup.batches.insertSkipExisting.mock.calls[0] as [unknown, NewBatchRow[]];
        return Promise.resolve([locked({ id: rows[0].id, quantityOnHand: 0, ...overrides })]);
      });
      return setup;
    }

    it('cùng số lô bị thu hồi nơi khác → lô mới RECALLED, cùng lý do và người thu hồi, có nhật ký; hàng vẫn vào sổ', async () => {
      const { intake, batches, ledger, audit, ctx } = intakeCreating({ recallReason: 'QĐ 9/QLD', recalledBy: 'admin' });
      await intake.intake(ctx, request([line()]));
      const [, rows] = batches.insertSkipExisting.mock.calls[0] as [unknown, NewBatchRow[]];
      expect(batches.markRecalled).toHaveBeenCalledWith(
        {},
        [{ id: rows[0].id, reason: 'QĐ 9/QLD', recalledBy: 'admin' }],
        'actor',
      );
      const [, entries] = audit.record.mock.calls[0] as [unknown, Record<string, unknown>[]];
      expect(entries[0]).toMatchObject({
        entityId: rows[0].id,
        before: { status: 'AVAILABLE' },
        after: { status: 'RECALLED' },
        reason: 'QĐ 9/QLD',
      });
      expect(ledger.apply).toHaveBeenCalled();
    });

    it('không có thu hồi nào → không đổi trạng thái', async () => {
      const { intake, batches, ctx } = intakeCreating({});
      await intake.intake(ctx, request([line()]));
      expect(batches.markRecalled).not.toHaveBeenCalled();
    });

    it('lô ĐÃ CÓ từ trước giữ trạng thái của nó dù nơi khác đã thu hồi', async () => {
      const { intake, batches, ctx } = makeIntake([locked({ recallReason: 'QĐ 9/QLD', recalledBy: 'admin' })]);
      await intake.intake(ctx, request([line()]));
      expect(batches.markRecalled).not.toHaveBeenCalled();
    });
  });

  it('không có dòng thì không gọi DB', async () => {
    const { intake, batches, ctx } = makeIntake([]);
    await intake.intake(ctx, request([]));
    expect(batches.insertSkipExisting).not.toHaveBeenCalled();
  });
});

describe('weightedAverageCost (K3)', () => {
  it('bình quân gia quyền, làm tròn về đồng', () => {
    // 100 viên giá 1.000 + 50 viên giá 1.300 → (100.000 + 65.000) / 150 = 1.100
    expect(weightedAverageCost(100, 1_000, 50, 1_300)).toBe(1_100);
  });

  it('lô đang trống thì lấy giá lần đưa vào này', () => {
    expect(weightedAverageCost(0, 999, 10, 1_500)).toBe(1_500);
  });
});

describe('StockIntakeService.returnToBatches', () => {
  it('hoàn hàng về đúng lô: giá vốn bình quân lại với phần lô đang có, ghi sổ với lô đã khoá', async () => {
    // Lô còn 10 viên giá 1200 (nhập thêm lúc hàng đi đường); 30 viên giá 900 quay về → (10×1200 + 30×900) / 40 = 975.
    const rows = [locked({ quantityOnHand: 10, importPrice: 1200 })];
    const { intake, batches, ledger, ctx } = makeIntake(rows);

    await intake.returnToBatches(ctx, {
      type: StockMovementType.TRANSFER_IN,
      refType: StockRefType.STOCK_TRANSFER,
      refId: 't1',
      actorId: 'actor',
      note: 'Hoàn hàng',
      lines: [{ batchId: 'b1', quantity: 30, unitCost: 900, refItemId: 'i1' }],
    });

    expect(ledger.lockBatches).toHaveBeenCalledWith(ctx, ['b1']);
    expect(batches.updateCosts).toHaveBeenCalledWith({}, [{ id: 'b1', importPrice: 975 }], 'actor');
    expect(ledger.apply).toHaveBeenCalledWith(
      ctx,
      [expect.objectContaining({ batchId: 'b1', quantity: 30, unitCost: 900, type: 'TRANSFER_IN', note: 'Hoàn hàng' })],
      'actor',
      { preLocked: rows },
    );
  });
});

describe('costAfterWithdraw', () => {
  it('ngược đúng với weightedAverageCost: rút phần vừa nhập thì về giá cũ', () => {
    const merged = weightedAverageCost(100, 1_000, 50, 1_300); // 1.100
    expect(costAfterWithdraw(150, merged, { quantity: 50, value: 50 * 1_300 })).toBe(1_000);
  });

  it('nhập nhầm giá rồi lô nhận thêm hàng khác: huỷ phiếu nhầm vẫn ra giá như chưa từng nhập', () => {
    // 100×1.000, nhập nhầm 10×100.000 → 10.000; nhập tiếp 90×1.000 → 5.950; rút phần nhầm → 190.000 / 190 = 1.000.
    const afterTypo = weightedAverageCost(100, 1_000, 10, 100_000);
    const afterMore = weightedAverageCost(110, afterTypo, 90, 1_000);
    expect(costAfterWithdraw(200, afterMore, { quantity: 10, value: 10 * 100_000 })).toBe(1_000);
  });

  it('lô về 0 thì giữ giá hiện tại', () => {
    expect(costAfterWithdraw(50, 1_300, { quantity: 50, value: 65_000 })).toBe(1_300);
  });
});

describe('StockIntakeService.withdraw', () => {
  it('trả giá vốn về như chưa nhập (gộp nhiều dòng cùng lô), ghi bút toán âm với lô caller đã khoá', async () => {
    // Lô 150 viên giá 1.100 = 100×1.000 có sẵn + phiếu này 2 dòng 20×1.300 và 30×1.300.
    const rows = [locked({ quantityOnHand: 150, importPrice: 1_100 })];
    const { intake, batches, ledger, ctx } = makeIntake(rows);

    await intake.withdraw(ctx, {
      type: StockMovementType.IMPORT,
      refType: StockRefType.GOODS_RECEIPT,
      refId: 'r1',
      actorId: 'actor',
      note: 'Huỷ phiếu',
      locked: rows,
      lines: [
        { batchId: 'b1', quantity: 20, unitCost: 1_300, refItemId: 'i1' },
        { batchId: 'b1', quantity: 30, unitCost: 1_300, refItemId: 'i2' },
      ],
    });

    expect(ledger.lockBatches).not.toHaveBeenCalled();
    expect(batches.updateCosts).toHaveBeenCalledWith({}, [{ id: 'b1', importPrice: 1_000 }], 'actor');
    expect(ledger.apply).toHaveBeenCalledWith(
      ctx,
      [
        expect.objectContaining({ batchId: 'b1', quantity: -20, refItemId: 'i1' }),
        expect.objectContaining({ batchId: 'b1', quantity: -30, refItemId: 'i2' }),
      ],
      'actor',
      { preLocked: rows },
    );
  });
});

describe('StockBatchRepository.insertSkipExisting', () => {
  it('chèn theo thứ tự (sản phẩm, số lô) để hai transaction cùng tạo lô không deadlock trên unique', async () => {
    const createMany = jest.fn().mockResolvedValue({ count: 3 });
    const row = (productId: string, batchNumber: string): NewBatchRow => ({
      id: `${productId}-${batchNumber}`,
      branchId: 'b',
      productId,
      batchNumber,
      manufacturingDate: null,
      expiryDate: EXPIRY,
      importPrice: 1000,
      supplierId: null,
      goodsReceiptItemId: null,
      createdBy: 'u',
    });

    await new StockBatchRepository().insertSkipExisting({ stockBatch: { createMany } } as never, [
      row('p2', 'A'),
      row('p1', 'B'),
      row('p1', 'A'),
    ]);

    const data = (createMany.mock.calls[0] as [{ data: NewBatchRow[] }])[0].data;
    expect(data.map((r) => `${r.productId}|${r.batchNumber}`)).toEqual(['p1|A', 'p1|B', 'p2|A']);
  });
});
