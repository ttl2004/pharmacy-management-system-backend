import { PrismaClient } from '@prisma/client';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { PrismaService } from 'src/common/databases/prisma.service';
import { SYSTEM_ACTOR_ID } from 'src/common/constants/app.constant';
import { ErrorCode } from 'src/common/types/error-code';
import { AuditLogService } from 'src/providers/audit-log/audit-log.service';
import { createTestPrisma, resetSchema } from 'src/test-support/db-test';
import { ReportBase, seedPaidOrder, seedReportBase } from 'src/test-support/report-db-seed';
import { ReconcileService } from './reconcile.service';
import { SalesRollupRepository } from './sales-rollup.repository';

const vn = (iso: string) => new Date(`${iso}+07:00`);

describe('đối soát doanh thu (db)', () => {
  let prisma: PrismaClient;
  let base: ReportBase;
  let adminId: string;
  const repo = new SalesRollupRepository();
  let service: ReconcileService;

  beforeAll(async () => {
    prisma = await createTestPrisma();
    service = new ReconcileService(prisma as unknown as PrismaService, repo, new AuditLogService());
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetSchema(prisma);
    base = await seedReportBase(prisma);
    const role = await prisma.role.create({ data: { code: 'ADMIN', name: 'Quản trị', level: 90 } });
    // Audit có khoá ngoại tới users: cần tác nhân hệ thống (cron) và một ADMIN (bấm tay).
    await prisma.user.create({ data: { id: SYSTEM_ACTOR_ID, fullName: 'Hệ thống', roleId: role.id } });
    adminId = (await prisma.user.create({ data: { fullName: 'Admin', roleId: role.id } })).id;
  });

  const seedOrder = async () => {
    const order = await seedPaidOrder(prisma, base, {
      branch: 0,
      completedAt: vn('2026-11-01T09:00:00'),
      lines: [{ product: 0, qty: 2, unitPrice: 10000, unitCost: 4000 }],
    });
    await prisma.$transaction((tx) => repo.applyOrder(tx, order.id, 1, order.total));
    return order;
  };
  const rebuild = () => prisma.$transaction((tx) => repo.rebuild(tx, '2026-11-01', '2026-11-02'));

  it('sổ phụ bị sửa tay lệch 1 đơn → rebuild trả mismatchCount ≥ 1 với stored/expected đúng, rồi sổ phụ được sửa đúng', async () => {
    const order = await seedOrder();
    await prisma.$executeRaw`UPDATE sales_daily SET "orderCount" = 0, "revenue" = 1000 WHERE "date" = '2026-11-01'`;
    const result = await rebuild();
    expect(result.mismatchCount).toBeGreaterThanOrEqual(1);
    expect(result.mismatches[0]).toMatchObject({
      table: 'sales_daily',
      branchId: base.branches[0].id,
      date: '2026-11-01',
      channel: 'POS',
      stored: { orderCount: 0, revenue: 1000 },
      expected: { orderCount: 1, revenue: Number(order.total) },
    });
    const [row] = await prisma.$queryRaw<{ orderCount: number; revenue: bigint }[]>`
      SELECT "orderCount", "revenue" FROM sales_daily WHERE "date" = '2026-11-01'`;
    expect(row).toMatchObject({ orderCount: 1, revenue: order.total });
  });

  it('bảng sản phẩm lệch → đếm số dòng và tổng chênh lệch theo (bảng, ngày)', async () => {
    await seedOrder();
    await prisma.$executeRaw`UPDATE sales_daily_product SET "qtyBase" = "qtyBase" + 5, "revenue" = "revenue" - 100`;
    const result = await rebuild();
    expect(result.mismatches).toContainEqual({
      table: 'sales_daily_product',
      date: '2026-11-01',
      rowCount: 1,
      qtyBaseDiff: -5,
      revenueDiff: 100,
      cogsAmountDiff: 0,
    });
  });

  it('không lệch → mismatchCount 0, mismatches []', async () => {
    await seedOrder();
    const result = await rebuild();
    expect(result.mismatchCount).toBe(0);
    expect(result.mismatches).toEqual([]);
  });

  it('hai lần chạy cùng lúc (cron + tay) → lần sau bị từ chối "Đối soát đang chạy", không có 2 dòng RUNNING', async () => {
    // Giữ khoá toàn cục của đối soát như một lần chạy đang bắt đầu.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => (locked = r));
    const holder = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('sales-reconcile', 0))`;
      locked();
      await held;
    });
    await lockedP;
    await expect(service.run('MANUAL', null, '2026-11-01', '2026-11-02')).rejects.toMatchObject({
      errorCode: ErrorCode.HTTP_BAD_REQUEST,
      message: 'Đối soát đang chạy',
    });
    release();
    await holder;

    // Có dòng RUNNING còn mới → cũng từ chối.
    await prisma.salesReconcileRun.create({
      data: { trigger: 'CRON', fromDate: new Date('2026-11-01'), toDate: new Date('2026-11-02'), status: 'RUNNING' },
    });
    await expect(service.run('CRON', null, '2026-11-01', '2026-11-02')).rejects.toMatchObject({
      message: 'Đối soát đang chạy',
    });
    expect(await prisma.salesReconcileRun.count({ where: { status: 'RUNNING' } })).toBe(1);
  });

  it('chạy đồng thời hai lần → không bao giờ có 2 dòng RUNNING và có ít nhất 1 lần thành công', async () => {
    const results = await Promise.allSettled([
      service.run('CRON', null, '2026-11-01', '2026-11-02'),
      service.run(
        'MANUAL',
        { user: { userId: adminId, role: 'ADMIN' } } as unknown as RequestActor,
        '2026-11-01',
        '2026-11-02',
      ),
    ]);
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    expect(await prisma.salesReconcileRun.count({ where: { status: 'RUNNING' } })).toBe(0);
  });

  it('chạy lệch: run SUCCESS có mismatches, audit REPORT.RECONCILE_MISMATCH ghi trong cùng giao dịch', async () => {
    await seedOrder();
    await prisma.$executeRaw`UPDATE sales_daily SET "revenue" = 1 WHERE "date" = '2026-11-01'`;
    const run = await service.run('CRON', null, '2026-11-01', '2026-11-02');
    expect(run.status).toBe('SUCCESS');
    expect(run.mismatchCount).toBeGreaterThanOrEqual(1);
    const logs = await prisma.auditLog.findMany({ where: { event: 'REPORT.RECONCILE_MISMATCH' } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ entityId: run.id, severity: 2, entityType: 'sales_reconcile_runs' });
    expect(logs[0].branchIds).toEqual([base.branches[0].id]);
  });
});
