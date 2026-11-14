import { AdjustmentType, PaymentMethod, PrismaClient, ReceiptStatus, Supplier } from '@prisma/client';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { PrismaService } from 'src/common/databases/prisma.service';
import { AuthRole } from 'src/common/types/common.enum';
import { addDaysToDateOnly, todayInVietnam } from 'src/common/utils/date-only.util';
import { createTestPrisma, resetSchema } from 'src/test-support/db-test';
import { ReportBase, seedReportBase } from 'src/test-support/report-db-seed';
import { PermissionService } from '../../feature-auth/permission/permission.service';
import { SupplierListWithTotalsRepository } from '../../feature-inventory/supplier/repositories/supplier-list-with-totals.repository';
import { InMemoryReportCache } from '../report-cache';
import { SupplierReportRepository } from './supplier-report.repository';
import { SupplierReportService } from './supplier-report.service';

const adminActor = { user: { userId: 'u', role: AuthRole.ADMIN, branchId: null } } as unknown as RequestActor;
const pmActor = (branchId: string) =>
  ({ user: { userId: 'u', role: AuthRole.PHARMACY_MANAGER, branchId } }) as unknown as RequestActor;

/** Giờ VN → UTC cho dữ liệu mẫu. */
const vn = (iso: string) => new Date(`${iso}+07:00`);

describe('GET /reports/supplier — truy vấn thật (db)', () => {
  let prisma: PrismaClient;
  let base: ReportBase;
  let service: SupplierReportService;
  let granted: Set<string>;
  let sup: Supplier[];
  let seq = 0;

  beforeAll(async () => {
    prisma = await createTestPrisma();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetSchema(prisma);
    base = await seedReportBase(prisma);
    granted = new Set(['supplier-debt:read']);
    service = new SupplierReportService(
      new SupplierReportRepository(prisma as unknown as PrismaService),
      { getGrantedCodes: () => Promise.resolve(granted) } as unknown as PermissionService,
      new InMemoryReportCache(),
    );
    sup = [];
    for (const [i, name] of ['Dược Hậu Giang', 'Traphaco', 'Imexpharm'].entries()) {
      sup.push(await prisma.supplier.create({ data: { code: `NCC0${i + 1}`, name, phone: `09100000${i}` } }));
    }
  });

  const receipt = async (
    s: number,
    branch: number,
    total: number,
    confirmedAt: string,
    over: {
      status?: ReceiptStatus;
      paid?: number;
      deleted?: boolean;
      items?: { product: number; qty: number; amount: number }[];
    } = {},
  ) => {
    seq += 1;
    const status = over.status ?? ReceiptStatus.CONFIRMED;
    const created = await prisma.goodsReceipt.create({
      data: {
        code: `PN${String(seq).padStart(5, '0')}`,
        branchId: base.branches[branch].id,
        supplierId: sup[s].id,
        status,
        subtotalAmount: total,
        totalAmount: total,
        paidAmount: over.paid ?? 0,
        confirmedAt: vn(confirmedAt),
        cancelledAt: status === ReceiptStatus.CANCELLED ? vn(confirmedAt) : null,
        cancelReason: status === ReceiptStatus.CANCELLED ? 'Nhập nhầm' : null,
        isDeleted: over.deleted ?? false,
      },
    });
    for (const item of over.items ?? []) {
      await prisma.goodsReceiptItem.create({
        data: {
          receiptId: created.id,
          productId: base.products[item.product].id,
          productUnitId: base.productUnits[item.product].id,
          quantity: item.qty,
          conversionRate: 1,
          baseQuantity: item.qty,
          importPrice: Math.round(item.amount / item.qty),
          totalPrice: item.amount,
          batchNumber: 'LO',
          expiryDate: new Date('2030-01-01T00:00:00Z'),
        },
      });
    }
    return created;
  };

  /** Phiếu chi phân bổ vào các phiếu nhập; `cancelled` = đã huỷ. Giữ `paidAmount` của phiếu nhập khớp như nghiệp vụ thật. */
  const payment = async (
    s: number,
    paidAt: string,
    allocations: { receiptId: string; amount: number }[],
    cancelled = false,
  ) => {
    seq += 1;
    const total = allocations.reduce((sum, a) => sum + a.amount, 0);
    await prisma.supplierPayment.create({
      data: {
        code: `PC${String(seq).padStart(5, '0')}`,
        supplierId: sup[s].id,
        branchId: base.branches[0].id,
        paidAt: vn(paidAt),
        method: PaymentMethod.CASH,
        amount: total,
        cancelledAt: cancelled ? vn(paidAt) : null,
        allocations: { create: allocations.map((a) => ({ receiptId: a.receiptId, amount: a.amount })) },
      },
    });
    if (!cancelled) {
      for (const a of allocations) {
        await prisma.goodsReceipt.update({ where: { id: a.receiptId }, data: { paidAmount: { increment: a.amount } } });
      }
    }
  };

  const purchaseReturn = async (
    s: number,
    branch: number,
    total: number,
    supplierPaid: number,
    confirmedAt: string,
    status: ReceiptStatus = ReceiptStatus.CONFIRMED,
  ) => {
    seq += 1;
    await prisma.stockAdjustment.create({
      data: {
        code: `TH${String(seq).padStart(5, '0')}`,
        branchId: base.branches[branch].id,
        supplierId: sup[s].id,
        type: AdjustmentType.RETURN_TO_SUPPLIER,
        status,
        reason: 'Trả hàng lỗi',
        goodsAmount: total,
        totalAmount: total,
        supplierPaid,
        confirmedAt: vn(confirmedAt),
        cancelReason: status === ReceiptStatus.CANCELLED ? 'Trả nhầm' : null,
      },
    });
  };

  const adjustment = async (s: number, branch: number, delta: number, adjustedAt: string, cancelled = false) => {
    seq += 1;
    await prisma.supplierDebtAdjustment.create({
      data: {
        code: `DC${String(seq).padStart(5, '0')}`,
        supplierId: sup[s].id,
        branchId: base.branches[branch].id,
        adjustedAt: vn(adjustedAt),
        debtBefore: Math.max(0, -delta),
        debtAfter: Math.max(0, -delta) + delta,
        delta,
        note: 'Điều chỉnh',
        cancelledAt: cancelled ? vn(adjustedAt) : null,
      },
    });
  };

  it('ví dụ contract: nợ đầu 5.000.000, nhập 20.000.000, trả 1.000.000, chi 15.000.000 → nợ cuối 9.000.000', async () => {
    const old = await receipt(0, 0, 5_000_000, '2026-10-20T10:00:00');
    const r1 = await receipt(0, 0, 20_000_000, '2026-11-05T10:00:00', {
      items: [{ product: 0, qty: 100, amount: 20_000_000 }],
    });
    await purchaseReturn(0, 0, 1_000_000, 0, '2026-11-10T09:00:00');
    await payment(0, '2026-11-12T09:00:00', [{ receiptId: r1.id, amount: 15_000_000 }]);
    expect(old.id).toBeDefined();

    const report = await service.supplierReport({ from: '2026-11-01', to: '2026-11-30' }, adminActor);

    expect(report.bySupplier).toEqual([
      {
        supplierId: sup[0].id,
        supplierCode: 'NCC01',
        supplierName: 'Dược Hậu Giang',
        receiptCount: 1,
        purchaseAmount: 20_000_000,
        returnCount: 1,
        returnAmount: 1_000_000,
        paidAmount: 15_000_000,
        adjustmentAmount: 0,
        openingDebt: 5_000_000,
        closingDebt: 9_000_000,
      },
    ]);
    expect(report.totals).toEqual({
      purchaseAmount: 20_000_000,
      returnAmount: 1_000_000,
      paidAmount: 15_000_000,
      adjustmentAmount: 0,
      openingDebt: 5_000_000,
      closingDebt: 9_000_000,
    });
    expect(report.topProducts).toEqual([
      { productId: base.products[0].id, productName: 'Paracetamol', qtyBase: 100, amount: 20_000_000 },
    ]);
  });

  it('ranh giới ngày giờ VN: 23:59:59 ngày to tính vào kỳ, 00:00 ngày kế tiếp thì không; 00:00 ngày from tính vào kỳ, 23:59:59 hôm trước là nợ đầu kỳ', async () => {
    await receipt(0, 0, 100, '2026-10-31T23:59:59'); // đầu kỳ
    await receipt(0, 0, 200, '2026-11-01T00:00:00'); // trong kỳ (mốc đầu)
    await receipt(0, 0, 400, '2026-11-30T23:59:59'); // trong kỳ (mốc cuối)
    await receipt(0, 0, 800, '2026-12-01T00:00:00'); // sau kỳ

    const report = await service.supplierReport({ from: '2026-11-01', to: '2026-11-30' }, adminActor);

    expect(report.bySupplier[0]).toMatchObject({
      receiptCount: 2,
      purchaseAmount: 600,
      openingDebt: 100,
      closingDebt: 700,
    });
  });

  it('chứng từ huỷ/xoá bằng 0: phiếu nhập huỷ, xoá mềm, nháp; phiếu chi huỷ; phiếu trả huỷ; điều chỉnh huỷ', async () => {
    const good = await receipt(0, 0, 1000, '2026-11-02T10:00:00');
    await receipt(0, 0, 5000, '2026-11-02T10:00:00', { status: ReceiptStatus.CANCELLED });
    await receipt(0, 0, 6000, '2026-11-02T10:00:00', { deleted: true });
    await receipt(0, 0, 7000, '2026-11-02T10:00:00', { status: ReceiptStatus.DRAFT });
    await payment(0, '2026-11-03T10:00:00', [{ receiptId: good.id, amount: 300 }]);
    await payment(0, '2026-11-03T11:00:00', [{ receiptId: good.id, amount: 999 }], true); // huỷ
    await purchaseReturn(0, 0, 400, 0, '2026-11-04T10:00:00');
    await purchaseReturn(0, 0, 9000, 0, '2026-11-04T10:00:00', ReceiptStatus.CANCELLED);
    await adjustment(0, 0, 50, '2026-11-05T10:00:00');
    await adjustment(0, 0, 8888, '2026-11-05T10:00:00', true);

    const report = await service.supplierReport({ from: '2026-11-01', to: '2026-11-30' }, adminActor);
    const row = report.bySupplier[0];

    expect(row).toMatchObject({
      receiptCount: 1,
      purchaseAmount: 1000,
      returnCount: 1,
      returnAmount: 400,
      paidAmount: 300,
      adjustmentAmount: 50,
      openingDebt: 0,
      closingDebt: 350,
    });
  });

  it('phiếu trả NCC: chỉ phần chưa hoàn tiền (totalAmount − supplierPaid) giảm nợ', async () => {
    await receipt(0, 0, 1000, '2026-11-02T10:00:00');
    await purchaseReturn(0, 0, 600, 250, '2026-11-04T10:00:00');
    const report = await service.supplierReport({ from: '2026-11-01', to: '2026-11-30' }, adminActor);
    expect(report.bySupplier[0]).toMatchObject({ returnAmount: 350, returnCount: 1, closingDebt: 650 });
  });

  it('phạm vi chi nhánh: ADMIN lọc CN2 chỉ tính chứng từ (và phân bổ vào phiếu) của CN2; PM chỉ CN mình, xin CN khác → 1506', async () => {
    const [cn1, cn2] = base.branches;
    const r1 = await receipt(0, 0, 1000, '2026-11-02T10:00:00');
    const r2 = await receipt(0, 1, 2000, '2026-11-02T10:00:00');
    await payment(0, '2026-11-03T10:00:00', [
      { receiptId: r1.id, amount: 100 },
      { receiptId: r2.id, amount: 200 },
    ]);
    await purchaseReturn(0, 1, 50, 0, '2026-11-04T10:00:00');
    await adjustment(0, 0, 7, '2026-11-05T10:00:00');
    await adjustment(0, 1, 11, '2026-11-05T10:00:00');

    const q = { from: '2026-11-01', to: '2026-11-30' };
    const all = await service.supplierReport(q, adminActor);
    expect(all.bySupplier[0]).toMatchObject({
      purchaseAmount: 3000,
      paidAmount: 300,
      returnAmount: 50,
      adjustmentAmount: 18,
    });

    const only2 = await service.supplierReport({ ...q, branchIds: [cn2.id] }, adminActor);
    expect(only2.bySupplier[0]).toMatchObject({
      receiptCount: 1,
      purchaseAmount: 2000,
      paidAmount: 200, // chỉ phần phân bổ vào phiếu CN2
      returnAmount: 50,
      adjustmentAmount: 11,
      closingDebt: 2000 - 200 - 50 + 11,
    });

    const pm = await service.supplierReport(q, pmActor(cn1.id));
    expect(pm.bySupplier[0]).toMatchObject({
      purchaseAmount: 1000,
      paidAmount: 100,
      returnAmount: 0,
      adjustmentAmount: 7,
    });
    await expect(service.supplierReport({ ...q, branchIds: [cn2.id] }, pmActor(cn1.id))).rejects.toMatchObject({
      response: { code: 1506 },
    });
  });

  it('bySupplier: có phát sinh HOẶC nợ đầu kỳ ≠ 0; sắp theo purchaseAmount giảm dần rồi supplierId; lọc supplierId', async () => {
    await receipt(0, 0, 100, '2026-11-02T10:00:00');
    await receipt(1, 0, 900, '2026-11-02T10:00:00');
    await receipt(2, 0, 50, '2026-10-02T10:00:00'); // chỉ nợ cũ, kỳ này không phát sinh
    // NCC khác chỉ có nợ đã trả hết trước kỳ: nợ đầu 0 và không phát sinh → không hiện
    const old = await receipt(2, 0, 70, '2026-10-02T10:00:00', { items: [{ product: 1, qty: 7, amount: 70 }] });
    await payment(2, '2026-10-05T10:00:00', [{ receiptId: old.id, amount: 70 }]);

    const report = await service.supplierReport({ from: '2026-11-01', to: '2026-11-30' }, adminActor);
    expect(report.bySupplier.map((s) => [s.supplierCode, s.purchaseAmount, s.openingDebt])).toEqual([
      ['NCC02', 900, 0],
      ['NCC01', 100, 0],
      ['NCC03', 0, 50],
    ]);

    const one = await service.supplierReport(
      { from: '2026-11-01', to: '2026-11-30', supplierId: sup[1].id },
      adminActor,
    );
    expect(one.bySupplier.map((s) => s.supplierCode)).toEqual(['NCC02']);
    expect(one.totals.purchaseAmount).toBe(900);
  });

  it('bất biến closing = opening + nhập − trả − chi + điều chỉnh trên dữ liệu hỗn hợp, và NCC có phát sinh chỉ ở phiếu chi/điều chỉnh vẫn hiện', async () => {
    const a = await receipt(0, 0, 1000, '2026-09-10T10:00:00');
    await payment(0, '2026-09-20T10:00:00', [{ receiptId: a.id, amount: 400 }]);
    await adjustment(0, 0, -30, '2026-10-01T10:00:00');
    const b = await receipt(0, 0, 3000, '2026-11-10T10:00:00');
    await payment(0, '2026-11-15T10:00:00', [{ receiptId: b.id, amount: 1200 }]);
    await adjustment(0, 0, 90, '2026-11-20T10:00:00');
    await purchaseReturn(0, 0, 500, 100, '2026-11-21T10:00:00');
    // NCC 2: chỉ có phiếu chi trong kỳ cho phiếu nhập cũ
    const c = await receipt(1, 0, 800, '2026-08-01T10:00:00');
    await payment(1, '2026-11-03T10:00:00', [{ receiptId: c.id, amount: 800 }]);

    const report = await service.supplierReport({ from: '2026-11-01', to: '2026-11-30' }, adminActor);

    for (const s of report.bySupplier) {
      expect(s.closingDebt).toBe(
        s.openingDebt! + s.purchaseAmount - s.returnAmount - s.paidAmount! + s.adjustmentAmount!,
      );
    }
    expect(report.bySupplier.find((s) => s.supplierCode === 'NCC01')).toMatchObject({
      openingDebt: 1000 - 400 - 30,
      closingDebt: 570 + 3000 - 400 - 1200 + 90,
    });
    expect(report.bySupplier.find((s) => s.supplierCode === 'NCC02')).toMatchObject({
      openingDebt: 800,
      paidAmount: 800,
      closingDebt: 0,
    });
  });

  it('kiểm chéo: với to = hôm nay, closingDebt mỗi NCC = currentDebt của danh sách NCC (toàn chuỗi và theo chi nhánh)', async () => {
    const today = todayInVietnam();
    const r0 = await receipt(0, 0, 1000, `${addDaysToDateOnly(today, -40)}T10:00:00`);
    const r1 = await receipt(0, 1, 2500, `${addDaysToDateOnly(today, -5)}T10:00:00`);
    const r2 = await receipt(1, 0, 4000, `${addDaysToDateOnly(today, -3)}T10:00:00`);
    await receipt(1, 0, 999, `${addDaysToDateOnly(today, -3)}T10:00:00`, { status: ReceiptStatus.CANCELLED });
    await payment(0, `${addDaysToDateOnly(today, -2)}T10:00:00`, [
      { receiptId: r0.id, amount: 300 },
      { receiptId: r1.id, amount: 500 },
    ]);
    await payment(1, `${addDaysToDateOnly(today, -2)}T11:00:00`, [{ receiptId: r2.id, amount: 1000 }], true);
    await purchaseReturn(0, 1, 700, 200, `${addDaysToDateOnly(today, -1)}T10:00:00`);
    await adjustment(1, 0, 123, `${addDaysToDateOnly(today, -1)}T10:00:00`);
    await adjustment(1, 1, -45, `${addDaysToDateOnly(today, -1)}T10:00:00`);

    const list = new SupplierListWithTotalsRepository(prisma as unknown as PrismaService);
    const from = addDaysToDateOnly(today, -60);
    for (const [branchIdx, ids] of [
      [undefined, undefined],
      [0, [base.branches[0].id]],
      [1, [base.branches[1].id]],
    ] as const) {
      const report = await service.supplierReport(
        { from, to: today, branchIds: ids ? [...ids] : undefined },
        adminActor,
      );
      const page = await list.findPage({
        branchId: branchIdx === undefined ? undefined : base.branches[branchIdx].id,
        canSeeDebt: true,
        page: 1,
        limit: 50,
      });
      for (const row of page.rows) {
        const mine = report.bySupplier.find((s) => s.supplierId === row.id);
        expect(mine?.closingDebt ?? 0).toBe(row.currentDebt);
      }
    }
  });

  it('thiếu supplier-debt:read: nợ/chi/điều chỉnh là null, NCC chỉ có nợ cũ không lộ ra, số nhập/trả vẫn đúng', async () => {
    granted = new Set(['report:read']);
    await receipt(0, 0, 777_777, '2026-10-01T10:00:00'); // nợ cũ bí mật
    const r = await receipt(1, 0, 900, '2026-11-02T10:00:00');
    await payment(1, '2026-11-03T10:00:00', [{ receiptId: r.id, amount: 400 }]);
    await adjustment(1, 0, 321, '2026-11-04T10:00:00');
    await purchaseReturn(1, 0, 100, 0, '2026-11-05T10:00:00');

    const report = await service.supplierReport({ from: '2026-11-01', to: '2026-11-30' }, adminActor);

    expect(report.bySupplier).toEqual([
      {
        supplierId: sup[1].id,
        supplierCode: 'NCC02',
        supplierName: 'Traphaco',
        receiptCount: 1,
        purchaseAmount: 900,
        returnCount: 1,
        returnAmount: 100,
        paidAmount: null,
        adjustmentAmount: null,
        openingDebt: null,
        closingDebt: null,
      },
    ]);
    expect(report.totals).toEqual({
      purchaseAmount: 900,
      returnAmount: 100,
      paidAmount: null,
      adjustmentAmount: null,
      openingDebt: null,
      closingDebt: null,
    });
    const json = JSON.stringify(report);
    expect(json).not.toContain('777777');
    expect(json).not.toContain('321');
  });

  it('topProducts: ≤ 10, theo Σ totalPrice dòng chưa xoá của phiếu nhập trong kỳ; bỏ phiếu huỷ/ngoài kỳ/dòng xoá', async () => {
    await receipt(0, 0, 0, '2026-11-02T10:00:00', {
      items: [
        { product: 0, qty: 10, amount: 500 },
        { product: 1, qty: 5, amount: 900 },
      ],
    });
    await receipt(1, 0, 0, '2026-11-03T10:00:00', { items: [{ product: 0, qty: 20, amount: 700 }] });
    await receipt(0, 0, 0, '2026-11-03T10:00:00', {
      status: ReceiptStatus.CANCELLED,
      items: [{ product: 2, qty: 1, amount: 99999 }],
    });
    await receipt(0, 0, 0, '2026-10-03T10:00:00', { items: [{ product: 2, qty: 1, amount: 88888 }] });
    const r = await receipt(0, 0, 0, '2026-11-04T10:00:00', { items: [{ product: 2, qty: 5, amount: 5000 }] });
    await prisma.goodsReceiptItem.updateMany({ where: { receiptId: r.id }, data: { isDeleted: true } });

    const report = await service.supplierReport({ from: '2026-11-01', to: '2026-11-30' }, adminActor);
    expect(report.topProducts).toEqual([
      { productId: base.products[0].id, productName: 'Paracetamol', qtyBase: 30, amount: 1200 },
      { productId: base.products[1].id, productName: 'Vitamin C', qtyBase: 5, amount: 900 },
    ]);

    const only = await service.supplierReport(
      { from: '2026-11-01', to: '2026-11-30', supplierId: sup[1].id },
      adminActor,
    );
    expect(only.topProducts).toEqual([
      { productId: base.products[0].id, productName: 'Paracetamol', qtyBase: 20, amount: 700 },
    ]);
  });
});
