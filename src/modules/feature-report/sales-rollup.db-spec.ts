import { PaymentMethod, PrismaClient } from '@prisma/client';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { PrismaService } from 'src/common/databases/prisma.service';
import { AuthRole } from 'src/common/types/common.enum';
import { InventoryTransactions } from 'src/modules/feature-inventory/core/inventory-transactions';
import { OrderVoidAndPreviewService } from 'src/modules/feature-sales/order/order-void-and-preview.service';
import { OrderService } from 'src/modules/feature-sales/order/order.service';
import { OrderRepository } from 'src/modules/feature-sales/order/repositories/order.repository';
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

  /** Cổng để giữ một transaction mở cho tới khi test cho phép commit. */
  const gate = () => {
    let open!: () => void;
    const promise = new Promise<void>((resolve) => (open = resolve));
    return { promise, open };
  };
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('rebuild chạy song song với applyOrder của đơn mới cùng ngày → kết quả cuối vẫn tính đơn mới (đơn thu trước)', async () => {
    const order = await seedPaidOrder(prisma, base, {
      branch: 0,
      completedAt: vn('2026-11-05T10:00:00'),
      pending: true,
      lines: [{ product: 0, qty: 2, unitPrice: 10000, unitCost: 4000 }],
    });
    const hold = gate();
    const entered = gate();
    // Giao dịch thu tiền: chiếm đơn + cộng tổng hợp, rồi giữ mở (chưa commit).
    const paying = prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { status: 'COMPLETED', completedAt: vn('2026-11-05T10:00:00') },
      });
      await repo.applyOrder(tx, order.id, 1, 20000n);
      entered.open();
      await hold.promise;
    });
    await entered.promise;
    // Đối soát chạy xen vào: phải chờ khoá của ngày 5/11 cho tới khi đơn commit.
    let rebuilt = false;
    const rebuilding = prisma
      .$transaction((tx) => repo.rebuild(tx, '2026-11-04', '2026-11-05'))
      .then(() => (rebuilt = true));
    await sleep(500);
    expect(rebuilt).toBe(false);
    hold.open();
    await paying;
    await rebuilding;
    const rows = await daily();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ date: '2026-11-05', orderCount: 1, revenue: 20000n });
  });

  it('rebuild chạy song song với applyOrder của đơn mới cùng ngày → kết quả cuối vẫn tính đơn mới (đối soát trước)', async () => {
    const order = await seedPaidOrder(prisma, base, {
      branch: 0,
      completedAt: vn('2026-11-05T10:00:00'),
      pending: true,
      lines: [{ product: 0, qty: 2, unitPrice: 10000, unitCost: 4000 }],
    });
    const hold = gate();
    const locked = gate();
    // Đối soát giữ khoá ngày rồi giữ mở transaction.
    const rebuilding = prisma.$transaction(async (tx) => {
      await repo.rebuild(tx, '2026-11-04', '2026-11-05');
      locked.open();
      await hold.promise;
    });
    await locked.promise;
    let paid = false;
    const paying = prisma
      .$transaction(async (tx) => {
        await tx.order.update({
          where: { id: order.id },
          data: { status: 'COMPLETED', completedAt: vn('2026-11-05T10:00:00') },
        });
        await repo.applyOrder(tx, order.id, 1, 20000n);
      })
      .then(() => (paid = true));
    await sleep(500);
    expect(paid).toBe(false);
    hold.open();
    await rebuilding;
    await paying;
    const rows = await daily();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ orderCount: 1, revenue: 20000n });
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

/** Luồng thật qua OrderService / OrderVoidAndPreviewService trên DB thật (kho và nhật ký được thay bằng bản giả). */
describe('cập nhật tổng hợp trong thu tiền / huỷ hoá đơn (db)', () => {
  let prisma: PrismaClient;
  let base: ReportBase;
  let orders: OrderService;
  let voids: OrderVoidAndPreviewService;
  const stock = { consume: jest.fn(), restock: jest.fn() };
  const audit = { record: jest.fn() };
  let actor: RequestActor;

  beforeAll(async () => {
    prisma = await createTestPrisma();
    const repo = new OrderRepository(prisma as unknown as PrismaService);
    const transactions = new InventoryTransactions(prisma as unknown as PrismaService);
    const rollup = new SalesRollupRepository();
    orders = new OrderService(repo, transactions, stock as never, {} as never, audit as never, {} as never, rollup);
    voids = new OrderVoidAndPreviewService(
      repo,
      transactions,
      stock as never,
      {} as never,
      audit as never,
      {} as never,
      rollup,
    );
  });
  afterAll(async () => {
    jest.useRealTimers();
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    await resetSchema(prisma);
    base = await seedReportBase(prisma);
    const role = await prisma.role.create({ data: { code: 'ADMIN', name: 'Quản trị', level: 90 } });
    const user = await prisma.user.create({ data: { fullName: 'Thu ngân', roleId: role.id } });
    actor = {
      user: { userId: user.id, role: AuthRole.ADMIN, branchId: null, roleLevel: 90 },
      ip: null,
      userAgent: null,
      requestId: null,
    } as unknown as RequestActor;
  });

  /** Chỉ giả `Date`, giữ nguyên timer thật để driver DB không bị treo. */
  const setNow = (iso: string) =>
    jest.useFakeTimers({
      now: vn(iso).getTime(),
      doNotFake: [
        'nextTick',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
        'queueMicrotask',
        'performance',
        'hrtime',
      ],
    });
  const salesDaily = () =>
    prisma.$queryRaw<{ date: string; orderCount: number; revenue: bigint }[]>`
      SELECT to_char("date", 'YYYY-MM-DD') AS "date", "orderCount", "revenue" FROM sales_daily ORDER BY "date"`;

  it('luồng thật: thu đơn 100k ngày 1, huỷ hoàn 60k ngày 3 → sales_daily ngày 1: orderCount 0, revenue 40000', async () => {
    const order = await seedPaidOrder(prisma, base, {
      branch: 0,
      completedAt: vn('2026-11-01T00:00:00'),
      pending: true,
      lines: [{ product: 0, qty: 10, unitPrice: 10000, unitCost: 4000 }],
    });
    setNow('2026-11-01T09:00:00');
    await orders.payPos(order.id, { method: PaymentMethod.CASH }, actor);
    expect(await salesDaily()).toEqual([{ date: '2026-11-01', orderCount: 1, revenue: 100000n }]);

    setNow('2026-11-03T14:00:00');
    await voids.voidPaid(
      order.id,
      { reason: 'Khách trả', refundAmount: 60000, refundMethod: PaymentMethod.CASH },
      actor,
    );
    expect(await salesDaily()).toEqual([{ date: '2026-11-01', orderCount: 0, revenue: 40000n }]);
    const prod = await prisma.salesDailyProduct.findMany();
    expect(prod).toHaveLength(1);
    expect(prod[0]).toMatchObject({ qtyBase: 0, revenue: 0n, cogsAmount: 0n });

    // Dựng lại từ dữ liệu gốc ra đúng như cộng dồn từng bước.
    await prisma.$transaction((tx) => new SalesRollupRepository().rebuild(tx, '2026-11-01', '2026-11-03'));
    expect(await salesDaily()).toEqual([{ date: '2026-11-01', orderCount: 0, revenue: 40000n }]);
  });

  it('rollback: thu tiền lỗi sau khi đã cộng tổng hợp → tổng hợp không đổi, đơn vẫn PENDING', async () => {
    const order = await seedPaidOrder(prisma, base, {
      branch: 0,
      completedAt: vn('2026-11-01T00:00:00'),
      pending: true,
      lines: [{ product: 0, qty: 1, unitPrice: 10000, unitCost: 4000 }],
    });
    // `applyOrder` chạy cuối `payPos`; để lỗi xảy ra SAU nó, thay audit.record (bước kế tiếp) bằng lỗi.
    audit.record.mockRejectedValueOnce(new Error('ghi nhật ký lỗi'));
    setNow('2026-11-01T09:00:00');
    await expect(orders.payPos(order.id, { method: PaymentMethod.CASH }, actor)).rejects.toThrow('ghi nhật ký lỗi');
    expect(await salesDaily()).toEqual([]);
    expect(await prisma.salesDailyProduct.count()).toBe(0);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('PENDING');
  });
});
