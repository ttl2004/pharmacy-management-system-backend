import { PrismaClient } from '@prisma/client';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { PrismaService } from 'src/common/databases/prisma.service';
import { AuthRole } from 'src/common/types/common.enum';
import { createTestPrisma, resetSchema } from 'src/test-support/db-test';
import { ReportBase, seedPaidOrder, seedReportBase, SeedOrderInput } from './report-db-seed';
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
      daily: [
        { date: '2026-11-01', revenue: 80000, orders: 2 },
        { date: '2026-11-02', revenue: 240000, orders: 1 },
        { date: '2026-11-03', revenue: 10000, orders: 1 },
        { date: '2026-11-04', revenue: 0, orders: 0 },
      ],
      byBranch: [
        { branchId: cn2.id, branchName: 'Chi nhánh 2', revenue: 240000, orderCount: 1 },
        { branchId: cn1.id, branchName: 'Chi nhánh 1', revenue: 90000, orderCount: 3 },
      ],
      // Sản phẩm 1 (Vitamin C): 50k ở CN1; đơn huỷ ở CN2 đã trừ hết → vẫn 50k. Khẩu trang 200k đứng đầu.
      topDrugs: [
        { drugId: base.products[2].id, drugName: 'Khẩu trang', qtyInBase: 20, revenue: 200000 },
        { drugId: base.products[1].id, drugName: 'Vitamin C', qtyInBase: 1, revenue: 50000 },
        { drugId: base.products[0].id, drugName: 'Paracetamol', qtyInBase: 4, revenue: 40000 },
      ],
    });
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
    expect(pm.byBranch).toEqual([{ branchId: cn2.id, branchName: 'Chi nhánh 2', revenue: 50000, orderCount: 1 }]);

    const empty = await service.salesReport({ from: '2026-12-01', to: '2026-12-01' }, pmOf(cn2.id));
    expect(empty.byBranch).toEqual([{ branchId: cn2.id, branchName: 'Chi nhánh 2', revenue: 0, orderCount: 0 }]);
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
