import { BruteForceDetector } from './brute-force.detector';

const CTX = { ip: '1.1.1.1', userAgent: 'UA', requestId: null };

function make(failed: number, suspected: number) {
  const count = jest.fn(({ where }: { where: { type: string } }) =>
    Promise.resolve(where.type === 'AUTH.LOGIN_FAILED' ? failed : suspected),
  );
  const tx = { $executeRaw: jest.fn().mockResolvedValue(0), securityEvent: { count } };
  const prisma = { $transaction: jest.fn((work: (t: unknown) => unknown) => work(tx)) };
  const security = { record: jest.fn().mockResolvedValue(undefined) };
  return { detector: new BruteForceDetector(prisma as never, security as never), tx, security, count };
}

describe('BruteForceDetector.check', () => {
  it('9 lần → false, không ghi', async () => {
    const { detector, security } = make(9, 0);
    await expect(detector.check('u1', 'SALES_STAFF', CTX)).resolves.toBe(false);
    expect(security.record).not.toHaveBeenCalled();
  });

  it('10 lần → true và ghi 1 dòng BRUTE_FORCE_SUSPECTED (sev 2) trong cùng tx, sau khi giữ khoá', async () => {
    const { detector, security, tx } = make(10, 0);
    await expect(detector.check('u1', 'SALES_STAFF', CTX)).resolves.toBe(true);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(security.record).toHaveBeenCalledTimes(1);
    const [events, client] = security.record.mock.calls[0] as [Record<string, unknown>[], unknown];
    expect(client).toBe(tx);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'AUTH.BRUTE_FORCE_SUSPECTED',
        actorId: 'u1',
        actorRoleCode: 'SALES_STAFF',
        metadata: { count: 10, windowMinutes: 15 },
      }),
    ]);
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(security.record.mock.invocationCallOrder[0]);
  });

  it('đã có BRUTE_FORCE_SUSPECTED trong 15 phút → không ghi thêm', async () => {
    const { detector, security } = make(25, 1);
    await expect(detector.check('u1', 'SALES_STAFF', CTX)).resolves.toBe(false);
    expect(security.record).not.toHaveBeenCalled();
  });

  it('cửa sổ tính từ now truyền vào', async () => {
    const { detector, count } = make(0, 0);
    const now = new Date('2026-11-04T08:00:00Z');
    await detector.check('u1', null, CTX, now);
    expect(count.mock.calls[0][0]).toMatchObject({
      where: { actorId: 'u1', createdAt: { gte: new Date('2026-11-04T07:45:00Z') } },
    });
  });
});
