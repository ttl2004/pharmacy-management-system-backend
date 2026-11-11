import { PrismaClient } from '@prisma/client';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { PrismaService } from 'src/common/databases/prisma.service';
import { AuthRole } from 'src/common/types/common.enum';
import { createTestPrisma, resetSchema } from 'src/test-support/db-test';
import { ReportBase, seedPaidOrder, seedReportBase, SeedOrderInput } from 'src/test-support/report-db-seed';
import { InMemoryReportCache } from '../report-cache';
import { SalesReportRepository } from '../sales-report.repository';
import { SalesReportService } from '../sales-report.service';
import { SalesRollupRepository } from '../sales-rollup.repository';
import { StaffReportRepository } from './staff-report.repository';
import { StaffReportService } from './staff-report.service';

const vn = (iso: string) => new Date(`${iso}+07:00`);
const adminActor = { user: { userId: 'u', role: AuthRole.ADMIN, branchId: null } } as unknown as RequestActor;
const pmOf = (branchId: string) =>
  ({ user: { userId: 'u', role: AuthRole.PHARMACY_MANAGER, branchId } }) as unknown as RequestActor;

describe('GET /reports/staff — truy vấn thật (db)', () => {
  let prisma: PrismaClient;
  let base: ReportBase;
  let service: StaffReportService;
  let sales: SalesReportService;
  let lan: string;
  let hung: string;
  let admin: string;
  const rollup = new SalesRollupRepository();

  beforeAll(async () => {
    prisma = await createTestPrisma();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetSchema(prisma);
    base = await seedReportBase(prisma);
    // Cache mới mỗi test: không để kết quả test trước rò sang test sau.
    service = new StaffReportService(
      new StaffReportRepository(prisma as unknown as PrismaService),
      new InMemoryReportCache(),
    );
    sales = new SalesReportService(
      new SalesReportRepository(prisma as unknown as PrismaService),
      new InMemoryReportCache(),
    );
    const role = await prisma.role.create({ data: { code: 'STAFF', name: 'Nhân viên', level: 10 } });
    lan = (await prisma.user.create({ data: { fullName: 'Lan', roleId: role.id, branchId: base.branches[0].id } })).id;
    hung = (await prisma.user.create({ data: { fullName: 'Hùng', roleId: role.id, branchId: base.branches[1].id } }))
      .id;
    admin = (await prisma.user.create({ data: { fullName: 'Quản trị', roleId: role.id } })).id;
  });

  /** Lập đơn qua seed dùng chung (không có staffId) rồi gán nhân viên; cập nhật bảng tổng hợp để kiểm chéo /reports/sales. */
  const sell = async (staffId: string | null, input: SeedOrderInput) => {
    const order = await seedPaidOrder(prisma, base, input);
    if (staffId) await prisma.order.update({ where: { id: order.id }, data: { staffId } });
    await prisma.$transaction((tx) => rollup.applyOrder(tx, order.id, 1, order.total));
    if (input.voidedRefund !== undefined) {
      await prisma.$transaction((tx) => rollup.applyOrder(tx, order.id, -1, -input.voidedRefund!));
    }
    return order.id;
  };

  const line = (qty: number, unitPrice: number, unitCost: number, product = 0) => ({
    product,
    qty,
    unitPrice,
    unitCost,
  });

  it('số liệu chính xác: đơn thu, đơn huỷ sau thu (hoàn một phần), giá vốn, sắp theo doanh thu, kiểm chéo /reports/sales', async () => {
    // Lan (CN1): 2 đơn COMPLETED 30k (giá vốn 12k) + 50k (giá vốn 20k); 1 đơn huỷ 100k hoàn 60k (giữ lại 40k, giá vốn không tính).
    await sell(lan, { branch: 0, completedAt: vn('2026-11-01T09:00:00'), lines: [line(3, 10000, 4000)] });
    await sell(lan, { branch: 0, completedAt: vn('2026-11-02T10:00:00'), lines: [line(1, 50000, 20000, 1)] });
    await sell(lan, {
      branch: 0,
      completedAt: vn('2026-11-02T12:00:00'),
      lines: [line(2, 50000, 20000, 1)],
      voidedRefund: 60000n,
    });
    // Hùng (CN2): 1 đơn 200k, giá vốn 60k.
    await sell(hung, { branch: 1, completedAt: vn('2026-11-03T08:00:00'), lines: [line(20, 10000, 3000, 2)] });

    const report = await service.staffReport({ from: '2026-11-01', to: '2026-11-30' }, adminActor);

    expect(report.byStaff).toEqual([
      {
        staffId: hung,
        staffName: 'Hùng',
        branchName: 'Chi nhánh 2',
        orderCount: 1,
        revenue: 200000,
        avgOrderValue: 200000,
        cancelledCount: 0,
        refundAmount: 0,
        cogs: 60000,
        grossProfit: 140000,
      },
      {
        staffId: lan,
        staffName: 'Lan',
        branchName: 'Chi nhánh 1',
        orderCount: 2,
        revenue: 30000 + 50000 + 40000,
        avgOrderValue: 60000,
        cancelledCount: 1,
        refundAmount: 60000,
        cogs: 12000 + 20000,
        grossProfit: 120000 - 32000,
      },
    ]);
    expect(report.totals).toEqual({ orderCount: 3, revenue: 320000, cancelledCount: 1, refundAmount: 60000 });

    const salesReport = await sales.salesReport({ from: '2026-11-01', to: '2026-11-30' }, adminActor);
    expect(report.byStaff.reduce((s, r) => s + r.revenue, 0)).toBe(salesReport.totalRevenue);
    expect(report.totals.orderCount).toBe(salesReport.orderCount);
  });

  it('ranh giới ngày giờ VN: 23:59 ngày to tính, 00:00 ngày sau không; 00:00 ngày from tính, 23:59 hôm trước không', async () => {
    await sell(lan, { branch: 0, completedAt: vn('2026-11-09T23:59:00'), lines: [line(1, 1000, 100)] }); // ngoài
    await sell(lan, { branch: 0, completedAt: vn('2026-11-10T00:00:00'), lines: [line(1, 2000, 100)] }); // trong
    await sell(lan, { branch: 0, completedAt: vn('2026-11-10T23:59:00'), lines: [line(1, 4000, 100)] }); // trong
    await sell(lan, { branch: 0, completedAt: vn('2026-11-11T00:00:00'), lines: [line(1, 8000, 100)] }); // ngoài

    const report = await service.staffReport({ from: '2026-11-10', to: '2026-11-10' }, adminActor);
    expect(report.totals).toMatchObject({ orderCount: 2, revenue: 6000 });
  });

  it('bỏ đơn không có staffId, đơn xoá mềm, đơn chưa thu; ADMIN có branchName null; dòng order_item xoá mềm không tính giá vốn', async () => {
    await sell(admin, { branch: 0, completedAt: vn('2026-11-05T09:00:00'), lines: [line(1, 5000, 1000)] });
    await sell(null, { branch: 0, completedAt: vn('2026-11-05T09:00:00'), lines: [line(1, 7000, 1000)] });
    const deleted = await sell(lan, {
      branch: 0,
      completedAt: vn('2026-11-05T09:00:00'),
      lines: [line(1, 9000, 1000)],
    });
    await prisma.order.update({ where: { id: deleted }, data: { isDeleted: true } });
    await sell(lan, { branch: 0, completedAt: vn('2026-11-05T09:00:00'), pending: true, lines: [line(1, 3000, 1000)] });
    const kept = await sell(hung, {
      branch: 1,
      completedAt: vn('2026-11-05T09:00:00'),
      lines: [line(1, 6000, 1000), line(1, 6000, 500, 1)],
    });
    await prisma.orderItem.updateMany({
      where: { orderId: kept, productId: base.products[1].id },
      data: { isDeleted: true },
    });

    const report = await service.staffReport({ from: '2026-11-01', to: '2026-11-30' }, adminActor);
    expect(report.byStaff.map((r) => r.staffName).sort()).toEqual(['Hùng', 'Quản trị']);
    expect(report.byStaff.find((r) => r.staffName === 'Quản trị')).toMatchObject({ branchName: null, revenue: 5000 });
    expect(report.byStaff.find((r) => r.staffName === 'Hùng')).toMatchObject({ cogs: 1000 });
  });

  it('hoàn tiền tính về đơn gốc dù hoàn ở ngày sau; PM chỉ thấy đơn chi nhánh mình; branchIds lọc', async () => {
    const id = await sell(lan, {
      branch: 0,
      completedAt: vn('2026-11-30T10:00:00'),
      lines: [line(1, 10000, 3000)],
      voidedRefund: 10000n,
    });
    await prisma.payment.updateMany({
      where: { orderId: id, kind: 'REFUND' },
      data: { paidAt: vn('2026-12-02T10:00:00') },
    });
    await sell(hung, { branch: 1, completedAt: vn('2026-11-30T11:00:00'), lines: [line(1, 4000, 1000)] });

    const range = { from: '2026-11-01', to: '2026-11-30' };
    const all = await service.staffReport(range, adminActor);
    expect(all.byStaff.find((r) => r.staffId === lan)).toMatchObject({
      orderCount: 0,
      cancelledCount: 1,
      refundAmount: 10000,
      revenue: 0,
      avgOrderValue: 0,
      cogs: 0,
    });

    const pmReport = await service.staffReport(range, pmOf(base.branches[1].id));
    expect(pmReport.byStaff.map((r) => r.staffId)).toEqual([hung]);
    await expect(
      service.staffReport({ ...range, branchIds: [base.branches[0].id] }, pmOf(base.branches[1].id)),
    ).rejects.toBeDefined();

    const only1 = await service.staffReport({ ...range, branchIds: [base.branches[0].id] }, adminActor);
    expect(only1.byStaff.map((r) => r.staffId)).toEqual([lan]);
  });
});
