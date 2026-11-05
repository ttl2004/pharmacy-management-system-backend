import { SalesRollupReconcileJob } from './sales-rollup.reconcile';

describe('SalesRollupReconcileJob', () => {
  const tx = {};
  const prisma = { $transaction: jest.fn((work: (t: typeof tx) => unknown) => work(tx)) };
  const rollup = { rebuild: jest.fn() };
  const job = new SalesRollupReconcileJob(prisma as never, rollup as never);

  beforeEach(() => {
    jest.clearAllMocks();
    rollup.rebuild.mockResolvedValue({ days: 2, rows: 40 });
  });

  it('reconcile gọi rebuild(hôm qua, hôm nay theo giờ VN)', async () => {
    // 18:30 UTC ngày 4/11 = 01:30 ngày 5/11 giờ VN.
    await job.run(new Date('2026-11-04T18:30:00Z'));
    expect(rollup.rebuild).toHaveBeenCalledWith(tx, '2026-11-04', '2026-11-05');
  });

  it('rebuild lỗi → log, không ném ra ngoài', async () => {
    rollup.rebuild.mockRejectedValue(new Error('db chết'));
    await expect(job.run(new Date('2026-11-04T18:30:00Z'))).resolves.toBeUndefined();
  });
});
