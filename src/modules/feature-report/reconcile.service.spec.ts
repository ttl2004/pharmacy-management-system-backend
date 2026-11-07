import { ErrorCode } from 'src/common/types/error-code';
import { ReconcileService } from './reconcile.service';

describe('ReconcileService (unit)', () => {
  const tx = {
    salesReconcileRun: { updateMany: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
    $queryRaw: jest.fn(),
  };
  const prisma = {
    $transaction: jest.fn((work: (t: typeof tx) => unknown) => work(tx)),
    salesReconcileRun: tx.salesReconcileRun,
  };
  const rollup = { rebuild: jest.fn() };
  const audit = { record: jest.fn() };
  const service = new ReconcileService(prisma as never, rollup as never, audit as never);
  const BRANCH = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => {
    jest.clearAllMocks();
    tx.$queryRaw.mockResolvedValue([{ locked: true }]);
    tx.salesReconcileRun.findFirst.mockResolvedValue(null);
    tx.salesReconcileRun.updateMany.mockResolvedValue({ count: 0 });
    tx.salesReconcileRun.create.mockResolvedValue({ id: 'run-1', status: 'RUNNING' });
    tx.salesReconcileRun.update.mockImplementation(({ data }) => Promise.resolve({ id: 'run-1', ...data }));
    rollup.rebuild.mockResolvedValue({ days: 2, rows: 4, mismatchCount: 0, mismatches: [], branchIds: [] });
  });

  it('lệch → ghi audit REPORT.RECONCILE_MISMATCH sev 2 + run SUCCESS', async () => {
    rollup.rebuild.mockResolvedValue({
      days: 2,
      rows: 4,
      mismatchCount: 1,
      mismatches: [{ table: 'sales_daily', branchId: BRANCH }],
      branchIds: [BRANCH],
    });
    const run = await service.run('CRON', null, '2026-11-04', '2026-11-05');
    expect(run).toMatchObject({ status: 'SUCCESS', mismatchCount: 1 });
    const entries = (audit.record.mock.calls as [unknown, unknown, Record<string, unknown>[]][]).flatMap((c) => c[2]);
    expect(entries).toContainEqual(
      expect.objectContaining({ event: 'REPORT.RECONCILE_MISMATCH', entityId: 'run-1', branchIds: [BRANCH] }),
    );
  });

  it('không lệch → không ghi audit', async () => {
    await service.run('CRON', null, '2026-11-04', '2026-11-05');
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('lỗi → run FAILED với errorMessage, không ném lỗi', async () => {
    rollup.rebuild.mockRejectedValue(new Error('db chết'));
    const run = await service.run('CRON', null, '2026-11-04', '2026-11-05');
    expect(run).toMatchObject({ status: 'FAILED', errorMessage: 'db chết' });
  });

  it('RUNNING cũ > 1 giờ được đánh dấu FAILED khi lần mới bắt đầu', async () => {
    await service.run('CRON', null, '2026-11-04', '2026-11-05');
    const arg = (
      tx.salesReconcileRun.updateMany.mock.calls as [
        { where: { status: string; startedAt: { lt: Date } }; data: Record<string, unknown> },
      ][]
    )[0][0];
    expect(arg.where.status).toBe('RUNNING');
    expect(arg.where.startedAt.lt).toBeInstanceOf(Date);
    expect(arg.data.status).toBe('FAILED');
    expect(String(arg.data.errorMessage)).toContain('bị ngắt giữa chừng');
  });

  it('không lấy được khoá, hoặc đã có RUNNING → 1002 "Đối soát đang chạy"', async () => {
    tx.$queryRaw.mockResolvedValue([{ locked: false }]);
    await expect(service.run('CRON', null, '2026-11-04', '2026-11-05')).rejects.toMatchObject({
      errorCode: ErrorCode.HTTP_BAD_REQUEST,
      message: 'Đối soát đang chạy',
    });
    tx.$queryRaw.mockResolvedValue([{ locked: true }]);
    tx.salesReconcileRun.findFirst.mockResolvedValue({ id: 'other' });
    await expect(service.run('CRON', null, '2026-11-04', '2026-11-05')).rejects.toMatchObject({
      message: 'Đối soát đang chạy',
    });
    expect(rollup.rebuild).not.toHaveBeenCalled();
  });
});
