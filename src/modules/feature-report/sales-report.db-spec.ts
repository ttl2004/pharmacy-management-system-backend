import { PrismaClient } from '@prisma/client';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { PrismaService } from 'src/common/databases/prisma.service';
import { AuthRole } from 'src/common/types/common.enum';
import { createTestPrisma, resetSchema } from 'src/test-support/db-test';
import { ReportBase, seedPaidOrder, seedReportBase, SeedOrderInput } from 'src/test-support/report-db-seed';
import { InMemoryReportCache } from './report-cache';
import { SalesReportRepository } from './sales-report.repository';
import { SalesReportService } from './sales-report.service';
import { SalesRollupRepository } from './sales-rollup.repository';

const vn = (iso: string) => new Date(`${iso}+07:00`);
const adminActor = { user: { userId: 'u', role: AuthRole.ADMIN, branchId: null } } as unknown as RequestActor;
const pmOf = (branchId: string) =>
  ({ user: { userId: 'u', role: AuthRole.PHARMACY_MANAGER, branchId } }) as unknown as RequestActor;

describe('GET /reports/sales — truy vấn thật (db)', () => {
  let prisma: PrismaClient;
  let base: ReportBase;
  let service: SalesReportService;
  const rollup = new SalesRollupRepository();

  beforeAll(async () => {
    prisma = await createTestPrisma();
    service = new SalesReportService(
      new SalesReportRepository(prisma as unknown as PrismaService),
      new InMemoryReportCache(),
    );
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetSchema(prisma);
    base = await seedReportBase(prisma);
  });

  const sell = async (input: SeedOrderInput) => {
    const order = await seedPaidOrder(prisma, base, input);
    await prisma.$transaction((tx) => rollup.applyOrder(tx, order.id, 1, order.total));
    if (input.voidedRefund !== undefined) {
      await prisma.$transaction((tx) => rollup.applyOrder(tx, order.id, -1, -input.voidedRefund!));
    }
  };

  it('dữ liệu 2 CN 3 ngày → response khớp đúng từng trường của contract FE', async () => {
    const [cn1, cn2] = base.branches;
    // CN1: 2 đơn ngày 1 (30k + 50k), 1 đơn ngày 3 (10k) = 3 đơn. CN2: 1 đơn ngày 2 (200k), 1 đơn ngày 2 huỷ hoàn 60k/100k.
    await sell({
      branch: 0,
      completedAt: vn('2026-11-01T09:00:00'),
      lines: [{ product: 0, qty: 3, unitPrice: 10000, unitCost: 4000 }],
    });
    await sell({
      branch: 0,
      completedAt: vn('2026-11-01T23:59:00'),
      lines: [{ product: 1, qty: 1, unitPrice: 50000, unitCost: 20000 }],
    });
    await sell({
      branch: 0,
      completedAt: vn('2026-11-03T08:00:00'),
      lines: [{ product: 0, qty: 1, unitPrice: 10000, unitCost: 4000 }],
    });
    await sell({
      branch: 1,
      completedAt: vn('2026-11-02T00:01:00'),
      lines: [{ product: 2, qty: 20, unitPrice: 10000, unitCost: 3000 }],
    });
    await sell({
      branch: 1,
      completedAt: vn('2026-11-02T12:00:00'),
      lines: [{ product: 1, qty: 2, unitPrice: 50000, unitCost: 20000 }],
      voidedRefund: 60000n,
    });

    const report = await service.salesReport({ from: '2026-11-01', to: '2026-11-04' }, adminActor);

    expect(report).toEqual({
      totalRevenue: 30000 + 50000 + 10000 + 200000 + 40000,
      orderCount: 4,
      avgOrderValue: Math.round(330000 / 4),
      totalCogs: 96000,
      grossProfit: 234000,
      grossMarginPct: 70.9,
      daily: [
        { date: '2026-11-01', revenue: 80000, orders: 2, cogs: 32000, grossProfit: 48000 },
        { date: '2026-11-02', revenue: 240000, orders: 1, cogs: 60000, grossProfit: 180000 },
        { date: '2026-11-03', revenue: 10000, orders: 1, cogs: 4000, grossProfit: 6000 },
        { date: '2026-11-04', revenue: 0, orders: 0, cogs: 0, grossProfit: 0 },
      ],
      byBranch: [
        // CN2: đơn huỷ hoàn một phần giữ 40k doanh thu, giá vốn trừ hết → 40k là lãi.
        {
          branchId: cn2.id,
          branchName: 'Chi nhánh 2',
          revenue: 240000,
          orderCount: 1,
          cogs: 60000,
          grossProfit: 180000,
          grossMarginPct: 75,
        },
        {
          branchId: cn1.id,
          branchName: 'Chi nhánh 1',
          revenue: 90000,
          orderCount: 3,
          cogs: 36000,
          grossProfit: 54000,
          grossMarginPct: 60,
        },
      ],
      // Sản phẩm 1 (Vitamin C): 50k ở CN1; đơn huỷ ở CN2 đã trừ hết → vẫn 50k. Khẩu trang 200k đứng đầu.
      topDrugs: [
        {
          drugId: base.products[2].id,
          drugName: 'Khẩu trang',
          qtyInBase: 20,
          revenue: 200000,
          cogs: 60000,
          grossProfit: 140000,
          grossMarginPct: 70,
        },
        {
          drugId: base.products[1].id,
          drugName: 'Vitamin C',
          qtyInBase: 1,
          revenue: 50000,
          cogs: 20000,
          grossProfit: 30000,
          grossMarginPct: 60,
        },
        {
          drugId: base.products[0].id,
          drugName: 'Paracetamol',
          qtyInBase: 4,
          revenue: 40000,
          cogs: 16000,
          grossProfit: 24000,
          grossMarginPct: 60,
        },
      ],
    });
  });

  it('topDrugs toàn chuỗi (bảng chuỗi) bằng topDrugs khi liệt kê mọi chi nhánh (bảng theo chi nhánh)', async () => {
    await sell({
      branch: 0,
      completedAt: vn('2026-11-01T09:00:00'),
      lines: [
        { product: 0, qty: 3, unitPrice: 10000, unitCost: 4000 },
        { product: 1, qty: 1, unitPrice: 50000, unitCost: 1 },
      ],
    });
    await sell({
      branch: 1,
      completedAt: vn('2026-11-02T09:00:00'),
      lines: [{ product: 0, qty: 2, unitPrice: 10000, unitCost: 4000 }],
      voidedRefund: 10000n,
    });
    await sell({
      branch: 1,
      completedAt: vn('2026-11-02T10:00:00'),
      lines: [
        { product: 2, qty: 7, unitPrice: 9000, unitCost: 1 },
        { product: 0, qty: 1, unitPrice: 10000, unitCost: 1 },
      ],
    });
    const ids = base.branches.map((b) => b.id);
    const viaChain = await service.salesReport({ from: '2026-11-01', to: '2026-11-03' }, adminActor);
    const viaBranch = await service.salesReport({ from: '2026-11-01', to: '2026-11-03', branchIds: ids }, adminActor);
    expect(viaChain.topDrugs.length).toBeGreaterThan(0);
    expect(viaChain.topDrugs).toEqual(viaBranch.topDrugs);
  });

  it('tổng/ngày/chi nhánh: cogs và grossProfit đúng với dữ liệu 2 CN, có đơn huỷ hoàn một phần', async () => {
    await sell({
      branch: 0,
      completedAt: vn('2026-11-01T09:00:00'),
      lines: [{ product: 0, qty: 10, unitPrice: 50000, unitCost: 35000 }],
    });
    // Huỷ sau thu, hoàn 450k (giữ 50k): hàng về kho → giá vốn trừ hết, 50k là lãi.
    await sell({
      branch: 1,
      completedAt: vn('2026-11-01T10:00:00'),
      lines: [{ product: 0, qty: 10, unitPrice: 50000, unitCost: 35000 }],
      voidedRefund: 450000n,
    });
    // Bán dưới giá vốn → lãi âm.
    await sell({
      branch: 1,
      completedAt: vn('2026-11-02T10:00:00'),
      lines: [{ product: 1, qty: 1, unitPrice: 10000, unitCost: 15000 }],
    });
    const report = await service.salesReport({ from: '2026-11-01', to: '2026-11-02' }, adminActor);
    expect(report).toMatchObject({
      totalRevenue: 560000,
      totalCogs: 365000,
      grossProfit: 195000,
      grossMarginPct: 34.8,
    });
    expect(report.daily).toEqual([
      { date: '2026-11-01', revenue: 550000, orders: 1, cogs: 350000, grossProfit: 200000 },
      { date: '2026-11-02', revenue: 10000, orders: 1, cogs: 15000, grossProfit: -5000 },
    ]);
    const [cn1, cn2] = base.branches;
    const byId = Object.fromEntries(report.byBranch.map((b) => [b.branchId, b]));
    expect(byId[cn1.id]).toMatchObject({ revenue: 500000, cogs: 350000, grossProfit: 150000, grossMarginPct: 30 });
    expect(byId[cn2.id]).toMatchObject({ revenue: 60000, cogs: 15000, grossProfit: 45000, grossMarginPct: 75 });
  });

  it('topBy=grossProfit sắp theo lãi gộp; toàn chuỗi đọc bảng chain, có lọc đọc bảng theo CN — hai đường cho cùng kết quả', async () => {
    const [p0, p1, p2] = base.products;
    // Doanh thu: P0 100k > P2 60k > P1 50k. Lãi gộp: P2 40k = P1 40k (hoà → doanh thu cao hơn trước) > P0 10k.
    await sell({
      branch: 0,
      completedAt: vn('2026-10-01T09:00:00'),
      lines: [{ product: 0, qty: 1, unitPrice: 100000, unitCost: 90000 }],
    });
    await sell({
      branch: 1,
      completedAt: vn('2026-10-01T09:00:00'),
      lines: [
        { product: 1, qty: 1, unitPrice: 50000, unitCost: 10000 },
        { product: 2, qty: 2, unitPrice: 30000, unitCost: 10000 },
      ],
    });
    // Đơn huỷ: bị trừ trọn theo sản phẩm.
    await sell({
      branch: 1,
      completedAt: vn('2026-10-02T09:00:00'),
      lines: [{ product: 0, qty: 5, unitPrice: 100000, unitCost: 1 }],
      voidedRefund: 500000n,
    });
    const query = { from: '2026-10-01', to: '2026-10-03' };
    const byProfit = await service.salesReport({ ...query, topBy: 'grossProfit' }, adminActor);
    expect(byProfit.topDrugs.map((d) => d.drugId)).toEqual([p2.id, p1.id, p0.id]);
    expect(byProfit.topDrugs.map((d) => d.grossProfit)).toEqual([40000, 40000, 10000]);
    const byRevenue = await service.salesReport(query, adminActor);
    expect(byRevenue.topDrugs.map((d) => d.drugId)).toEqual([p0.id, p2.id, p1.id]);

    const ids = base.branches.map((b) => b.id);
    const viaBranch = await service.salesReport({ ...query, branchIds: ids, topBy: 'grossProfit' }, adminActor);
    expect(viaBranch.topDrugs).toEqual(byProfit.topDrugs);
  });

  it('topBy=grossProfit: LIMIT 10 chọn theo lãi gộp, không theo doanh thu', async () => {
    const category = await prisma.category.create({ data: { name: 'Khác' } });
    const unit = await prisma.unit.findFirstOrThrow();
    for (let i = 0; i < 11; i++) {
      const product = await prisma.product.create({
        data: { code: `Y${i}`, name: `Hàng ${i}`, type: 'GOODS', categoryId: category.id, baseUnitId: unit.id },
      });
      base.products.push(product);
      base.productUnits.push(
        await prisma.productUnit.create({
          data: { productId: product.id, unitId: unit.id, conversionRate: 1, salePrice: 1, isBaseUnit: true },
        }),
      );
      base.batches[`${base.branches[0].id}:${product.id}`] = await prisma.stockBatch.create({
        data: {
          branchId: base.branches[0].id,
          productId: product.id,
          batchNumber: 'L',
          expiryDate: new Date('2030-01-01'),
          importPrice: 1,
        },
      });
    }
    // Hàng 0 doanh thu cao nhất (1.000k) nhưng lãi chỉ 1k → phải rớt khỏi top 10 theo lãi; 10 hàng còn lại lãi 10k..100k.
    for (let i = 0; i < 11; i++) {
      const line =
        i === 0 ? { unitPrice: 1_000_000, unitCost: 999_000 } : { unitPrice: 20000 * i, unitCost: 10000 * i };
      await sell({
        branch: 0,
        completedAt: vn('2026-09-01T09:00:00'),
        lines: [{ product: 3 + i, qty: 1, ...line }],
      });
    }
    const query = { from: '2026-09-01', to: '2026-09-01' };
    const byProfit = await service.salesReport({ ...query, topBy: 'grossProfit' }, adminActor);
    expect(byProfit.topDrugs.map((d) => d.grossProfit)).toEqual([
      100000, 90000, 80000, 70000, 60000, 50000, 40000, 30000, 20000, 10000,
    ]);
    const filtered = await service.salesReport(
      { ...query, branchIds: [base.branches[0].id], topBy: 'grossProfit' },
      adminActor,
    );
    expect(filtered.topDrugs).toEqual(byProfit.topDrugs);
  });

  it('PM chỉ thấy lãi chi nhánh mình, kể cả khi ADMIN vừa gọi cùng tham số (cache)', async () => {
    const [cn1, cn2] = base.branches;
    await sell({
      branch: 0,
      completedAt: vn('2026-08-01T09:00:00'),
      lines: [{ product: 0, qty: 1, unitPrice: 10000, unitCost: 4000 }],
    });
    await sell({
      branch: 1,
      completedAt: vn('2026-08-01T09:00:00'),
      lines: [{ product: 0, qty: 5, unitPrice: 10000, unitCost: 1000 }],
    });
    const query = { from: '2026-08-01', to: '2026-08-01', topBy: 'grossProfit' as const };
    const admin = await service.salesReport(query, adminActor);
    expect(admin.grossProfit).toBe(6000 + 45000);
    const pm = await service.salesReport(query, pmOf(cn2.id));
    expect(pm).toMatchObject({ totalCogs: 5000, grossProfit: 45000, grossMarginPct: 90 });
    expect(pm.byBranch.map((b) => b.branchId)).toEqual([cn2.id]);
    expect(pm.topDrugs[0]).toMatchObject({ qtyInBase: 5, grossProfit: 45000 });
    await expect(service.salesReport({ ...query, branchIds: [cn1.id] }, pmOf(cn2.id))).rejects.toBeDefined();
  });

  it('lọc theo chi nhánh; PM chỉ thấy chi nhánh mình; chi nhánh không có đơn vẫn có dòng 0đ', async () => {
    const [cn1, cn2] = base.branches;
    await sell({
      branch: 0,
      completedAt: vn('2026-11-01T09:00:00'),
      lines: [{ product: 0, qty: 1, unitPrice: 10000, unitCost: 4000 }],
    });
    await sell({
      branch: 1,
      completedAt: vn('2026-11-01T09:00:00'),
      lines: [{ product: 0, qty: 5, unitPrice: 10000, unitCost: 4000 }],
    });

    const onlyCn1 = await service.salesReport(
      { from: '2026-11-01', to: '2026-11-01', branchIds: [cn1.id] },
      adminActor,
    );
    expect(onlyCn1.totalRevenue).toBe(10000);
    expect(onlyCn1.byBranch.map((b) => b.branchId)).toEqual([cn1.id]);

    const pm = await service.salesReport({ from: '2026-11-01', to: '2026-11-01' }, pmOf(cn2.id));
    expect(pm.totalRevenue).toBe(50000);
    expect(pm.byBranch).toEqual([
      {
        branchId: cn2.id,
        branchName: 'Chi nhánh 2',
        revenue: 50000,
        orderCount: 1,
        cogs: 20000,
        grossProfit: 30000,
        grossMarginPct: 60,
      },
    ]);

    const empty = await service.salesReport({ from: '2026-12-01', to: '2026-12-01' }, pmOf(cn2.id));
    expect(empty.byBranch).toEqual([
      {
        branchId: cn2.id,
        branchName: 'Chi nhánh 2',
        revenue: 0,
        orderCount: 0,
        cogs: 0,
        grossProfit: 0,
        grossMarginPct: null,
      },
    ]);
    expect(empty.topDrugs).toEqual([]);
  });

  it('topDrugs tối đa 10, sắp theo revenue giảm dần rồi qtyInBase', async () => {
    const category = await prisma.category.create({ data: { name: 'Khác' } });
    const unit = await prisma.unit.findFirstOrThrow();
    for (let i = 0; i < 11; i++) {
      const product = await prisma.product.create({
        data: { code: `X${i}`, name: `Hàng ${i}`, type: 'GOODS', categoryId: category.id, baseUnitId: unit.id },
      });
      base.products.push(product);
      base.productUnits.push(
        await prisma.productUnit.create({
          data: { productId: product.id, unitId: unit.id, conversionRate: 1, salePrice: 1, isBaseUnit: true },
        }),
      );
      base.batches[`${base.branches[0].id}:${product.id}`] = await prisma.stockBatch.create({
        data: {
          branchId: base.branches[0].id,
          productId: product.id,
          batchNumber: 'L',
          expiryDate: new Date('2030-01-01'),
          importPrice: 1,
        },
      });
    }
    // 11 sản phẩm doanh thu 10k, 20k, ... 110k (qty 1); riêng sản phẩm 0 bán 4 × 5k = 20k, hoà doanh thu với sản phẩm 1.
    for (let i = 0; i < 11; i++) {
      const line = i === 0 ? { qty: 4, unitPrice: 5000 } : { qty: 1, unitPrice: 10000 * (i + 1) };
      await sell({
        branch: 0,
        completedAt: vn('2026-11-01T09:00:00'),
        lines: [{ product: 3 + i, unitCost: 1, ...line }],
      });
    }
    const report = await service.salesReport({ from: '2026-11-01', to: '2026-11-01' }, adminActor);
    expect(report.topDrugs).toHaveLength(10);
    expect(report.topDrugs.map((d) => d.revenue)).toEqual([
      110000, 100000, 90000, 80000, 70000, 60000, 50000, 40000, 30000, 20000,
    ]);
    // Hai sản phẩm cùng 20k: số lượng nhiều hơn (4) đứng trước — nhưng chỉ một trong hai lọt top 10 → là Hàng 0 (qty 4).
    expect(report.topDrugs[9]).toMatchObject({ drugName: 'Hàng 0', qtyInBase: 4, revenue: 20000 });
  });
});
