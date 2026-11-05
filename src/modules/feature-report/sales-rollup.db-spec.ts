import { PrismaClient } from '@prisma/client';
import { createTestPrisma, resetSchema } from 'src/test-support/db-test';
import { ReportBase, seedPaidOrder, seedReportBase } from './report-db-seed';
import { SalesRollupRepository } from './sales-rollup.repository';

/** Mốc theo giờ Việt Nam (UTC+7) cho dễ đọc. */
const vn = (iso: string) => new Date(`${iso}+07:00`);

describe('bảng tổng hợp doanh thu (db)', () => {
  let prisma: PrismaClient;
  let base: ReportBase;
  const repo = new SalesRollupRepository();

  beforeAll(async () => {
    prisma = await createTestPrisma();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetSchema(prisma);
    base = await seedReportBase(prisma);
  });

  const apply = (orderId: string, sign: 1 | -1, delta: bigint) =>
    prisma.$transaction((tx) => repo.applyOrder(tx, orderId, sign, delta));
  const daily = () =>
    prisma.$queryRaw<{ branchId: string; date: string; orderCount: number; revenue: bigint }[]>`
      SELECT "branchId", to_char("date", 'YYYY-MM-DD') AS "date", "orderCount", "revenue"
      FROM sales_daily ORDER BY "branchId", "date"`;
  const products = () =>
    prisma.$queryRaw<
      { branchId: string; date: string; productId: string; qtyBase: number; revenue: bigint; cogsAmount: bigint }[]
    >`SELECT "branchId", to_char("date", 'YYYY-MM-DD') AS "date", "productId", "qtyBase", "revenue", "cogsAmount"
      FROM sales_daily_product ORDER BY "branchId", "date", "productId"`;

  it('applyOrder(+1) hai đơn cùng CN cùng ngày VN → 1 dòng sales_daily orderCount 2, revenue = tổng', async () => {
    const a = await seedPaidOrder(prisma, base, {
      branch: 0,
      completedAt: vn('2026-11-01T09:00:00'),
      lines: [{ product: 0, qty: 2, unitPrice: 10000, unitCost: 4000 }],
    });
    const b = await seedPaidOrder(prisma, base, {
      branch: 0,
      completedAt: vn('2026-11-01T15:30:00'),
      lines: [{ product: 1, qty: 1, unitPrice: 50000, unitCost: 20000 }],
    });
    await apply(a.id, 1, a.total);
    await apply(b.id, 1, b.total);
    const rows = await daily();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ date: '2026-11-01', orderCount: 2, revenue: 70000n });
  });

  it('đơn thu 23:59 và 00:01 giờ VN → 2 ngày khác nhau', async () => {
    const a = await seedPaidOrder(prisma, base, {
      branch: 0,
      completedAt: vn('2026-11-01T23:59:00'),
      lines: [{ product: 0, qty: 1, unitPrice: 10000, unitCost: 4000 }],
    });
    const b = await seedPaidOrder(prisma, base, {
      branch: 0,
      completedAt: vn('2026-11-02T00:01:00'),
      lines: [{ product: 0, qty: 1, unitPrice: 20000, unitCost: 4000 }],
    });
    await apply(a.id, 1, a.total);
    await apply(b.id, 1, b.total);
    const rows = await daily();
    expect(rows.map((r) => [r.date, r.orderCount, r.revenue])).toEqual([
      ['2026-11-01', 1, 10000n],
      ['2026-11-02', 1, 20000n],
    ]);
  });

  it('applyOrder(-1, -refund) đơn huỷ → trừ vào ngày thu gốc', async () => {
    const o = await seedPaidOrder(prisma, base, {
      branch: 0,
      completedAt: vn('2026-11-01T10:00:00'),
      lines: [{ product: 0, qty: 10, unitPrice: 10000, unitCost: 4000 }],
      voidedRefund: 60000n,
    });
    await apply(o.id, 1, o.total);
    await apply(o.id, -1, -60000n);
    const rows = await daily();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ date: '2026-11-01', orderCount: 0, revenue: 40000n });
    const prod = await products();
    expect(prod[0]).toMatchObject({ qtyBase: 0, revenue: 0n, cogsAmount: 0n });
  });

  it('sales_daily_product gộp đúng qtyBase, revenue, cogsAmount theo sản phẩm', async () => {
    const a = await seedPaidOrder(prisma, base, {
      branch: 0,
      completedAt: vn('2026-11-01T09:00:00'),
      lines: [
        { product: 0, qty: 2, unitPrice: 10000, unitCost: 4000 },
        { product: 1, qty: 1, unitPrice: 50000, unitCost: 20000 },
      ],
    });
    const b = await seedPaidOrder(prisma, base, {
      branch: 0,
      completedAt: vn('2026-11-01T11:00:00'),
      lines: [{ product: 0, qty: 3, unitPrice: 10000, unitCost: 4500 }],
    });
    await apply(a.id, 1, a.total);
    await apply(b.id, 1, b.total);
    const rows = await products();
    const byProduct = new Map(rows.map((r) => [r.productId, r]));
    expect(byProduct.get(base.products[0].id)).toMatchObject({ qtyBase: 5, revenue: 50000n, cogsAmount: 21500n });
    expect(byProduct.get(base.products[1].id)).toMatchObject({ qtyBase: 1, revenue: 50000n, cogsAmount: 20000n });
  });

  it('rebuild cho ra đúng bằng tổng các applyOrder (đơn thu, huỷ hoàn đủ, huỷ hoàn một phần)', async () => {
    const mk = [
      await seedPaidOrder(prisma, base, {
        branch: 0,
        completedAt: vn('2026-11-01T09:00:00'),
        lines: [{ product: 0, qty: 2, unitPrice: 10000, unitCost: 4000 }],
      }),
      await seedPaidOrder(prisma, base, {
        branch: 1,
        completedAt: vn('2026-11-02T00:01:00'),
        lines: [
          { product: 1, qty: 1, unitPrice: 50000, unitCost: 20000 },
          { product: 2, qty: 4, unitPrice: 2500, unitCost: 1000 },
        ],
      }),
    ];
    const full = await seedPaidOrder(prisma, base, {
      branch: 0,
      completedAt: vn('2026-11-02T10:00:00'),
      lines: [{ product: 0, qty: 5, unitPrice: 10000, unitCost: 4000 }],
      voidedRefund: 50000n,
    });
    const partial = await seedPaidOrder(prisma, base, {
      branch: 0,
      completedAt: vn('2026-11-02T11:00:00'),
      lines: [{ product: 2, qty: 10, unitPrice: 10000, unitCost: 4000 }],
      voidedRefund: 60000n,
    });
    for (const o of mk) await apply(o.id, 1, o.total);
    await apply(full.id, 1, full.total);
    await apply(full.id, -1, -50000n);
    await apply(partial.id, 1, partial.total);
    await apply(partial.id, -1, -60000n);

    const dailyBefore = await daily();
    const productsBefore = await products();
    expect(dailyBefore.length).toBeGreaterThan(0);

    const result = await prisma.$transaction((tx) => repo.rebuild(tx, '2026-10-30', '2026-11-03'));
    expect(result.days).toBe(5);
    expect(await daily()).toEqual(dailyBefore);
    expect(await products()).toEqual(productsBefore);
  });
});
