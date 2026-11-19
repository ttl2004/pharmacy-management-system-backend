import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { createTestPrisma, resetSchema } from 'src/test-support/db-test';
import { SecurityEventPurgeJob } from './security-event-purge.job';

const DAY = 86400000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

/** Trigger security_events chỉ cho xoá sự kiện đăng nhập > 180 ngày; job dọn chạy KHÔNG bật app.audit_maintenance. */
describe('dọn sự kiện đăng nhập cũ (db)', () => {
  let prisma: PrismaClient;
  let job: SecurityEventPurgeJob;

  beforeAll(async () => {
    prisma = await createTestPrisma();
    job = new SecurityEventPurgeJob(prisma as never);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetSchema(prisma);
  });

  async function ev(type: string, days: number, outcome = 'SUCCESS'): Promise<string> {
    const id = randomUUID();
    await prisma.securityEvent.create({ data: { id, type, outcome, createdAt: ago(days) } });
    return id;
  }
  const exists = async (id: string) => (await prisma.securityEvent.count({ where: { id } })) === 1;

  it('xoá đăng nhập cũ, giữ đăng nhập mới và loại khác dù cũ', async () => {
    const oldOk = await ev('AUTH.LOGIN_OK', 200);
    const oldFailed = await ev('AUTH.LOGIN_FAILED', 200, 'FAILED');
    const oldBurst = await ev('AUTH.LOGIN_FAILED_BURST', 200, 'DENIED');
    const recentOk = await ev('AUTH.LOGIN_OK', 10);
    const oldPwd = await ev('AUTH.PASSWORD_CHANGED', 200);

    await expect(job.purgeOldLoginEvents()).resolves.toBe(3);

    expect(await exists(oldOk)).toBe(false);
    expect(await exists(oldFailed)).toBe(false);
    expect(await exists(oldBurst)).toBe(false);
    expect(await exists(recentOk)).toBe(true);
    expect(await exists(oldPwd)).toBe(true);
  });

  it('trigger: DELETE trực tiếp chỉ qua với đăng nhập > 180 ngày', async () => {
    const oldPwd = await ev('AUTH.PASSWORD_CHANGED', 200);
    const recentOk = await ev('AUTH.LOGIN_OK', 10);
    const oldOk = await ev('AUTH.LOGIN_OK', 200);
    await expect(prisma.$executeRaw`DELETE FROM "security_events" WHERE "id" = ${oldPwd}::uuid`).rejects.toThrow(
      /append-only/,
    );
    await expect(prisma.$executeRaw`DELETE FROM "security_events" WHERE "id" = ${recentOk}::uuid`).rejects.toThrow(
      /append-only/,
    );
    await expect(
      prisma.$executeRaw`UPDATE "security_events" SET "severity" = 2 WHERE "id" = ${oldOk}::uuid`,
    ).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRaw`DELETE FROM "security_events" WHERE "id" = ${oldOk}::uuid`).resolves.toBe(1);
  });

  it('audit_logs vẫn bất biến', async () => {
    const role = await prisma.role.create({ data: { code: 'ADMIN', name: 'Quản trị', level: 90 } });
    const actor = await prisma.user.create({ data: { fullName: 'Người dùng', roleId: role.id } });
    await prisma.auditLog.create({
      data: {
        actorId: actor.id,
        action: 'CREATE',
        event: 'ORDER.CREATED',
        entityType: 'orders',
        entityId: randomUUID(),
        createdAt: ago(400),
      },
    });
    await expect(prisma.$executeRawUnsafe(`DELETE FROM audit_logs`)).rejects.toThrow(/append-only/);
    expect(await prisma.auditLog.count()).toBe(1);
  });
});
