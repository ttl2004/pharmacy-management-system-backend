import { PrismaClient } from '@prisma/client';
import {
  applyMigrationFile,
  applyMigrationsUntil,
  buildTestDatabaseUrl,
  createTestPrisma,
} from 'src/test-support/db-test';
import { ReportBase, seedPaidOrder, seedReportBase } from 'src/test-support/report-db-seed';
import { SalesRollupRepository } from './sales-rollup.repository';

const SCHEMA = 'legacy_refund_db';
const MIGRATION = 'bo_sung_luot_hoan_don_huy_cu';
const vn = (iso: string) => new Date(`${iso}+07:00`);
const line = (unitPrice: number) => [{ product: 0, qty: 2, unitPrice, unitCost: 400 }];

describe('migration bo_sung_luot_hoan_don_huy_cu', () => {
  let admin: PrismaClient;
  let db: PrismaClient;
  let base: ReportBase;
  const repo = new SalesRollupRepository();
  const completedAt = vn('2026-11-03T20:59:00');
  let legacyId: string;
  let zeroId: string;
  let correctId: string;

  beforeAll(async () => {
    admin = await createTestPrisma();
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${SCHEMA}"`);
    await applyMigrationsUntil(admin, SCHEMA, MIGRATION);
    db = new PrismaClient({ datasources: { db: { url: buildTestDatabaseUrl(SCHEMA) } } });
    await db.$connect();
    base = await seedReportBase(db);
    // Đơn huỷ kiểu cũ: chỉ có dòng PAYMENT, không có REFUND.
    legacyId = (await seedPaidOrder(db, base, { branch: 0, completedAt, lines: line(10000), voidedRefund: 0n })).id;
    // Đơn 0đ huỷ: không có dòng thu nào.
    zeroId = (await seedPaidOrder(db, base, { branch: 0, completedAt, lines: line(0), voidedRefund: 0n })).id;
    // Đơn huỷ đã có REFUND đúng.
    correctId = (await seedPaidOrder(db, base, { branch: 0, completedAt, lines: line(5000), voidedRefund: 10000n })).id;
    await db.$executeRaw`UPDATE orders SET "cancelledAt" = ${vn('2026-11-03T21:00:00')} WHERE id = ${legacyId}::uuid`;
    // Sổ phụ dựng theo quy tắc cũ: đơn huỷ-thiếu-hoàn đang tính đủ 20.000đ.
    await db.$transaction((tx) => repo.rebuild(tx, '2026-11-03', '2026-11-03'));
  });

  afterAll(async () => {
    await db?.$disconnect();
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await admin.$disconnect();
  });

  const refunds = (orderId: string) => db.payment.findMany({ where: { orderId, kind: 'REFUND' } });

  it('trước migration: sổ phụ tính thừa 20.000đ cho đơn huỷ cũ', async () => {
    const [row] = await db.$queryRaw<
      { revenue: bigint }[]
    >`SELECT revenue FROM sales_daily WHERE "date" = '2026-11-03'`;
    expect(row.revenue).toBe(20000n);
    expect(await refunds(legacyId)).toHaveLength(0);
  });

  it('áp migration: đơn huỷ cũ có đúng 1 dòng REFUND, đơn 0đ không có, đơn đã đúng không bị đụng', async () => {
    const correctBefore = await refunds(correctId);
    applyMigrationFile(SCHEMA, MIGRATION);

    const legacy = await refunds(legacyId);
    expect(legacy).toHaveLength(1);
    expect(legacy[0]).toMatchObject({
      amount: 20000n,
      method: 'CASH',
      status: 'SUCCESS',
      note: 'Bổ sung lượt hoàn cho đơn huỷ trước v2.1',
    });
    expect(legacy[0].paidAt?.getTime()).toBe(vn('2026-11-03T21:00:00').getTime());
    expect(legacy[0].createdAt.getTime()).toBe(vn('2026-11-03T21:00:00').getTime());
    expect(await refunds(zeroId)).toHaveLength(0);
    expect(await refunds(correctId)).toEqual(correctBefore);
  });

  it('áp lại migration: không thêm dòng nào', async () => {
    const before = await db.payment.count();
    applyMigrationFile(SCHEMA, MIGRATION);
    expect(await db.payment.count()).toBe(before);
    expect(await refunds(legacyId)).toHaveLength(1);
  });

  it('đối soát sau migration: phát hiện lệch ≥ 1 và sửa doanh thu về 0', async () => {
    const result = await db.$transaction((tx) => repo.rebuild(tx, '2026-11-03', '2026-11-03'));
    expect(result.mismatchCount).toBeGreaterThanOrEqual(1);
    expect(result.mismatches[0]).toMatchObject({
      table: 'sales_daily',
      stored: { revenue: 20000 },
      expected: { revenue: 0 },
    });
    const [row] = await db.$queryRaw<
      { revenue: bigint }[]
    >`SELECT revenue FROM sales_daily WHERE "date" = '2026-11-03'`;
    expect(row.revenue).toBe(0n);
    const again = await db.$transaction((tx) => repo.rebuild(tx, '2026-11-03', '2026-11-03'));
    expect(again.mismatchCount).toBe(0);
  });
});
