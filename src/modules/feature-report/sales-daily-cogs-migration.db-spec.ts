import { PrismaClient } from '@prisma/client';
import {
  applyMigrationFile,
  applyMigrationsUntil,
  buildTestDatabaseUrl,
  createTestPrisma,
} from 'src/test-support/db-test';
import { ReportBase, seedPaidOrder, seedReportBase } from 'src/test-support/report-db-seed';

const SCHEMA = 'sales_daily_cogs_db';
const MIGRATION = 'sales_daily_gia_von';
const vn = (iso: string) => new Date(`${iso}+07:00`);

describe('migration sales_daily_gia_von', () => {
  let admin: PrismaClient;
  let db: PrismaClient;
  let base: ReportBase;

  beforeAll(async () => {
    admin = await createTestPrisma();
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${SCHEMA}"`);
    await applyMigrationsUntil(admin, SCHEMA, MIGRATION);
    db = new PrismaClient({ datasources: { db: { url: buildTestDatabaseUrl(SCHEMA) } } });
    await db.$connect();
    base = await seedReportBase(db);
    await seedPaidOrder(db, base, {
      branch: 0,
      completedAt: vn('2026-11-01T09:00:00'),
      lines: [
        { product: 0, qty: 2, unitPrice: 10000, unitCost: 4000 },
        { product: 1, qty: 1, unitPrice: 50000, unitCost: 20000 },
      ],
    });
    // Sổ phụ dựng theo bảng cũ (chưa có cột giá vốn ở sales_daily): chỉ ghi các cột đã có.
    await db.$executeRaw`
      INSERT INTO sales_daily ("branchId", "date", "channel", "orderCount", "revenue", "updatedAt")
      VALUES (${base.branches[0].id}::uuid, '2026-11-01', 'POS', 1, 70000, now()),
             (${base.branches[1].id}::uuid, '2026-11-01', 'POS', 0, 0, now())`;
    await db.$executeRaw`
      INSERT INTO sales_daily_product ("branchId", "date", "channel", "productId", "qtyBase", "revenue", "cogsAmount")
      VALUES (${base.branches[0].id}::uuid, '2026-11-01', 'POS', ${base.products[0].id}::uuid, 2, 20000, 8000),
             (${base.branches[0].id}::uuid, '2026-11-01', 'POS', ${base.products[1].id}::uuid, 1, 50000, 20000)`;
  });

  afterAll(async () => {
    await db?.$disconnect();
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await admin.$disconnect();
  });

  it('migration backfill: DB trước migration có sales_daily_product → cột mới bằng tổng sản phẩm', async () => {
    applyMigrationFile(SCHEMA, MIGRATION);
    const rows = await db.$queryRaw<{ branchId: string; cogsAmount: bigint }[]>`
      SELECT "branchId", "cogsAmount" FROM sales_daily ORDER BY "branchId"`;
    const byBranch = new Map(rows.map((r) => [r.branchId, r.cogsAmount]));
    expect(byBranch.get(base.branches[0].id)).toBe(28000n);
    // Dòng ngày không có dòng sản phẩm → giữ mặc định 0.
    expect(byBranch.get(base.branches[1].id)).toBe(0n);
  });
});
