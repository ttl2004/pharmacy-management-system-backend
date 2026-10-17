import { ReceiptStatus, RecordStatus } from '@prisma/client';
import { AuthRole } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';
import { addDaysToDateOnly, parseDateOnly, todayInVietnam } from 'src/common/utils/date-only.util';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { GoodsReceiptService } from './goods-receipt.service';

const BRANCH_A = '11111111-1111-4111-8111-111111111111';
const BRANCH_B = '22222222-2222-4222-8222-222222222222';

function actor(role: AuthRole, branchId: string | null = null): RequestActor {
  return {
    user: { userId: `${role}-id`, sid: 's', email: null, role, branchId, roleLevel: 60 },
    ip: '127.0.0.1',
  };
}
const PM_A = actor(AuthRole.PHARMACY_MANAGER, BRANCH_A);
const ADMIN = actor(AuthRole.ADMIN);

const FAR = addDaysToDateOnly(todayInVietnam(), 400);
const line = (overrides: Record<string, unknown> = {}) => ({
  productId: 'p1',
  productUnitId: 'u-box',
  quantity: 2,
  importPrice: 10_000,
  batchNumber: 'L1',
  expiryDate: FAR,
  ...overrides,
});

function makeService(overrides: Record<string, jest.Mock> = {}) {
  const repository = {
    findBranch: jest.fn().mockResolvedValue({ id: BRANCH_A, status: RecordStatus.ACTIVE }),
    findSupplier: jest.fn().mockResolvedValue({ id: 's1', status: RecordStatus.ACTIVE }),
    findUnitsWithProduct: jest.fn().mockResolvedValue([
      {
        id: 'u-box',
        productId: 'p1',
        conversionRate: 10,
        status: RecordStatus.ACTIVE,
        isDeleted: false,
        product: { id: 'p1', status: RecordStatus.ACTIVE, isDeleted: false, code: 'SP1' },
      },
    ]),
    createHeader: jest.fn().mockResolvedValue({ id: 'r1' }),
    createItems: jest.fn().mockResolvedValue({ count: 1 }),
    findDetail: jest.fn().mockResolvedValue({ id: 'r1' }),
    findStatus: jest.fn(),
    transition: jest.fn().mockResolvedValue(1),
    findItemsForConfirm: jest.fn(),
    updateItemConversions: jest.fn(),
    findImportMovements: jest.fn(),
    findBatchesMovedSince: jest.fn(),
    softDeleteItems: jest.fn(),
    ...overrides,
  };
  const intake = {
    intake: jest.fn().mockResolvedValue({ batchIdByRefItem: new Map(), movements: [] }),
    withdraw: jest.fn().mockResolvedValue([]),
  };
  const transactions = { run: jest.fn((work: (ctx: unknown) => unknown) => work({ tx: {}, afterCommit: jest.fn() })) };
  const ledger = { apply: jest.fn().mockResolvedValue([]), lockBatches: jest.fn().mockResolvedValue([]) };
  const codes = { next: jest.fn().mockResolvedValue('PN000001') };
  const audit = { record: jest.fn() };
  const service = new GoodsReceiptService(
    repository as never,
    intake as never,
    transactions as never,
    ledger as never,
    codes as never,
    audit as never,
  );
  return { service, repository, ledger, audit, intake };
}

describe('GoodsReceiptService — lập phiếu', () => {
  it('PM không gửi branchId → phiếu thuộc chi nhánh của PM; server tự tính quy đổi và tiền', async () => {
    const { service, repository } = makeService();

    await service.create({ supplierId: 's1', items: [line()] } as never, PM_A);

    const [, header] = repository.createHeader.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(header).toMatchObject({
      branchId: BRANCH_A,
      subtotalAmount: 20_000n,
      totalAmount: 20_000n,
      code: 'PN000001',
    });
    const [, items] = repository.createItems.mock.calls[0] as [unknown, Record<string, unknown>[]];
    expect(items[0]).toMatchObject({ conversionRate: 10, baseQuantity: 20, totalPrice: 20_000n, receiptId: 'r1' });
  });

  it('PM gửi chi nhánh khác → 1506, không ghi gì', async () => {
    const { service, repository } = makeService();
    await expect(
      service.create({ branchId: BRANCH_B, supplierId: 's1', items: [line()] } as never, PM_A),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.BRANCH_ACCESS_DENIED },
    });
    expect(repository.createHeader).not.toHaveBeenCalled();
  });

  it('ADMIN bắt buộc chọn chi nhánh', async () => {
    const { service } = makeService();
    await expect(service.create({ supplierId: 's1', items: [line()] } as never, ADMIN)).rejects.toMatchObject({
      errorCode: ErrorCode.HTTP_BAD_REQUEST,
    });
  });

  it('đơn vị nhập không thuộc sản phẩm → 1602', async () => {
    const { service } = makeService();
    await expect(
      service.create({ supplierId: 's1', items: [line({ productId: 'p-khac' })] } as never, PM_A),
    ).rejects.toMatchObject({ errorCode: ErrorCode.INVALID_REFERENCE });
  });

  it('chi nhánh ngừng hoạt động → 1706; NCC ngừng → 1710', async () => {
    const inactiveBranch = makeService({
      findBranch: jest.fn().mockResolvedValue({ id: BRANCH_A, status: RecordStatus.INACTIVE }),
    });
    await expect(
      inactiveBranch.service.create({ supplierId: 's1', items: [line()] } as never, PM_A),
    ).rejects.toMatchObject({
      errorCode: ErrorCode.BRANCH_INACTIVE,
    });

    const inactiveSupplier = makeService({
      findSupplier: jest.fn().mockResolvedValue({ id: 's1', status: RecordStatus.INACTIVE }),
    });
    await expect(
      inactiveSupplier.service.create({ supplierId: 's1', items: [line()] } as never, PM_A),
    ).rejects.toMatchObject({ errorCode: ErrorCode.SUPPLIER_INACTIVE });
  });

  it('ngày sản xuất không trước hạn dùng → 1002', async () => {
    const { service } = makeService();
    await expect(
      service.create({ supplierId: 's1', items: [line({ manufacturingDate: FAR })] } as never, PM_A),
    ).rejects.toMatchObject({ errorCode: ErrorCode.HTTP_BAD_REQUEST });
  });
});

describe('GoodsReceiptService — xác nhận', () => {
  const head = {
    id: 'r1',
    status: ReceiptStatus.DRAFT,
    branchId: BRANCH_A,
    supplierId: 's1',
    receivedAt: null,
    totalAmount: 0n,
    paidAmount: 0n,
  };
  const confirmItem = {
    id: 'i1',
    productId: 'p1',
    quantity: 2,
    conversionRate: 10,
    importPrice: 10_000,
    batchNumber: 'L1',
    manufacturingDate: null,
    expiryDate: parseDateOnly(FAR),
    productUnit: {
      conversionRate: 12,
      status: RecordStatus.ACTIVE,
      isDeleted: false,
      product: { status: RecordStatus.ACTIVE, isDeleted: false, code: 'SP1' },
    },
  };

  it('người khác đã xác nhận trước (đổi trạng thái có điều kiện trả 0) → 1701, không đụng kho', async () => {
    const { service, ledger } = makeService({
      findStatus: jest.fn().mockResolvedValue(head),
      transition: jest.fn().mockResolvedValue(0),
    });
    await expect(service.confirm('r1', PM_A)).rejects.toMatchObject({ errorCode: ErrorCode.INVALID_DOCUMENT_STATE });
    expect(ledger.apply).not.toHaveBeenCalled();
  });

  it('K8: hệ số quy đổi lấy lúc xác nhận — ghi lại dòng, nhập đúng số viên mới, kèm cảnh báo', async () => {
    const { service, repository, intake } = makeService({
      findStatus: jest.fn().mockResolvedValue(head),
      findItemsForConfirm: jest.fn().mockResolvedValue([confirmItem]),
    });

    const result = await service.confirm('r1', PM_A);

    expect(repository.updateItemConversions).toHaveBeenCalledWith({}, [
      { id: 'i1', conversionRate: 12, baseQuantity: 24 },
    ]);
    const [, request] = intake.intake.mock.calls[0] as [unknown, { type: string; lines: Record<string, unknown>[] }];
    expect(request.type).toBe('IMPORT');
    expect(request.lines[0]).toMatchObject({ quantity: 24, unitCost: 833, supplierId: 's1', goodsReceiptItemId: 'i1' });
    expect(result.warnings[0]).toContain('hệ số quy đổi đã đổi');
  });

  it('lô hết hạn tính tới hôm xác nhận → 1702, không đưa hàng vào kho', async () => {
    const { service, intake } = makeService({
      findStatus: jest.fn().mockResolvedValue(head),
      findItemsForConfirm: jest
        .fn()
        .mockResolvedValue([{ ...confirmItem, expiryDate: parseDateOnly(todayInVietnam()) }]),
    });
    await expect(service.confirm('r1', PM_A)).rejects.toMatchObject({ errorCode: ErrorCode.BATCH_EXPIRED });
    expect(intake.intake).not.toHaveBeenCalled();
  });

  it('phiếu ngoài phạm vi → 1600 (truy vấn đã kèm điều kiện chi nhánh)', async () => {
    const findStatus = jest.fn().mockResolvedValue(null);
    const { service } = makeService({ findStatus });
    await expect(service.confirm('r1', PM_A)).rejects.toMatchObject({ errorCode: ErrorCode.RECORD_NOT_FOUND });
    expect(findStatus).toHaveBeenCalledWith({}, 'r1', { branchId: BRANCH_A });
  });
});

describe('GoodsReceiptService — huỷ', () => {
  it('phiếu đã xác nhận mà lô đã xuất → 1707, không đảo bút toán', async () => {
    const { service, ledger, intake } = makeService({
      findStatus: jest.fn().mockResolvedValue({ id: 'r1', status: ReceiptStatus.CONFIRMED, branchId: BRANCH_A }),
      findImportMovements: jest
        .fn()
        .mockResolvedValue([{ batchId: 'b1', quantity: 20, unitCost: 1000, refItemId: 'i1', createdAt: new Date() }]),
      findBatchesMovedSince: jest.fn().mockResolvedValue([{ batchId: 'b1' }]),
    });
    ledger.lockBatches.mockResolvedValue([{ id: 'b1', batchNumber: 'L1' }]);

    await expect(service.cancel('r1', { reason: 'sai' }, PM_A)).rejects.toMatchObject({
      errorCode: ErrorCode.BATCH_ALREADY_MOVED,
    });
    expect(intake.withdraw).not.toHaveBeenCalled();
  });

  it('phiếu đã xác nhận, lô chưa xuất: rút hàng qua intake (trả giá vốn) với lô đã khoá', async () => {
    const lockedRows = [{ id: 'b1', batchNumber: 'L1', quantityOnHand: 20, importPrice: 1000 }];
    const { service, ledger, intake } = makeService({
      findStatus: jest.fn().mockResolvedValue({ id: 'r1', status: ReceiptStatus.CONFIRMED, branchId: BRANCH_A }),
      findImportMovements: jest
        .fn()
        .mockResolvedValue([{ batchId: 'b1', quantity: 20, unitCost: 1000, refItemId: 'i1', createdAt: new Date() }]),
      findBatchesMovedSince: jest.fn().mockResolvedValue([]),
    });
    ledger.lockBatches.mockResolvedValue(lockedRows);

    await service.cancel('r1', { reason: 'Gõ nhầm giá' }, PM_A);

    expect(intake.withdraw).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        refId: 'r1',
        locked: lockedRows,
        lines: [{ batchId: 'b1', quantity: 20, unitCost: 1000, refItemId: 'i1' }],
      }),
    );
    expect(ledger.apply).not.toHaveBeenCalled();
  });

  it('phiếu nháp: chỉ đổi trạng thái, có lý do trong nhật ký', async () => {
    const { service, ledger, audit } = makeService({
      findStatus: jest.fn().mockResolvedValue({ id: 'r1', status: ReceiptStatus.DRAFT, branchId: BRANCH_A }),
    });
    await service.cancel('r1', { reason: 'Không nhập nữa' }, PM_A);
    expect(ledger.apply).not.toHaveBeenCalled();
    const [, entries] = audit.record.mock.calls[0] as [unknown, { reason: string }[]];
    expect(entries[0].reason).toBe('Không nhập nữa');
  });
});
