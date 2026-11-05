import {
  Branch,
  Product,
  ProductUnit,
  OrderChannel,
  OrderStatus,
  PaymentKind,
  PaymentMethod,
  PaymentStatus,
  PrismaClient,
  ProductType,
  TransactionStatus,
} from '@prisma/client';

/** Dữ liệu mẫu cho db-spec của báo cáo doanh thu: 2 chi nhánh, 3 sản phẩm, mỗi (chi nhánh, sản phẩm) một lô. */
export async function seedReportBase(prisma: PrismaClient) {
  const unit = await prisma.unit.create({ data: { code: 'VIEN', name: 'Viên' } });
  const category = await prisma.category.create({ data: { name: 'Thuốc' } });
  const branches: Branch[] = [];
  for (const [i, name] of ['Chi nhánh 1', 'Chi nhánh 2'].entries()) {
    branches.push(
      await prisma.branch.create({ data: { code: `CN0${i + 1}`, name, phone: `090000000${i}`, address: 'Hà Nội' } }),
    );
  }
  const products: Product[] = [];
  const productUnits: ProductUnit[] = [];
  for (const [i, name] of ['Paracetamol', 'Vitamin C', 'Khẩu trang'].entries()) {
    const product = await prisma.product.create({
      data: { code: `SP0${i + 1}`, name, type: ProductType.GOODS, categoryId: category.id, baseUnitId: unit.id },
    });
    products.push(product);
    productUnits.push(
      await prisma.productUnit.create({
        data: { productId: product.id, unitId: unit.id, conversionRate: 1, salePrice: 1000, isBaseUnit: true },
      }),
    );
  }
  const batches: Record<string, { id: string }> = {};
  for (const b of branches) {
    for (const p of products) {
      batches[`${b.id}:${p.id}`] = await prisma.stockBatch.create({
        data: {
          branchId: b.id,
          productId: p.id,
          batchNumber: 'LO-01',
          expiryDate: new Date('2030-01-01T00:00:00Z'),
          importPrice: 500,
        },
      });
    }
  }
  return { branches, products, productUnits, batches };
}

export type ReportBase = Awaited<ReturnType<typeof seedReportBase>>;

export interface SeedOrderLine {
  product: number;
  /** Số lượng theo đơn vị gốc (tỷ lệ quy đổi 1). */
  qty: number;
  unitPrice: number;
  unitCost: number;
}

export interface SeedOrderInput {
  branch: number;
  completedAt: Date;
  /** Đơn mới lập, chưa thu: PENDING, không `completedAt`, không thanh toán. */
  pending?: boolean;
  lines: SeedOrderLine[];
  channel?: OrderChannel;
  /** Có = đơn đã huỷ sau khi thu, với số tiền hoàn tương ứng (0n = đơn 0đ / không hoàn). */
  voidedRefund?: bigint;
}

let orderSeq = 0;

/** Ghi thẳng một đơn đã thu (COMPLETED) hoặc đã thu rồi huỷ (CANCELLED) cùng dòng, lô xuất và thanh toán. */
export async function seedPaidOrder(prisma: PrismaClient, base: ReportBase, input: SeedOrderInput) {
  orderSeq += 1;
  const branch = base.branches[input.branch];
  const total = input.lines.reduce((s, l) => s + BigInt(l.qty * l.unitPrice), 0n);
  const voided = input.voidedRefund !== undefined;
  const pending = input.pending === true;
  const order = await prisma.order.create({
    data: {
      code: `DH${String(orderSeq).padStart(6, '0')}`,
      branchId: branch.id,
      channel: input.channel ?? OrderChannel.POS,
      status: pending ? OrderStatus.PENDING : voided ? OrderStatus.CANCELLED : OrderStatus.COMPLETED,
      paymentStatus: pending ? PaymentStatus.UNPAID : voided ? PaymentStatus.REFUNDED : PaymentStatus.PAID,
      subtotalAmount: total,
      totalAmount: total,
      completedAt: pending ? null : input.completedAt,
      cancelledAt: voided ? input.completedAt : null,
      cancelReason: voided ? 'Khách đổi ý' : null,
    },
  });
  for (const line of input.lines) {
    const product = base.products[line.product];
    const item = await prisma.orderItem.create({
      data: {
        orderId: order.id,
        productId: product.id,
        productUnitId: base.productUnits[line.product].id,
        productName: product.name,
        unitName: 'Viên',
        conversionRate: 1,
        quantity: line.qty,
        baseQuantity: line.qty,
        unitPrice: line.unitPrice,
        totalPrice: BigInt(line.qty * line.unitPrice),
      },
    });
    await prisma.orderItemBatch.create({
      data: {
        orderItemId: item.id,
        batchId: base.batches[`${branch.id}:${product.id}`].id,
        quantity: line.qty,
        unitCost: line.unitCost,
      },
    });
  }
  if (total > 0n && !pending) {
    await prisma.payment.create({
      data: {
        orderId: order.id,
        method: PaymentMethod.CASH,
        amount: total,
        status: TransactionStatus.SUCCESS,
        paidAt: input.completedAt,
      },
    });
  }
  if (voided && (input.voidedRefund ?? 0n) > 0n) {
    await prisma.payment.create({
      data: {
        orderId: order.id,
        kind: PaymentKind.REFUND,
        method: PaymentMethod.CASH,
        amount: input.voidedRefund!,
        status: TransactionStatus.SUCCESS,
        paidAt: input.completedAt,
      },
    });
  }
  return { id: order.id, total };
}
