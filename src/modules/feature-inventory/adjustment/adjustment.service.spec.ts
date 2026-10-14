import { AdjustmentType, BatchStatus, ReceiptStatus, RecordStatus } from '@prisma/client';
import { AuthRole } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { ADJUSTMENT_MOVEMENT_TYPE, AdjustmentService } from './adjustment.service';

const A = '11111111-1111-4111-8111-111111111111';
const PM_A: RequestActor = {
  user: { userId: 'pm-a', sid: 's', email: null, role: AuthRole.PHARMACY_MANAGER, branchId: A, roleLevel: 60 },
  ip: null,
};

function makeService(overrides: Record<string, jest.Mock> = {}) {
  const repository = {
    findBranch: jest.fn().mockResolvedValue({ id: A, status: RecordStatus.ACTIVE }),
    findSupplier: jest.fn().mockResolvedValue({ id: 's1' }),
    findBatches: jest
      .fn()
      .mockResolvedValue([{ id: 'b1', branchId: A, productId: 'p1', batchNumber: 'L1', quantityOnHand: 50 }]),
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
  const service = new AdjustmentService(
    repository as never,
    transactions as never,
    ledger as never,
    codes as never,
    audit as never,
  );
  return { service, repository, ledger, audit };
}

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

  it('lô không thuộc chi nhánh → 1602', async () => {
    const { service } = makeService({
      findBatches: jest.fn().mockResolvedValue([{ id: 'b1', branchId: 'khac', productId: 'p1', batchNumber: 'L1' }]),
    });
    await expect(service.create(create('DISPOSE', { quantity: 1 }) as never, PM_A)).rejects.toMatchObject({
      errorCode: ErrorCode.INVALID_REFERENCE,
    });
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

  it('phiếu đã xác nhận không huỷ được → 1701', async () => {
    const { service } = makeService({
      findHead: jest
        .fn()
        .mockResolvedValue({ id: 'adj1', status: ReceiptStatus.CONFIRMED, type: AdjustmentType.DISPOSE, branchId: A }),
    });
    await expect(service.cancel('adj1', { reason: 'x' }, PM_A)).rejects.toMatchObject({
      errorCode: ErrorCode.INVALID_DOCUMENT_STATE,
    });
  });
});

describe('AdjustmentService — giá trị tổn thất', () => {
  it('lossValue là số dương: huỷ 3 viên giá vốn 700 → 2100 đồng', async () => {
    const { service, audit } = makeService({
      findHead: jest
        .fn()
        .mockResolvedValue({ id: 'adj1', status: ReceiptStatus.DRAFT, type: AdjustmentType.DISPOSE, branchId: A }),
      findItems: jest
        .fn()
        .mockResolvedValue([
          { id: 'i1', batchId: 'b1', systemQuantity: null, actualQuantity: null, quantity: -3, reason: null },
        ]),
    });
    await service.confirm('adj1', PM_A);
    const [, entries] = audit.record.mock.calls[0] as [unknown, { after: { lossValue: number } }[]];
    expect(entries[0].after.lossValue).toBe(2100);
  });
});
