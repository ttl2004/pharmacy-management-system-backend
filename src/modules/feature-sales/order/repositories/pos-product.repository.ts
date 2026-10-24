import { Injectable } from '@nestjs/common';
import { Prisma, RecordStatus } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';

/** Sản phẩm bán được: chưa xoá, đang kinh doanh. */
const SELLABLE_PRODUCT: Prisma.ProductWhereInput = { isDeleted: false, status: RecordStatus.ACTIVE };
const SELLABLE_UNIT: Prisma.ProductUnitWhereInput = { isDeleted: false, status: RecordStatus.ACTIVE };

const POS_PRODUCT_SELECT = {
  id: true,
  code: true,
  name: true,
  imageUrls: true,
  requiresPrescription: true,
  isControlled: true,
  units: {
    where: SELLABLE_UNIT,
    orderBy: [{ conversionRate: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      conversionRate: true,
      salePrice: true,
      barcode: true,
      isBaseUnit: true,
      unit: { select: { name: true } },
    },
  },
} satisfies Prisma.ProductSelect;

export type PosProductRow = Prisma.ProductGetPayload<{ select: typeof POS_PRODUCT_SELECT }>;

/** Đọc danh mục + tồn bán được cho màn bán tại quầy. Chỉ đọc, không khoá lô. */
@Injectable()
export class PosProductRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findPage(where: Prisma.ProductWhereInput, page: number, limit: number) {
    const fullWhere = { AND: [SELLABLE_PRODUCT, where] };
    const [rows, total] = await Promise.all([
      this.prisma.product.findMany({
        where: fullWhere,
        select: POS_PRODUCT_SELECT,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        take: limit,
        skip: (page - 1) * limit,
      }),
      this.prisma.product.count({ where: fullWhere }),
    ]);
    return { rows, total };
  }

  /** Mã vạch là duy nhất trên cả `products` lẫn `product_units` (catalog đã kiểm khi ghi) — tối đa một sản phẩm. */
  findByBarcode(barcode: string): Promise<PosProductRow | null> {
    return this.prisma.product.findFirst({
      where: { AND: [SELLABLE_PRODUCT, { OR: [{ barcode }, { units: { some: { ...SELLABLE_UNIT, barcode } } }] }] },
      select: POS_PRODUCT_SELECT,
    });
  }

  /**
   * Lượng bán được (đơn vị cơ bản) của từng sản phẩm tại chi nhánh — cùng điều kiện lô mà FEFO chọn khi giữ hàng
   * (`StockBatchRepository.lockSellable`): AVAILABLE, còn hạn, trừ phần đang giữ cho đơn khác. MỘT câu lệnh.
   */
  async sellableQuantities(
    branchId: string,
    productIds: readonly string[],
    today: string,
  ): Promise<Map<string, number>> {
    if (!productIds.length) return new Map();
    const ids = Prisma.join(productIds.map((id) => Prisma.sql`${id}::uuid`));
    const rows = await this.prisma.$queryRaw<{ productId: string; quantity: bigint }[]>(Prisma.sql`
      SELECT "productId", SUM("quantityOnHand" - "reservedQuantity")::bigint AS "quantity"
      FROM "stock_batches"
      WHERE "branchId" = ${branchId}::uuid AND "productId" IN (${ids})
        AND "status" = 'AVAILABLE' AND "expiryDate" > ${today}::date
        AND "quantityOnHand" > "reservedQuantity" AND "isDeleted" = false
      GROUP BY "productId"`);
    return new Map(rows.map((row) => [row.productId, Number(row.quantity)]));
  }
}
