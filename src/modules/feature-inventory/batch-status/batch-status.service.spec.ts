import { BatchStatus } from '@prisma/client';
import { AuthRole } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { InventoryEvents, StockChangedEvent } from '../core/inventory-events';
import type { AfterCommitHook } from '../core/inventory-transactions';
import { BatchStatusService } from './batch-status.service';

const A = '11111111-1111-4111-8111-111111111111';
const actor = (role: AuthRole, branchId: string | null): RequestActor => ({
  user: { userId: `${role}-id`, sid: 's', email: null, role, branchId, roleLevel: 60 },
  ip: '1.1.1.1',
});
const PM_A = actor(AuthRole.PHARMACY_MANAGER, A);
const ADMIN = actor(AuthRole.ADMIN, null);

function makeService(stockBatch: Record<string, jest.Mock>) {
  const hooks: AfterCommitHook[] = [];
  const transactions = {
    run: jest.fn((work: (ctx: unknown) => unknown) =>
      work({ tx: { stockBatch }, afterCommit: (hook: AfterCommitHook) => hooks.push(hook) }),
    ),
  };
  const events = new InventoryEvents();
  const emitted: StockChangedEvent[] = [];
  events.onStockChanged((event) => {
    emitted.push(event);
  });
  const audit = { record: jest.fn() };
  const service = new BatchStatusService(transactions as never, events, audit as never);
  const commit = async () => {
    for (const hook of hooks) await hook();
  };
  return { service, audit, emitted, commit };
}

describe('BatchStatusService.setStatus', () => {
  it('khoá mà không có lý do → 1002', async () => {
    const { service } = makeService({});
    await expect(service.setStatus('b1', { status: BatchStatus.QUARANTINE }, PM_A)).rejects.toMatchObject({
      errorCode: ErrorCode.HTTP_BAD_REQUEST,
    });
  });

  it('PM khoá lô chi nhánh khác → 1600 (điều kiện chi nhánh nằm trong truy vấn)', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const { service } = makeService({ findFirst });
    await expect(service.setStatus('b1', { status: BatchStatus.RECALLED, reason: 'QĐ 1' }, PM_A)).rejects.toMatchObject(
      {
        errorCode: ErrorCode.RECORD_NOT_FOUND,
      },
    );
    const [query] = findFirst.mock.calls[0] as [{ where: Record<string, unknown> }];
    expect(query.where).toMatchObject({ id: 'b1', branchId: A });
  });

  it('thu hồi: ghi người khoá, lý do, nhật ký; phát sự kiện tồn SAU commit', async () => {
    const update = jest.fn().mockResolvedValue({ id: 'b1', status: BatchStatus.RECALLED });
    const { service, audit, emitted, commit } = makeService({
      findFirst: jest.fn().mockResolvedValue({ id: 'b1', branchId: A, productId: 'p1', status: BatchStatus.AVAILABLE }),
      update,
    });

    await service.setStatus('b1', { status: BatchStatus.RECALLED, reason: 'QĐ 123/QLD' }, PM_A);

    const [recalled] = update.mock.calls[0] as [{ data: Record<string, unknown> }];
    expect(recalled.data).toMatchObject({
      status: 'RECALLED',
      blockedReason: 'QĐ 123/QLD',
      blockedBy: PM_A.user.userId,
    });
    const [, entries] = audit.record.mock.calls[0] as [unknown, Record<string, unknown>[]];
    expect(entries[0]).toMatchObject({
      action: 'STATUS_CHANGE',
      reason: 'QĐ 123/QLD',
      before: { status: 'AVAILABLE' },
    });
    expect(emitted).toHaveLength(0);
    await commit();
    expect(emitted[0]).toMatchObject({ branchId: A, productIds: ['p1'], refType: null });
  });

  it('mở khoá: xoá lý do và người khoá (lịch sử nằm ở nhật ký)', async () => {
    const update = jest.fn().mockResolvedValue({});
    const { service } = makeService({
      findFirst: jest
        .fn()
        .mockResolvedValue({ id: 'b1', branchId: A, productId: 'p1', status: BatchStatus.QUARANTINE }),
      update,
    });
    await service.setStatus('b1', { status: BatchStatus.AVAILABLE }, PM_A);
    const [reopened] = update.mock.calls[0] as [{ data: Record<string, unknown> }];
    expect(reopened.data).toMatchObject({ blockedReason: null, blockedAt: null, blockedBy: null });
  });
});

describe('BatchStatusService.recall', () => {
  it('ADMIN thu hồi theo số lô: không lọc chi nhánh, một dòng nhật ký mỗi lô', async () => {
    const findMany = jest.fn().mockResolvedValue([
      { id: 'b1', branchId: A, status: BatchStatus.AVAILABLE },
      { id: 'b2', branchId: 'B', status: BatchStatus.AVAILABLE },
    ]);
    const { service, audit } = makeService({ findMany, updateMany: jest.fn().mockResolvedValue({ count: 2 }) });

    const result = await service.recall(
      { productId: 'p1', batchNumber: 'L1', status: BatchStatus.RECALLED, reason: 'QĐ' },
      ADMIN,
    );

    expect(result.affected).toBe(2);
    const [query] = findMany.mock.calls[0] as [{ where: Record<string, unknown> }];
    expect(query.where).not.toHaveProperty('branchId');
    const [, entries] = audit.record.mock.calls[0] as [unknown, unknown[]];
    expect(entries).toHaveLength(2);
  });

  it('cách ly (QUARANTINE) không hạ cấp lô đã bị thu hồi (RECALLED) — giữ quyết định thu hồi', async () => {
    const findMany = jest.fn().mockResolvedValue([
      { id: 'b1', branchId: A, status: BatchStatus.RECALLED },
      { id: 'b2', branchId: A, status: BatchStatus.AVAILABLE },
    ]);
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const { service } = makeService({ findMany, updateMany });

    const result = await service.recall(
      { productId: 'p1', batchNumber: 'L1', status: BatchStatus.QUARANTINE, reason: 'nghi hỏng' },
      PM_A,
    );

    expect(result.batches).toEqual([{ id: 'b2', branchId: A }]);
    const [update] = updateMany.mock.calls[0] as [{ where: { id: { in: string[] } } }];
    expect(update.where.id.in).toEqual(['b2']);
  });

  it('bấm thu hồi lại khi mọi lô đã thu hồi → thành công, không đổi gì (không báo "không có lô")', async () => {
    const updateMany = jest.fn();
    const { service, audit } = makeService({
      findMany: jest.fn().mockResolvedValue([{ id: 'b1', branchId: A, status: BatchStatus.RECALLED }]),
      updateMany,
    });
    const result = await service.recall(
      { productId: 'p1', batchNumber: 'L1', status: BatchStatus.RECALLED, reason: 'QĐ' },
      PM_A,
    );
    expect(result).toEqual({ affected: 0, batches: [] });
    expect(updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('không có lô nào khớp trong phạm vi → 1600', async () => {
    const { service } = makeService({ findMany: jest.fn().mockResolvedValue([]) });
    await expect(
      service.recall({ productId: 'p1', batchNumber: 'L1', status: BatchStatus.RECALLED, reason: 'QĐ' }, PM_A),
    ).rejects.toMatchObject({ errorCode: ErrorCode.RECORD_NOT_FOUND });
  });
});
