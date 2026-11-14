import {
  OrderChannel,
  OrderStatus,
  PaymentKind,
  PaymentMethod,
  PaymentStatus,
  PrismaClient,
  ReceiptStatus,
  TransactionStatus,
} from '@prisma/client';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { PrismaService } from 'src/common/databases/prisma.service';
import { AuthRole } from 'src/common/types/common.enum';
import { createTestPrisma, resetSchema } from 'src/test-support/db-test';
import { ReportBase, seedReportBase } from 'src/test-support/report-db-seed';
import { InMemoryReportCache } from '../report-cache';
import { EndOfDayReportRepository } from './end-of-day-report.repository';
import { EndOfDayReportService } from './end-of-day-report.service';

const vn = (iso: string) => new Date(`${iso}+07:00`);
const adminActor = { user: { userId: 'u', role: AuthRole.ADMIN, branchId: null } } as unknown as RequestActor;
const DAY = '2026-11-10';

describe('GET /reports/end-of-day — truy vấn thật (db)', () => {
  let prisma: PrismaClient;
  let base: ReportBase;
  let service: EndOfDayReportService;
  let staff: { id: string }[];
  let supplierId: string;

  beforeAll(async () => {
    prisma = await createTestPrisma();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetSchema(prisma);
    base = await seedReportBase(prisma);
    service = new EndOfDayReportService(
      new EndOfDayReportRepository(prisma as unknown as PrismaService),
      new InMemoryReportCache(),
    );
    const role = await prisma.role.create({ data: { code: 'STAFF_T', name: 'NV', level: 10 } as never });
    staff = [
      await prisma.user.create({ data: { fullName: 'Lan', roleId: role.id } }),
      await prisma.user.create({ data: { fullName: 'Hùng', roleId: role.id } }),
    ];
    supplierId = (await prisma.supplier.create({ data: { code: 'NCC1', name: 'Dược Hậu Giang', phone: '0900000001' } }))
      .id;
  });

  let seq = 0;
  interface PayInput {
    method?: PaymentMethod;
    kind?: PaymentKind;
    amount: number;
    at: string;
    status?: TransactionStatus;
  }
  interface OrderInput {
    branch?: number;
    staff?: number | null;
    status?: OrderStatus;
    completedAt?: string | null;
    cancelledAt?: string | null;
    lines?: { product: number; qty: number; price: number }[];
    payments?: PayInput[];
  }
  const order = async (input: OrderInput) => {
    seq += 1;
    const lines = input.lines ?? [{ product: 0, qty: 1, price: 1000 }];
    const total = lines.reduce((s, l) => s + l.qty * l.price, 0);
    const status = input.status ?? OrderStatus.COMPLETED;
    const o = await prisma.order.create({
      data: {
        code: `DH${String(seq).padStart(6, '0')}`,
        branchId: base.branches[input.branch ?? 0].id,
        staffId: input.staff === null ? null : staff[input.staff ?? 0].id,
        channel: OrderChannel.POS,
        status,
        paymentStatus: PaymentStatus.PAID,
        subtotalAmount: total,
        totalAmount: total,
        completedAt: input.completedAt === null ? null : vn(input.completedAt ?? `${DAY}T10:00:00`),
        cancelledAt: input.cancelledAt ? vn(input.cancelledAt) : null,
        cancelReason: status === OrderStatus.CANCELLED ? 'Khách đổi ý' : null,
      },
    });
    for (const l of lines) {
      await prisma.orderItem.create({
        data: {
          orderId: o.id,
          productId: base.products[l.product].id,
          productUnitId: base.productUnits[l.product].id,
          productName: base.products[l.product].name,
          unitName: 'Viên',
          conversionRate: 1,
          quantity: l.qty,
          baseQuantity: l.qty,
          unitPrice: l.price,
          totalPrice: BigInt(l.qty * l.price),
        },
      });
    }
    for (const p of input.payments ?? []) {
      await prisma.payment.create({
        data: {
          orderId: o.id,
          kind: p.kind ?? PaymentKind.PAYMENT,
          method: p.method ?? PaymentMethod.CASH,
          amount: BigInt(p.amount),
          status: p.status ?? TransactionStatus.SUCCESS,
          paidAt: vn(p.at),
        },
      });
    }
    return o;
  };

  it('ví dụ contract: thu 3tr (mặt 2tr + CK 1tr), hoàn mặt 200k cho đơn hôm qua → net 2.800.000, CASH net 1.800.000', async () => {
    await order({
      staff: 0,
      lines: [{ product: 0, qty: 2, price: 1_000_000 }],
      payments: [{ amount: 2_000_000, at: `${DAY}T09:00:00` }],
    });
    await order({
      staff: 1,
      lines: [{ product: 1, qty: 1, price: 1_000_000 }],
      payments: [{ amount: 1_000_000, method: PaymentMethod.BANK_TRANSFER, at: `${DAY}T11:00:00` }],
    });
    // Đơn thu hôm qua (09/11), huỷ hôm nay, hoàn tiền mặt 200k trong ngày.
    await order({
      staff: 0,
      status: OrderStatus.CANCELLED,
      completedAt: '2026-11-09T15:00:00',
      cancelledAt: `${DAY}T14:00:00`,
      payments: [
        { amount: 500_000, at: '2026-11-09T15:00:00' },
        { amount: 200_000, kind: PaymentKind.REFUND, at: `${DAY}T14:00:00` },
      ],
    });

    const report = await service.endOfDay({ date: DAY }, adminActor);

    expect(report.sales).toEqual({
      orderCount: 2,
      grossAmount: 3_000_000,
      refundAmount: 200_000,
      netAmount: 2_800_000,
      cancelledCount: 1,
    });
    expect(report.byMethod).toEqual([
      { method: 'CASH', received: 2_000_000, refunded: 200_000, net: 1_800_000 },
      { method: 'BANK_TRANSFER', received: 1_000_000, refunded: 0, net: 1_000_000 },
      { method: 'CARD', received: 0, refunded: 0, net: 0 },
    ]);
    // Lan: 2 đơn... chỉ 1 đơn COMPLETED trong ngày; ròng = 2.000.000 − 200.000 (hoàn đơn của Lan). Hùng: 1.000.000.
    expect(report.byStaff).toEqual(
      [
        { staffId: staff[1].id, staffName: 'Hùng', orderCount: 1, netAmount: 1_000_000 },
        { staffId: staff[0].id, staffName: 'Lan', orderCount: 1, netAmount: 1_800_000 },
      ].sort((a, b) => b.netAmount - a.netAmount),
    );
    expect(report.topProducts).toEqual([
      { productId: base.products[0].id, productName: 'Paracetamol', qtyBase: 2, amount: 2_000_000 },
      { productId: base.products[1].id, productName: 'Vitamin C', qtyBase: 1, amount: 1_000_000 },
    ]);
  });

  it('ranh giới ngày giờ VN: 23:59 và 00:00 rơi đúng ngày; payment FAILED/PENDING và đơn đang xử lý không tính', async () => {
    await order({ completedAt: `${DAY}T00:00:00`, payments: [{ amount: 100, at: `${DAY}T00:00:00` }] }); // đầu ngày: vào
    await order({ completedAt: `${DAY}T23:59:59`, payments: [{ amount: 200, at: `${DAY}T23:59:59` }] }); // cuối ngày: vào
    await order({ completedAt: '2026-11-09T23:59:59', payments: [{ amount: 400, at: '2026-11-09T23:59:59' }] }); // hôm qua
    await order({ completedAt: '2026-11-11T00:00:00', payments: [{ amount: 800, at: '2026-11-11T00:00:00' }] }); // ngày mai
    await order({
      payments: [
        { amount: 1600, at: `${DAY}T10:00:00`, status: TransactionStatus.FAILED },
        { amount: 3200, at: `${DAY}T10:00:00`, status: TransactionStatus.PENDING },
      ],
    });
    await order({ status: OrderStatus.PENDING, completedAt: null, payments: [] });

    const report = await service.endOfDay({ date: DAY }, adminActor);
    expect(report.sales.grossAmount).toBe(300);
    expect(report.sales.orderCount).toBe(3); // 2 đơn có thu + đơn chỉ có payment lỗi vẫn COMPLETED trong ngày
    expect(report.sales.cancelledCount).toBe(0);
  });

  it('phiếu nhập / phiếu chi NCC: chỉ phiếu CONFIRMED trong ngày; phiếu chi đã huỷ không tính; theo chi nhánh', async () => {
    const receipt = (code: string, over: Record<string, unknown>) =>
      prisma.goodsReceipt.create({
        data: {
          code,
          branchId: base.branches[0].id,
          supplierId,
          status: ReceiptStatus.CONFIRMED,
          totalAmount: 1000n,
          subtotalAmount: (over.totalAmount as bigint | undefined) ?? 1000n,
          confirmedAt: vn(`${DAY}T08:00:00`),
          ...over,
        } as never,
      });
    await receipt('PN1', { totalAmount: 5_000_000n });
    await receipt('PN2', { totalAmount: 2_000_000n, confirmedAt: vn(`${DAY}T23:59:00`) });
    await receipt('PN3', { confirmedAt: vn('2026-11-09T23:59:00') }); // hôm qua
    await receipt('PN4', { status: ReceiptStatus.DRAFT, confirmedAt: null });
    await receipt('PN5', { branchId: base.branches[1].id, totalAmount: 9_000_000n });
    const pay = (code: string, over: Record<string, unknown>) =>
      prisma.supplierPayment.create({
        data: {
          code,
          supplierId,
          branchId: base.branches[0].id,
          paidAt: vn(`${DAY}T09:00:00`),
          method: PaymentMethod.BANK_TRANSFER,
          amount: 1_000_000n,
          ...over,
        } as never,
      });
    await pay('TT1', {});
    await pay('TT2', { method: PaymentMethod.CASH, amount: 300_000n });
    await pay('TT3', { cancelledAt: vn(`${DAY}T10:00:00`) });
    await pay('TT4', { paidAt: vn('2026-11-11T00:00:00') });
    await pay('TT5', { branchId: base.branches[1].id });

    const all = await service.endOfDay({ date: DAY }, adminActor);
    expect(all.supplier).toEqual({
      receiptCount: 3,
      receiptAmount: 16_000_000,
      paymentCount: 3,
      paymentAmount: 2_300_000,
      paymentByMethod: [
        { method: 'CASH', amount: 300_000 },
        { method: 'BANK_TRANSFER', amount: 2_000_000 },
      ],
    });
    const cn1 = await service.endOfDay({ date: DAY, branchIds: [base.branches[0].id] }, adminActor);
    expect(cn1.supplier).toMatchObject({
      receiptCount: 2,
      receiptAmount: 7_000_000,
      paymentCount: 2,
      paymentAmount: 1_300_000,
    });
  });

  it('topProducts ≤ 10 theo tiền; chỉ đơn COMPLETED trong ngày; lọc chi nhánh', async () => {
    await order({ lines: [{ product: 0, qty: 5, price: 100 }] }); // 500
    await order({ lines: [{ product: 1, qty: 1, price: 900 }] }); // 900
    await order({ branch: 1, lines: [{ product: 2, qty: 3, price: 1000 }] }); // 3000 CN2
    await order({
      status: OrderStatus.CANCELLED,
      cancelledAt: `${DAY}T12:00:00`,
      lines: [{ product: 2, qty: 100, price: 1000 }],
    }); // đơn huỷ: bỏ
    const all = await service.endOfDay({ date: DAY }, adminActor);
    expect(all.topProducts.map((p) => [p.productName, p.amount])).toEqual([
      ['Khẩu trang', 3000],
      ['Vitamin C', 900],
      ['Paracetamol', 500],
    ]);
    const cn1 = await service.endOfDay({ date: DAY, branchIds: [base.branches[0].id] }, adminActor);
    expect(cn1.topProducts.map((p) => p.productName)).toEqual(['Vitamin C', 'Paracetamol']);
  });

  it('đơn không có nhân viên không vào byStaff; ngày rỗng trả toàn 0', async () => {
    await order({ staff: null, payments: [{ amount: 100, at: `${DAY}T09:00:00` }] });
    const report = await service.endOfDay({ date: DAY }, adminActor);
    expect(report.byStaff).toEqual([]);
    expect(report.sales.grossAmount).toBe(100);
    const empty = await service.endOfDay({ date: '2026-01-01' }, adminActor);
    expect(empty.sales).toEqual({ orderCount: 0, grossAmount: 0, refundAmount: 0, netAmount: 0, cancelledCount: 0 });
    expect(empty.supplier.receiptCount).toBe(0);
  });
});
