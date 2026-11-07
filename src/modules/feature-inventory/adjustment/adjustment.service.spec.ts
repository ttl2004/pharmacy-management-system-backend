import { AdjustmentType, BatchStatus, ReceiptStatus, RecordStatus } from '@prisma/client';
import { AuthRole } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';
import { ErrorException } from 'src/common/exceptions/error.exception';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { ADJUSTMENT_MOVEMENT_TYPE, AdjustmentService } from './adjustment.service';

const A = '11111111-1111-4111-8111-111111111111';
const PM_A: RequestActor = {
  user: { userId: 'pm-a', sid: 's', email: null, role: AuthRole.PHARMACY_MANAGER, branchId: A, roleLevel: 60 },
  ip: null,
  userAgent: null,
  requestId: null,
};

function makeService(overrides: Record<string, jest.Mock> = {}) {
  const repository = {
    findBranch: jest.fn().mockResolvedValue({ id: A, status: RecordStatus.ACTIVE }),
    findSupplier: jest.fn().mockResolvedValue({ id: 's1' }),
    findBatches: jest.fn().mockResolvedValue([{ id: 'b1', productId: 'p1', quantityOnHand: 50 }]),
    lockBatches: jest.fn().mockResolvedValue([{ id: 'b1', productId: 'p1', quantityOnHand: 50 }]),
    findPendingStockTake: jest.fn().mockResolvedValue(null),
    createHeader: jest.fn().mockResolvedValue({ id: 'adj1' }),
    createItems: jest.fn(),
    findDetail: jest.fn().mockResolvedValue({ id: 'adj1' }),
    findHead: jest.fn(),
    transition: jest.fn().mockResolvedValue(1),
    findItems: jest.fn(),
    freezeUnitCosts: jest.fn(),
    ...overrides,
  };
  const transactions = { run: jest.fn((work: (ctx: unknown) => unknown) => work({ tx: {}, afterCommit: jest.fn() })) };
  const ledger = {
    apply: jest.fn().mockResolvedValue([]),
    lockBatches: jest.fn().mockResolvedValue([
      {
        id: 'b1',
        branchId: A,
        productId: 'p1',
        batchNumber: 'L1',
        quantityOnHand: 50,
        reservedQuantity: 0,
        importPrice: 700,
        status: BatchStatus.RECALLED,
      },
    ]),
  };
  const codes = { next: jest.fn().mockResolvedValue('DCK000001') };
  const audit = { record: jest.fn() };
  const intake = { intake: jest.fn().mockResolvedValue({}), returnToBatches: jest.fn().mockResolvedValue([]) };
  // Phiếu không phải trả NCC thì không đụng tiền: assertNoMoney chỉ kiểm DTO, mock để no-op.
  const returnMoney = {
    assertNoMoney: jest.fn(),
    lockSupplierOf: jest.fn(),
    recheckOnConfirm: jest.fn(),
    assertDebtStaysNonNegative: jest.fn(),
  };
  const service = new AdjustmentService(
    repository as never,
    transactions as never,
    ledger as never,
    codes as never,
    audit as never,
    intake as never,
    returnMoney as never,
  );
  return { service, repository, ledger, audit, intake, returnMoney };
}

type RecordCall = [unknown, Record<string, unknown>, Record<string, unknown>[]];

/** Đầu phiếu như `findHead` trả: có mã, lý do của phiếu và tổng tiền trả NCC. */
const head = (
  type: AdjustmentType,
  status: ReceiptStatus = ReceiptStatus.DRAFT,
  extra: Record<string, unknown> = {},
) => ({
  id: 'adj1',
  code: 'XH000001',
  status,
  type,
  branchId: A,
  reason: 'Biên bản huỷ số 12',
  totalAmount: 0n,
  goodsReceiptId: null,
  refundExpenses: null,
  ...extra,
});

const create = (type: AdjustmentType, item: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type,
  reason: 'Biên bản số 1',
  items: [{ batchId: 'b1', ...item }],
  ...extra,
});

describe('ánh xạ loại phiếu → bút toán', () => {
  it('kiểm kê/khác → ADJUST, huỷ → DISPOSE, trả NCC → RETURN_OUT', () => {
    expect(ADJUSTMENT_MOVEMENT_TYPE).toEqual({
      STOCK_TAKE: 'ADJUST',
      OTHER: 'ADJUST',
      DISPOSE: 'DISPOSE',
      RETURN_TO_SUPPLIER: 'RETURN_OUT',
    });
  });
});

describe('AdjustmentService — lập phiếu', () => {
  it('kiểm kê mà gửi quantity → 1002 (server tự tính chênh lệch)', async () => {
    const { service } = makeService();
    await expect(
      service.create(create('STOCK_TAKE', { actualQuantity: 1, quantity: 1 }) as never, PM_A),
    ).rejects.toMatchObject({
      errorCode: ErrorCode.HTTP_BAD_REQUEST,
    });
  });

  it('huỷ hàng nhập số âm → 1002 (huỷ luôn là số dương đưa ra khỏi kho)', async () => {
    const { service } = makeService();
    await expect(service.create(create('DISPOSE', { quantity: -5 }) as never, PM_A)).rejects.toMatchObject({
      errorCode: ErrorCode.HTTP_BAD_REQUEST,
    });
  });

  it('trả NCC thiếu nhà cung cấp → 1002', async () => {
    const { service } = makeService();
    await expect(service.create(create('RETURN_TO_SUPPLIER', { quantity: 5 }) as never, PM_A)).rejects.toMatchObject({
      errorCode: ErrorCode.HTTP_BAD_REQUEST,
    });
  });

  it('huỷ 5 viên → dòng nháp lưu delta -5', async () => {
    const { service, repository } = makeService();
    await service.create(create('DISPOSE', { quantity: 5 }) as never, PM_A);
    const [, rows] = repository.createItems.mock.calls[0] as [unknown, Record<string, unknown>[]];
    expect(rows[0]).toMatchObject({
      batchId: 'b1',
      productId: 'p1',
      quantity: -5,
      actualQuantity: null,
      adjustmentId: 'adj1',
    });
  });

  it('kiểm kê: chốt số sổ sách LÚC LẬP PHIẾU (vừa đếm xong), chênh lệch = thực đếm − sổ sách lúc đó', async () => {
    const { service, repository } = makeService();
    await service.create(create('STOCK_TAKE', { actualQuantity: 47 }) as never, PM_A);
    const [, rows] = repository.createItems.mock.calls[0] as [unknown, Record<string, unknown>[]];
    expect(rows[0]).toMatchObject({ systemQuantity: 50, actualQuantity: 47, quantity: -3 });
  });

  it('huỷ/khác không lưu số sổ sách', async () => {
    const { service, repository } = makeService();
    await service.create(create('OTHER', { quantity: 4 }) as never, PM_A);
    const [, rows] = repository.createItems.mock.calls[0] as [unknown, Record<string, unknown>[]];
    expect(rows[0]).toMatchObject({ systemQuantity: null, quantity: 4 });
  });

  it('nhà cung cấp chỉ dùng cho phiếu trả NCC → loại khác gửi supplierId thì 1002', async () => {
    const { service } = makeService();
    await expect(
      service.create(create('DISPOSE', { quantity: 1 }, { supplierId: 's1' }) as never, PM_A),
    ).rejects.toMatchObject({ errorCode: ErrorCode.HTTP_BAD_REQUEST });
  });

  it('lô không thuộc chi nhánh (truy vấn lọc theo chi nhánh, không thấy lô) → 1602', async () => {
    const { service, repository } = makeService({ findBatches: jest.fn().mockResolvedValue([]) });
    await expect(service.create(create('DISPOSE', { quantity: 1 }) as never, PM_A)).rejects.toMatchObject({
      errorCode: ErrorCode.INVALID_REFERENCE,
    });
    expect(repository.findBatches).toHaveBeenCalledWith(expect.anything(), A, ['b1']);
  });
});

describe('AdjustmentService — mỗi lô một phiếu kiểm kê nháp', () => {
  it('kiểm kê khoá lô của chi nhánh mình trước khi kiểm phiếu nháp, để hai lần lập cùng lúc chạy nối tiếp', async () => {
    const { service, repository } = makeService();
    await service.create(create('STOCK_TAKE', { actualQuantity: 47 }) as never, PM_A);
    expect(repository.lockBatches).toHaveBeenCalledWith(expect.anything(), A, ['b1']);
    expect(repository.findBatches).not.toHaveBeenCalled();
    expect(repository.lockBatches.mock.invocationCallOrder[0]).toBeLessThan(
      repository.findPendingStockTake.mock.invocationCallOrder[0],
    );
  });

  it('lô chi nhánh khác đang có phiếu kiểm kê nháp → vẫn 1602, không lộ phiếu của họ (1711)', async () => {
    const { service, repository } = makeService({
      lockBatches: jest.fn().mockResolvedValue([]),
      findPendingStockTake: jest.fn().mockResolvedValue({ batchNumber: 'L1', code: 'DCK000009' }),
    });
    await expect(service.create(create('STOCK_TAKE', { actualQuantity: 1 }) as never, PM_A)).rejects.toMatchObject({
      errorCode: ErrorCode.INVALID_REFERENCE,
    });
    expect(repository.findPendingStockTake).not.toHaveBeenCalled();
  });

  it('lô đang có phiếu kiểm kê nháp → 1711, không tạo phiếu', async () => {
    const { service, repository } = makeService({
      findPendingStockTake: jest.fn().mockResolvedValue({ batchNumber: 'L1', code: 'DCK000001' }),
    });
    await expect(service.create(create('STOCK_TAKE', { actualQuantity: 47 }) as never, PM_A)).rejects.toMatchObject({
      errorCode: ErrorCode.STOCK_TAKE_PENDING,
    });
    expect(repository.createHeader).not.toHaveBeenCalled();
  });

  it('phiếu huỷ hàng chỉ đọc lô (không khoá) và không bị chặn bởi phiếu kiểm kê nháp', async () => {
    const { service, repository } = makeService();
    await service.create(create('DISPOSE', { quantity: 5 }) as never, PM_A);
    expect(repository.lockBatches).not.toHaveBeenCalled();
    expect(repository.findPendingStockTake).not.toHaveBeenCalled();
  });
});

describe('AdjustmentService — xác nhận', () => {
  it('kiểm kê: giữa lúc đếm và lúc xác nhận đã bán 10 → vẫn chỉ ghi chênh lệch −3, không xoá lượt bán', async () => {
    const { service, repository, ledger } = makeService({
      findHead: jest
        .fn()
        .mockResolvedValue({ id: 'adj1', status: ReceiptStatus.DRAFT, type: AdjustmentType.STOCK_TAKE, branchId: A }),
      findItems: jest
        .fn()
        .mockResolvedValue([
          { id: 'i1', batchId: 'b1', systemQuantity: 50, actualQuantity: 47, quantity: -3, reason: null },
        ]),
    });
    // Lô lúc xác nhận còn 40 (bán 10 sau khi đếm) — kệ thực có 37.
    ledger.lockBatches.mockResolvedValue([
      {
        id: 'b1',
        branchId: A,
        productId: 'p1',
        batchNumber: 'L1',
        quantityOnHand: 40,
        reservedQuantity: 0,
        importPrice: 700,
        status: BatchStatus.AVAILABLE,
      },
    ]);

    await service.confirm('adj1', PM_A);

    expect(repository.freezeUnitCosts).toHaveBeenCalledWith(
      {},
      [expect.objectContaining({ id: 'i1', unitCost: 700 })],
      'pm-a',
    );
    const [, entries] = ledger.apply.mock.calls[0] as [unknown, Record<string, unknown>[]];
    expect(entries[0]).toMatchObject({ type: 'ADJUST', quantity: -3, refType: 'STOCK_ADJUSTMENT', refItemId: 'i1' });
  });

  it('kiểm kê khớp sổ: không ghi bút toán 0', async () => {
    const { service, ledger } = makeService({
      findHead: jest
        .fn()
        .mockResolvedValue({ id: 'adj1', status: ReceiptStatus.DRAFT, type: AdjustmentType.STOCK_TAKE, branchId: A }),
      findItems: jest
        .fn()
        .mockResolvedValue([
          { id: 'i1', batchId: 'b1', systemQuantity: 50, actualQuantity: 50, quantity: 0, reason: null },
        ]),
    });
    await service.confirm('adj1', PM_A);
    const [, entries] = ledger.apply.mock.calls[0] as [unknown, unknown[]];
    expect(entries).toEqual([]);
  });

  it('huỷ lô đang bị thu hồi vẫn được (đó chính là việc phải làm)', async () => {
    const { service, ledger } = makeService({
      findHead: jest
        .fn()
        .mockResolvedValue({ id: 'adj1', status: ReceiptStatus.DRAFT, type: AdjustmentType.DISPOSE, branchId: A }),
      findItems: jest
        .fn()
        .mockResolvedValue([{ id: 'i1', batchId: 'b1', actualQuantity: null, quantity: -50, reason: 'thu hồi' }]),
    });
    await service.confirm('adj1', PM_A);
    const [, entries] = ledger.apply.mock.calls[0] as [unknown, Record<string, unknown>[]];
    expect(entries[0]).toMatchObject({ type: 'DISPOSE', quantity: -50, note: 'thu hồi' });
  });

  it('phiếu kiểm kê đã xác nhận không huỷ được → 1701 (biên bản cân bằng; phiếu huỷ/trả đã xác nhận thì đảo bút toán)', async () => {
    const { service } = makeService({
      findHead: jest.fn().mockResolvedValue({
        id: 'adj1',
        status: ReceiptStatus.CONFIRMED,
        type: AdjustmentType.STOCK_TAKE,
        branchId: A,
      }),
    });
    await expect(service.cancel('adj1', { reason: 'x' }, PM_A)).rejects.toMatchObject({
      errorCode: ErrorCode.INVALID_DOCUMENT_STATE,
    });
  });
});

describe('AdjustmentService — giá trị tổn thất', () => {
  it('lossValue là số dương: huỷ 3 viên giá vốn 700 → amount 2100n', async () => {
    const { service, audit } = makeService({
      findHead: jest.fn().mockResolvedValue(head(AdjustmentType.DISPOSE)),
      findItems: jest
        .fn()
        .mockResolvedValue([
          { id: 'i1', batchId: 'b1', systemQuantity: null, actualQuantity: null, quantity: -3, reason: null },
        ]),
    });
    await service.confirm('adj1', PM_A);
    const [, , entries] = audit.record.mock.calls[0] as RecordCall;
    expect(entries[0].amount).toBe(2100n);
  });
});

describe('AdjustmentService — nhật ký theo loại phiếu', () => {
  const disposeItems = [
    { id: 'i1', batchId: 'b1', systemQuantity: null, actualQuantity: null, quantity: -3, reason: null },
  ];

  it('confirm DISPOSE ghi DISPOSAL.CONFIRMED với reason của phiếu và amount = lossValue (bigint)', async () => {
    const { service, audit } = makeService({
      findHead: jest.fn().mockResolvedValue(head(AdjustmentType.DISPOSE)),
      findItems: jest.fn().mockResolvedValue(disposeItems),
    });
    await service.confirm('adj1', PM_A);
    expect(audit.record).toHaveBeenCalledTimes(1);
    const [, auditActor, entries] = audit.record.mock.calls[0] as RecordCall;
    expect(auditActor).toMatchObject({ userId: 'pm-a', type: 'USER' });
    expect(entries).toEqual([
      expect.objectContaining({
        event: 'DISPOSAL.CONFIRMED',
        entityType: 'stock_adjustments',
        entityId: 'adj1',
        entityLabel: 'XH000001',
        branchIds: [A],
        searchTerms: ['XH000001'],
        reason: 'Biên bản huỷ số 12',
        amount: 2100n,
        before: { status: 'DRAFT' },
        after: { status: 'CONFIRMED' },
      }),
    ]);
  });

  it('confirm RETURN_TO_SUPPLIER ghi PURCHASE_RETURN.CONFIRMED, amount = totalAmount', async () => {
    const { service, audit } = makeService({
      findHead: jest
        .fn()
        .mockResolvedValue(head(AdjustmentType.RETURN_TO_SUPPLIER, ReceiptStatus.DRAFT, { totalAmount: 45_000n })),
      findItems: jest.fn().mockResolvedValue(disposeItems),
    });
    await service.confirm('adj1', PM_A);
    const [, , entries] = audit.record.mock.calls[0] as RecordCall;
    expect(entries).toEqual([
      expect.objectContaining({
        event: 'PURCHASE_RETURN.CONFIRMED',
        reason: 'Biên bản huỷ số 12',
        amount: 45_000n,
        branchIds: [A],
      }),
    ]);
  });

  it('confirm trả NCC làm nợ âm → 1002, không đổi tồn (ledger.apply không chạy), kiểm nợ sau khi khoá NCC', async () => {
    const { service, ledger, returnMoney } = makeService({
      findHead: jest.fn().mockResolvedValue(
        head(AdjustmentType.RETURN_TO_SUPPLIER, ReceiptStatus.DRAFT, {
          totalAmount: 45_000n,
          supplierId: 's1',
          supplierPaid: 0n,
        }),
      ),
      findItems: jest.fn().mockResolvedValue(disposeItems),
    });
    returnMoney.assertDebtStaysNonNegative.mockRejectedValue(
      new ErrorException({ code: ErrorCode.HTTP_BAD_REQUEST, message: 'Trả vượt công nợ hiện có với NCC' }),
    );
    await expect(service.confirm('adj1', PM_A)).rejects.toMatchObject({ errorCode: ErrorCode.HTTP_BAD_REQUEST });
    expect(ledger.apply).not.toHaveBeenCalled();
    expect(returnMoney.lockSupplierOf.mock.invocationCallOrder[0]).toBeLessThan(
      returnMoney.assertDebtStaysNonNegative.mock.invocationCallOrder[0],
    );
    expect(returnMoney.assertDebtStaysNonNegative).toHaveBeenCalledWith(expect.anything(), 'adj1');
  });

  it('confirm kiểm kê có chênh lệch → STOCK_ADJUSTMENT.CONFIRMED severity 1; khớp sổ → không nâng', async () => {
    const variance = makeService({
      findHead: jest.fn().mockResolvedValue(head(AdjustmentType.STOCK_TAKE)),
      findItems: jest
        .fn()
        .mockResolvedValue([
          { id: 'i1', batchId: 'b1', systemQuantity: 50, actualQuantity: 47, quantity: -3, reason: null },
        ]),
    });
    await variance.service.confirm('adj1', PM_A);
    const [, , varianceEntries] = variance.audit.record.mock.calls[0] as RecordCall;
    expect(varianceEntries[0]).toMatchObject({ event: 'STOCK_ADJUSTMENT.CONFIRMED', severity: 1, amount: 2100n });

    const balanced = makeService({
      findHead: jest.fn().mockResolvedValue(head(AdjustmentType.STOCK_TAKE)),
      findItems: jest
        .fn()
        .mockResolvedValue([
          { id: 'i1', batchId: 'b1', systemQuantity: 50, actualQuantity: 50, quantity: 0, reason: null },
        ]),
    });
    await balanced.service.confirm('adj1', PM_A);
    const [, , balancedEntries] = balanced.audit.record.mock.calls[0] as RecordCall;
    expect(balancedEntries[0]).toMatchObject({ event: 'STOCK_ADJUSTMENT.CONFIRMED' });
    expect(balancedEntries[0].severity).toBeUndefined();
  });

  it('lập phiếu huỷ ghi DISPOSAL.CREATED với lý do của phiếu, nhãn = mã phiếu', async () => {
    const { service, audit } = makeService();
    await service.create(create('DISPOSE', { quantity: 5 }) as never, PM_A);
    expect(audit.record).toHaveBeenCalledTimes(1);
    const [, , entries] = audit.record.mock.calls[0] as RecordCall;
    expect(entries).toEqual([
      expect.objectContaining({
        event: 'DISPOSAL.CREATED',
        entityId: 'adj1',
        entityLabel: 'DCK000001',
        branchIds: [A],
        searchTerms: ['DCK000001'],
        reason: 'Biên bản số 1',
        after: { code: 'DCK000001', type: 'DISPOSE', lines: 1 },
      }),
    ]);
  });

  it('lập phiếu khác (OTHER) ghi STOCK_ADJUSTMENT.CREATED', async () => {
    const { service, audit } = makeService();
    await service.create(create('OTHER', { quantity: 4 }) as never, PM_A);
    const [, , entries] = audit.record.mock.calls[0] as RecordCall;
    expect(entries[0]).toMatchObject({ event: 'STOCK_ADJUSTMENT.CREATED', reason: 'Biên bản số 1' });
  });

  it('huỷ phiếu huỷ hàng nháp ghi DISPOSAL.CANCELLED với lý do của lệnh huỷ', async () => {
    const { service, audit } = makeService({ findHead: jest.fn().mockResolvedValue(head(AdjustmentType.DISPOSE)) });
    await service.cancel('adj1', { reason: 'Lập nhầm' }, PM_A);
    const [, , entries] = audit.record.mock.calls[0] as RecordCall;
    expect(entries).toEqual([
      expect.objectContaining({
        event: 'DISPOSAL.CANCELLED',
        entityLabel: 'XH000001',
        reason: 'Lập nhầm',
        before: { status: 'DRAFT' },
        after: { status: 'CANCELLED' },
      }),
    ]);
  });

  it('huỷ phiếu trả NCC đã xác nhận ghi PURCHASE_RETURN.CANCELLED, amount = totalAmount, lý do lệnh huỷ', async () => {
    const { service, audit } = makeService({
      findHead: jest
        .fn()
        .mockResolvedValue(head(AdjustmentType.RETURN_TO_SUPPLIER, ReceiptStatus.CONFIRMED, { totalAmount: 45_000n })),
      findItems: jest.fn().mockResolvedValue([{ id: 'i1', batchId: 'b1', quantity: -3, unitCost: 700 }]),
    });
    await service.cancel('adj1', { reason: 'NCC không nhận' }, PM_A);
    const [, , entries] = audit.record.mock.calls[0] as RecordCall;
    expect(entries).toEqual([
      expect.objectContaining({
        event: 'PURCHASE_RETURN.CANCELLED',
        amount: 45_000n,
        reason: 'NCC không nhận',
        before: { status: 'CONFIRMED' },
        after: { status: 'CANCELLED' },
      }),
    ]);
  });
});
