import { SalesRollupReconcileJob } from './sales-rollup.reconcile';

describe('SalesRollupReconcileJob', () => {
  const reconcile = { run: jest.fn() };
  const registry = { addCronJob: jest.fn() };
  const configOf = (values: Record<string, string>) => ({ get: (key: string) => values[key] });
  const make = (values: Record<string, string> = {}) =>
    new SalesRollupReconcileJob(reconcile as never, registry as never, configOf(values) as never);

  beforeEach(() => {
    jest.clearAllMocks();
    reconcile.run.mockResolvedValue({ id: 'run-1' });
  });

  it('reconcile gọi service.run(CRON, hôm qua → hôm nay theo giờ VN)', async () => {
    // 18:30 UTC ngày 4/11 = 01:30 ngày 5/11 giờ VN.
    await make().run(new Date('2026-11-04T18:30:00Z'));
    expect(reconcile.run).toHaveBeenCalledWith('CRON', null, '2026-11-04', '2026-11-05');
  });

  it('service lỗi (kể cả "đang chạy") → log, không ném ra ngoài', async () => {
    reconcile.run.mockRejectedValue(new Error('Đối soát đang chạy'));
    await expect(make().run(new Date('2026-11-04T18:30:00Z'))).resolves.toBeUndefined();
  });

  it('REPORT_RECONCILE_ENABLED=false → không đăng ký cron', () => {
    make({ REPORT_RECONCILE_ENABLED: 'false' }).onApplicationBootstrap();
    expect(registry.addCronJob).not.toHaveBeenCalled();
  });

  it('bật (mặc định) → đăng ký đúng một cron theo REPORT_RECONCILE_CRON', () => {
    const job = make({ REPORT_RECONCILE_CRON: '30 1 * * *' });
    job.onApplicationBootstrap();
    expect(registry.addCronJob).toHaveBeenCalledTimes(1);
    const cron = (registry.addCronJob.mock.calls as [string, unknown][])[0][1] as {
      stop: () => void;
      cronTime: { source: string };
    };
    expect(cron.cronTime.source).toBe('30 1 * * *');
    cron.stop();
  });
});
