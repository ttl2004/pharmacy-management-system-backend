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
const KEY = { productId: 'p1', batchNumber: 'L1' };

const stored = (status: BatchStatus) => ({ id: 'b1', branchId: A, productId: 'p1', batchNumber: 'L1', status });

/** `stockBatch`: các hàm Prisma setStatus gọi; `byNumber`: các lô `recall` khoá được theo số lô. */
function makeService(stockBatch: Record<string, jest.Mock>, byNumber: unknown[] = []) {
  const hooks: AfterCommitHook[] = [];
  const transactions = {
    run: jest.fn((work: (ctx: unknown) => unknown) =>
      work({ tx: { stockBatch }, afterCommit: (hook: AfterCommitHook) => hooks.push(hook) }),
    ),
  };
  const batches = {
    lockBatchNumbers: jest.fn(),
    lockByBatchNumber: jest.fn().mockResolvedValue(byNumber),
  };
  const events = new InventoryEvents();
  const emitted: StockChangedEvent[] = [];
  events.onStockChanged((event) => {
    emitted.push(event);
  });
  const audit = { record: jest.fn() };
  const service = new BatchStatusService(transactions as never, batches as never, events, audit as never);
  const commit = async () => {
    for (const hook of hooks) await hook();
  };
  return { service, batches, audit, emitted, commit };
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

  it('thu hồi: chỉ ghi khi lô còn ở trạng thái vừa đọc; ghi người khoá, lý do, nhật ký; sự kiện SAU commit', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const { service, audit, emitted, commit } = makeService({
      findFirst: jest.fn().mockResolvedValue(stored(BatchStatus.AVAILABLE)),
      updateMany,
    });

    const result = await service.setStatus('b1', { status: BatchStatus.RECALLED, reason: 'QĐ 123/QLD' }, PM_A);

    const [recalled] = updateMany.mock.calls[0] as [{ where: unknown; data: Record<string, unknown> }];
    expect(recalled.where).toEqual({ id: 'b1', status: 'AVAILABLE', isDeleted: false });
    expect(recalled.data).toMatchObject({
      status: 'RECALLED',
      blockedReason: 'QĐ 123/QLD',
      blockedBy: PM_A.user.userId,
    });
    expect(result).toMatchObject({ id: 'b1', status: 'RECALLED', blockedReason: 'QĐ 123/QLD' });
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
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const { service } = makeService({
      findFirst: jest.fn().mockResolvedValue(stored(BatchStatus.QUARANTINE)),
      updateMany,
    });
    await service.setStatus('b1', { status: BatchStatus.AVAILABLE }, PM_A);
    const [reopened] = updateMany.mock.calls[0] as [{ data: Record<string, unknown> }];
    expect(reopened.data).toMatchObject({ blockedReason: null, blockedAt: null, blockedBy: null });
  });

  it.each([BatchStatus.AVAILABLE, BatchStatus.QUARANTINE])(
    'PM gỡ lô đã thu hồi về %s → 1712, không ghi gì',
    async (status) => {
      const updateMany = jest.fn();
      const { service } = makeService({
        findFirst: jest.fn().mockResolvedValue(stored(BatchStatus.RECALLED)),
        updateMany,
      });
      await expect(service.setStatus('b1', { status, reason: 'nhầm' }, PM_A)).rejects.toMatchObject({
        errorCode: ErrorCode.RECALL_ADMIN_ONLY,
      });
      expect(updateMany).not.toHaveBeenCalled();
    },
  );

  it.each([BatchStatus.AVAILABLE, BatchStatus.QUARANTINE])('ADMIN gỡ được lô đã thu hồi về %s', async (status) => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const { service } = makeService({
      findFirst: jest.fn().mockResolvedValue(stored(BatchStatus.RECALLED)),
      updateMany,
    });
    await service.setStatus('b1', { status, reason: 'QĐ huỷ thu hồi' }, ADMIN);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'b1', status: 'RECALLED', isDeleted: false } }),
    );
  });

  it('thu hồi lẻ giữ khoá số lô trước khi ghi (như thu hồi theo số lô); cách ly thì không cần', async () => {
    const recall = makeService({
      findFirst: jest.fn().mockResolvedValue(stored(BatchStatus.AVAILABLE)),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    });
    await recall.service.setStatus('b1', { status: BatchStatus.RECALLED, reason: 'QĐ' }, PM_A);
    expect(recall.batches.lockBatchNumbers).toHaveBeenCalledWith(expect.anything(), [expect.objectContaining(KEY)]);

    const quarantine = makeService({
      findFirst: jest.fn().mockResolvedValue(stored(BatchStatus.AVAILABLE)),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    });
    await quarantine.service.setStatus('b1', { status: BatchStatus.QUARANTINE, reason: 'nghi hỏng' }, PM_A);
    expect(quarantine.batches.lockBatchNumbers).not.toHaveBeenCalled();
  });

  it('lô vừa bị request khác đổi trạng thái (0 dòng khớp) → 1006, không ghi nhật ký', async () => {
    const { service, audit } = makeService({
      findFirst: jest.fn().mockResolvedValue(stored(BatchStatus.AVAILABLE)),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    });
    await expect(
      service.setStatus('b1', { status: BatchStatus.QUARANTINE, reason: 'nghi hỏng' }, PM_A),
    ).rejects.toMatchObject({ errorCode: ErrorCode.HTTP_CONFLICT });
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('BatchStatusService.recall', () => {
  it('ADMIN thu hồi theo số lô: khoá số lô, không lọc chi nhánh, một dòng nhật ký mỗi lô', async () => {
    const { service, batches, audit } = makeService({ updateMany: jest.fn().mockResolvedValue({ count: 2 }) }, [
      { id: 'b1', branchId: A, status: BatchStatus.AVAILABLE },
      { id: 'b2', branchId: 'B', status: BatchStatus.AVAILABLE },
    ]);

    const result = await service.recall({ ...KEY, status: BatchStatus.RECALLED, reason: 'QĐ' }, ADMIN);

    expect(result.affected).toBe(2);
    expect(batches.lockBatchNumbers).toHaveBeenCalledWith(expect.anything(), [KEY]);
    expect(batches.lockByBatchNumber).toHaveBeenCalledWith(expect.anything(), KEY, undefined);
    expect(batches.lockBatchNumbers.mock.invocationCallOrder[0]).toBeLessThan(
      batches.lockByBatchNumber.mock.invocationCallOrder[0],
    );
    const [, entries] = audit.record.mock.calls[0] as [unknown, unknown[]];
    expect(entries).toHaveLength(2);
  });

  it('cách ly (QUARANTINE) không hạ cấp lô đã bị thu hồi (RECALLED) — giữ quyết định thu hồi', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const { service, batches } = makeService({ updateMany }, [
      { id: 'b1', branchId: A, status: BatchStatus.RECALLED },
      { id: 'b2', branchId: A, status: BatchStatus.AVAILABLE },
    ]);

    const result = await service.recall({ ...KEY, status: BatchStatus.QUARANTINE, reason: 'nghi hỏng' }, PM_A);

    expect(batches.lockByBatchNumber).toHaveBeenCalledWith(expect.anything(), KEY, A);
    expect(result.batches).toEqual([{ id: 'b2', branchId: A }]);
    const [update] = updateMany.mock.calls[0] as [{ where: { id: { in: string[] } } }];
    expect(update.where.id.in).toEqual(['b2']);
  });

  it('bấm thu hồi lại khi mọi lô đã thu hồi → thành công, không đổi gì (không báo "không có lô")', async () => {
    const updateMany = jest.fn();
    const { service, audit } = makeService({ updateMany }, [{ id: 'b1', branchId: A, status: BatchStatus.RECALLED }]);
    const result = await service.recall({ ...KEY, status: BatchStatus.RECALLED, reason: 'QĐ' }, PM_A);
    expect(result).toEqual({ affected: 0, batches: [] });
    expect(updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('không có lô nào khớp trong phạm vi → 1600', async () => {
    const { service } = makeService({}, []);
    await expect(service.recall({ ...KEY, status: BatchStatus.RECALLED, reason: 'QĐ' }, PM_A)).rejects.toMatchObject({
      errorCode: ErrorCode.RECORD_NOT_FOUND,
    });
  });
});
