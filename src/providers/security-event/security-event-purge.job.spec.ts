import { Logger } from '@nestjs/common';
import { SecurityEventPurgeJob } from './security-event-purge.job';

function make(counts: (number | Error)[]) {
  const queue = [...counts];
  const executeRaw = jest.fn().mockImplementation((query: unknown) => {
    // Lời gọi khoá advisory truyền Prisma.sql (không phải mảng template) — bỏ qua, không tính vào lô.
    if (!Array.isArray(query)) return Promise.resolve(0);
    const next = queue.shift() ?? 0;
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  const tx = { $executeRaw: executeRaw };
  const prisma = { $transaction: jest.fn((fn: (t: unknown) => unknown) => fn(tx)) };
  return { job: new SecurityEventPurgeJob(prisma as never), executeRaw, prisma };
}

describe('SecurityEventPurgeJob', () => {
  let log: jest.SpyInstance;
  let err: jest.SpyInstance;
  beforeEach(() => {
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    err = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('lặp tới khi gặp lô ngắn rồi ghi log tổng', async () => {
    const { job, prisma } = make([5000, 5000, 120]);
    await expect(job.purgeOldLoginEvents()).resolves.toBe(10120);
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('10120'));
  });

  it('dừng ở 200 lô dù lô nào cũng đầy', async () => {
    const { job, prisma } = make(Array(500).fill(5000) as number[]);
    await expect(job.purgeOldLoginEvents()).resolves.toBe(200 * 5000);
    expect(prisma.$transaction).toHaveBeenCalledTimes(200);
  });

  it('không có gì để xoá thì không log', async () => {
    const { job } = make([0]);
    await expect(job.purgeOldLoginEvents()).resolves.toBe(0);
    expect(log).not.toHaveBeenCalled();
  });

  it('lỗi được nuốt và ghi log, không ném ra', async () => {
    const { job } = make([5000, new Error('boom')]);
    await expect(job.purgeOldLoginEvents()).resolves.toBe(5000);
    expect(err).toHaveBeenCalled();
  });
});
