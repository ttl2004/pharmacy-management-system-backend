import { BatchStatus, RecordStatus, TransferStatus } from '@prisma/client';
import { AuthRole } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';
import { addDaysToDateOnly, parseDateOnly, todayInVietnam } from 'src/common/utils/date-only.util';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { transferWhere } from '../core/inventory-scope';
import { TransferService } from './transfer.service';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const actor = (role: AuthRole, branchId: string | null = null): RequestActor => ({
  user: { userId: `${role}-${branchId ?? 'all'}`, sid: 's', email: null, role, branchId, roleLevel: 60 },
  ip: null,
});
const PM_A = actor(AuthRole.PHARMACY_MANAGER, A);
const PM_B = actor(AuthRole.PHARMACY_MANAGER, B);
const FAR = parseDateOnly(addDaysToDateOnly(todayInVietnam(), 300));

const batch = (overrides: Record<string, unknown> = {}) => ({
  id: 'b1',
  branchId: A,
  productId: 'p1',
  batchNumber: 'L1',
  expiryDate: FAR,
  status: BatchStatus.AVAILABLE,
  quantityOnHand: 100,
  reservedQuantity: 0,
  importPrice: 900,
  ...overrides,
});

function makeService(overrides: Record<string, jest.Mock> = {}) {
  const repository = {
    findBranches: jest
      .fn()
      .mockImplementation((_tx: unknown, ids: string[]) =>
        Promise.resolve(ids.map((id) => ({ id, status: RecordStatus.ACTIVE }))),
      ),
    findBatches: jest.fn().mockResolvedValue([batch()]),
    createHeader: jest.fn().mockResolvedValue({ id: 't1' }),
    createItems: jest.fn(),
    findDetail: jest.fn().mockResolvedValue({ id: 't1' }),
    findHead: jest.fn(),
    transition: jest.fn().mockResolvedValue(1),
    findItems: jest.fn().mockResolvedValue([
      {
        id: 'i1',
        quantity: 30,
        batchId: 'b1',
        productId: 'p1',
        batch: { batchNumber: 'L1', manufacturingDate: null, expiryDate: FAR, supplierId: 's1' },
      },
    ]),
    findShipCosts: jest.fn().mockResolvedValue(new Map([['i1', 900]])),
    setToBatchIds: jest.fn(),
    ...overrides,
  };
  const transactions = { run: jest.fn((work: (ctx: unknown) => unknown) => work({ tx: {}, afterCommit: jest.fn() })) };
  const ledger = { apply: jest.fn().mockResolvedValue([]), lockBatches: jest.fn().mockResolvedValue([batch()]) };
  const intake = {
    intake: jest.fn().mockResolvedValue({ batchIdByRefItem: new Map([['i1', 'b-dest']]), movements: [] }),
    returnToBatches: jest.fn().mockResolvedValue([]),
  };
  const codes = { next: jest.fn().mockResolvedValue('DC000001') };
  const audit = { record: jest.fn() };
  const service = new TransferService(
    repository as never,
    transactions as never,
    ledger as never,
    intake as never,
    codes as never,
    audit as never,
  );
  return { service, repository, ledger, intake };
}

const pendingHead = { id: 't1', status: TransferStatus.PENDING, fromBranchId: A, toBranchId: B };
const transitHead = { ...pendingHead, status: TransferStatus.IN_TRANSIT };

describe('transferWhere — phạm vi hai chi nhánh', () => {
  it('đọc: gửi HOẶC nhận; xuất/huỷ: chỉ gửi; nhận: chỉ nhận; ADMIN: không lọc', () => {
    const scope = { kind: 'BRANCH' as const, branchId: A };
    expect(transferWhere(scope, 'either')).toEqual({ OR: [{ fromBranchId: A }, { toBranchId: A }] });
    expect(transferWhere(scope, 'from')).toEqual({ fromBranchId: A });
    expect(transferWhere(scope, 'to')).toEqual({ toBranchId: A });
    expect(transferWhere({ kind: 'ALL' }, 'from')).toEqual({});
  });
});

describe('TransferService — lập phiếu', () => {
  it('cùng chi nhánh → 1705', async () => {
    const { service } = makeService();
    await expect(
      service.create({ toBranchId: A, items: [{ batchId: 'b1', quantity: 1 }] }, PM_A),
    ).rejects.toMatchObject({
      errorCode: ErrorCode.TRANSFER_SAME_BRANCH,
    });
  });

  it('lô không thuộc chi nhánh gửi → 1602', async () => {
    const { service } = makeService({ findBatches: jest.fn().mockResolvedValue([batch({ branchId: B })]) });
    await expect(
      service.create({ toBranchId: B, items: [{ batchId: 'b1', quantity: 1 }] }, PM_A),
    ).rejects.toMatchObject({
      errorCode: ErrorCode.INVALID_REFERENCE,
    });
  });

  it('lô bị thu hồi → 1704; vượt tồn khả dụng → 1700', async () => {
    const recalled = makeService({
      findBatches: jest.fn().mockResolvedValue([batch({ status: BatchStatus.RECALLED })]),
    });
    await expect(
      recalled.service.create({ toBranchId: B, items: [{ batchId: 'b1', quantity: 1 }] }, PM_A),
    ).rejects.toMatchObject({
      errorCode: ErrorCode.BATCH_NOT_AVAILABLE,
    });
    const short = makeService({ findBatches: jest.fn().mockResolvedValue([batch({ reservedQuantity: 95 })]) });
    await expect(
      short.service.create({ toBranchId: B, items: [{ batchId: 'b1', quantity: 10 }] }, PM_A),
    ).rejects.toMatchObject({
      errorCode: ErrorCode.INSUFFICIENT_STOCK,
    });
  });

  it('chi nhánh nhận ngừng hoạt động → 1706', async () => {
    const { service } = makeService({
      findBranches: jest.fn().mockResolvedValue([
        { id: A, status: RecordStatus.ACTIVE },
        { id: B, status: RecordStatus.INACTIVE },
      ]),
    });
    await expect(
      service.create({ toBranchId: B, items: [{ batchId: 'b1', quantity: 1 }] }, PM_A),
    ).rejects.toMatchObject({
      errorCode: ErrorCode.BRANCH_INACTIVE,
    });
  });
});

describe('TransferService — xuất/nhận/huỷ theo đúng phía', () => {
  it('chi nhánh NHẬN bấm xuất hàng → 1506 (thấy phiếu nhưng sai phía)', async () => {
    const { service, ledger } = makeService({ findHead: jest.fn().mockResolvedValue(pendingHead) });
    await expect(service.ship('t1', PM_B)).rejects.toMatchObject({
      response: { code: ErrorCode.BRANCH_ACCESS_DENIED },
    });
    expect(ledger.apply).not.toHaveBeenCalled();
  });

  it('xuất: ghi TRANSFER_OUT âm với giá vốn của lô, dùng lô đã khoá', async () => {
    const { service, ledger } = makeService({ findHead: jest.fn().mockResolvedValue(pendingHead) });
    await service.ship('t1', PM_A);
    const [, entries, , options] = ledger.apply.mock.calls[0] as [
      unknown,
      Record<string, unknown>[],
      string,
      { preLocked: unknown },
    ];
    expect(entries[0]).toMatchObject({ type: 'TRANSFER_OUT', quantity: -30, unitCost: 900, refItemId: 'i1' });
    expect(options.preLocked).toBeDefined();
  });

  it('lô hết hạn trong lúc chờ xuất → 1704', async () => {
    const { service, ledger } = makeService({ findHead: jest.fn().mockResolvedValue(pendingHead) });
    ledger.lockBatches.mockResolvedValue([batch({ expiryDate: parseDateOnly(todayInVietnam()) })]);
    await expect(service.ship('t1', PM_A)).rejects.toMatchObject({ errorCode: ErrorCode.BATCH_NOT_AVAILABLE });
  });

  it('nhận: đưa vào lô cùng số ở chi nhánh nhận với giá chốt lúc xuất, NCC gốc; ghi toBatchId', async () => {
    const { service, intake, repository } = makeService({ findHead: jest.fn().mockResolvedValue(transitHead) });
    await service.receive('t1', PM_B);
    const [, request] = intake.intake.mock.calls[0] as [
      unknown,
      { branchId: string; type: string; lines: Record<string, unknown>[] },
    ];
    expect(request).toMatchObject({ branchId: B, type: 'TRANSFER_IN' });
    expect(request.lines[0]).toMatchObject({
      batchNumber: 'L1',
      quantity: 30,
      unitCost: 900,
      supplierId: 's1',
      goodsReceiptItemId: null,
    });
    expect(repository.setToBatchIds).toHaveBeenCalledWith(
      {},
      [{ itemId: 'i1', toBatchId: 'b-dest' }],
      PM_B.user.userId,
    );
  });

  it('nhận phiếu đã xuất mà thiếu giá vốn lúc xuất → báo lỗi, không âm thầm nhập với giá 0', async () => {
    const { service, intake } = makeService({
      findHead: jest.fn().mockResolvedValue(transitHead),
      findShipCosts: jest.fn().mockResolvedValue(new Map()),
    });
    await expect(service.receive('t1', PM_B)).rejects.toThrow('không có giá vốn lúc xuất');
    expect(intake.intake).not.toHaveBeenCalled();
  });

  it('chi nhánh GỬI bấm nhận → 1506', async () => {
    const { service } = makeService({ findHead: jest.fn().mockResolvedValue(transitHead) });
    await expect(service.receive('t1', PM_A)).rejects.toMatchObject({
      response: { code: ErrorCode.BRANCH_ACCESS_DENIED },
    });
  });

  it('K5: huỷ khi đang trên đường → hoàn về đúng lô gửi với giá chốt lúc xuất (giá vốn lô được tính lại)', async () => {
    const { service, intake } = makeService({ findHead: jest.fn().mockResolvedValue(transitHead) });
    await service.cancel('t1', { reason: 'xe hỏng' }, PM_A);
    const [, request] = intake.returnToBatches.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(request).toMatchObject({
      type: 'TRANSFER_IN',
      refId: 't1',
      lines: [{ batchId: 'b1', quantity: 30, unitCost: 900, refItemId: 'i1' }],
    });
  });

  it('huỷ phiếu đã nhận → 1701', async () => {
    const { service } = makeService({
      findHead: jest.fn().mockResolvedValue({ ...pendingHead, status: TransferStatus.RECEIVED }),
    });
    await expect(service.cancel('t1', { reason: 'x' }, PM_A)).rejects.toMatchObject({
      errorCode: ErrorCode.INVALID_DOCUMENT_STATE,
    });
  });
});
