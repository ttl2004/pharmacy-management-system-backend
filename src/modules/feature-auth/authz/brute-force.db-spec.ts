import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { createTestPrisma, resetSchema } from 'src/test-support/db-test';
import { SecurityEventService } from 'src/providers/security-event/security-event.service';
import { BruteForceDetector } from './brute-force.detector';

/** Race-safe thật trên Postgres: khoá advisory `brute-force:<actorId>` ép các lần check chạy nối tiếp. */
describe('BruteForceDetector (db)', () => {
  let prisma: PrismaClient;
  let detector: BruteForceDetector;
  const ctx = { ip: '1.1.1.1', userAgent: 'UA', requestId: null };

  beforeAll(async () => {
    prisma = await createTestPrisma();
    detector = new BruteForceDetector(prisma as never, new SecurityEventService(prisma as never));
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetSchema(prisma);
  });

  const failed = (actorId: string, n: number) =>
    prisma.securityEvent.createMany({
      data: Array.from({ length: n }, () => ({ type: 'AUTH.LOGIN_FAILED', outcome: 'FAILED', severity: 1, actorId })),
    });

  it('10 lần check song song (Promise.all) trên 10 dòng LOGIN_FAILED → đúng 1 dòng BRUTE_FORCE_SUSPECTED', async () => {
    const actorId = randomUUID();
    await failed(actorId, 10);
    const results = await Promise.all(Array.from({ length: 10 }, () => detector.check(actorId, 'SALES_STAFF', ctx)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await prisma.securityEvent.count({ where: { actorId, type: 'AUTH.BRUTE_FORCE_SUSPECTED' } })).toBe(1);
  });

  it('dưới ngưỡng không ghi; actor khác không bị tính chung', async () => {
    const a = randomUUID();
    const b = randomUUID();
    await failed(a, 9);
    await failed(b, 3);
    expect(await detector.check(a, null, ctx)).toBe(false);
    expect(await detector.check(b, null, ctx)).toBe(false);
    expect(await prisma.securityEvent.count({ where: { type: 'AUTH.BRUTE_FORCE_SUSPECTED' } })).toBe(0);
  });
});
