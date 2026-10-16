import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';
import { containsPattern } from 'src/common/utils/like-pattern.util';

const BATCH_SELECT = {
  id: true,
  batchNumber: true,
  manufacturingDate: true,
  expiryDate: true,
  quantityOnHand: true,
  reservedQuantity: true,
  importPrice: true,
  status: true,
  blockedReason: true,
  blockedAt: true,
  createdAt: true,
  updatedAt: true,
  branch: { select: { id: true, code: true, name: true } },
  product: { select: { id: true, code: true, name: true, baseUnit: { select: { id: true, name: true } } } },
  supplier: { select: { id: true, code: true, name: true } },
  blockedByUser: { select: { id: true, fullName: true } },
} satisfies Prisma.StockBatchSelect;

const MOVEMENT_SELECT = {
  id: true,
  createdAt: true,
  type: true,
  quantity: true,
  balanceAfter: true,
  unitCost: true,
  refType: true,
  refId: true,
  refItemId: true,
  note: true,
  branch: { select: { id: true, code: true, name: true } },
  product: { select: { id: true, code: true, name: true } },
  batch: { select: { id: true, batchNumber: true, expiryDate: true } },
  createdByUser: { select: { id: true, fullName: true } },
} satisfies Prisma.StockMovementSelect;

export type StockBatchRow = Prisma.StockBatchGetPayload<{ select: typeof BATCH_SELECT }>;
export type StockMovementRow = Prisma.StockMovementGetPayload<{ select: typeof MOVEMENT_SELECT }>;

export interface ProductStockRow {
  branchId: string;
  branchCode: string;
  productId: string;
  productCode: string;
  productName: string;
  onHand: number;
  reserved: number;
  /** Bán được ngay: lô AVAILABLE, còn hạn, trừ phần đang giữ cho đơn online. */
  sellable: number;
  nearestExpiry: Date | null;
  minStockLevel: number;
}

export interface MovementSummaryRow {
  productId: string;
  productCode: string;
  productName: string;
  opening: number;
  inQuantity: number;
  outQuantity: number;
  closing: number;
  importQty: number;
  saleQty: number;
  transferInQty: number;
  transferOutQty: number;
  adjustQty: number;
  disposeQty: number;
  returnInQty: number;
  returnOutQty: number;
}

/**
 * Đọc tồn kho, sổ kho, báo cáo. Chỉ đọc — không có hàm ghi. Báo cáo là một câu SQL gom nhóm, không kéo dòng về JS.
 *
 * Về sau có Redis: cache đặt ở `StockQueryService` (không ở đây), xoá theo `InventoryEvents.onStockChanged()`.
 */
@Injectable()
export class StockQueryRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findBatchPage(where: Prisma.StockBatchWhereInput, page: number, limit: number) {
    const fullWhere = { ...where, isDeleted: false };
    const [hits, total] = await Promise.all([
      this.prisma.stockBatch.findMany({
        where: fullWhere,
        select: BATCH_SELECT,
        orderBy: [{ expiryDate: 'asc' }, { id: 'asc' }],
        take: limit,
        skip: (page - 1) * limit,
      }),
      this.prisma.stockBatch.count({ where: fullWhere }),
    ]);
    return { hits, total, page, totalPages: Math.ceil(total / limit), limit };
  }

  findBatch(id: string, scopeWhere: { branchId?: string }): Promise<StockBatchRow | null> {
    return this.prisma.stockBatch.findFirst({ where: { id, isDeleted: false, ...scopeWhere }, select: BATCH_SELECT });
  }

  findMovements(where: Prisma.StockMovementWhereInput, take: number): Promise<StockMovementRow[]> {
    return this.prisma.stockMovement.findMany({
      where,
      select: MOVEMENT_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
    });
  }

  /** Tồn gộp theo (chi nhánh, sản phẩm) kèm ngưỡng của chi nhánh (rơi về ngưỡng chung của sản phẩm). */
  async findProductStockPage(
    filter: { branchId?: string; productId?: string; search?: string; today: Date },
    page: number,
    limit: number,
  ): Promise<{ hits: ProductStockRow[]; total: number; page: number; totalPages: number; limit: number }> {
    const conditions: Prisma.Sql[] = [Prisma.sql`b."isDeleted" = false`];
    if (filter.branchId) conditions.push(Prisma.sql`b."branchId" = ${filter.branchId}::uuid`);
    if (filter.productId) conditions.push(Prisma.sql`b."productId" = ${filter.productId}::uuid`);
    if (filter.search) {
      const pattern = containsPattern(filter.search);
      conditions.push(Prisma.sql`(p."name" ILIKE ${pattern} OR p."code" ILIKE ${pattern})`);
    }
    const where = Prisma.join(conditions, ' AND ');

    const grouped = Prisma.sql`
      SELECT b."branchId", br."code" AS "branchCode", b."productId", p."code" AS "productCode", p."name" AS "productName",
             SUM(b."quantityOnHand")::int AS "onHand",
             SUM(b."reservedQuantity")::int AS "reserved",
             SUM(CASE WHEN b."status" = 'AVAILABLE' AND b."expiryDate" > ${filter.today}::date
                      THEN b."quantityOnHand" - b."reservedQuantity" ELSE 0 END)::int AS "sellable",
             MIN(CASE WHEN b."quantityOnHand" > 0 THEN b."expiryDate" END) AS "nearestExpiry",
             COALESCE(bp."minStockLevel", p."minStockLevel")::int AS "minStockLevel"
      FROM "stock_batches" b
      JOIN "products" p ON p."id" = b."productId"
      JOIN "branches" br ON br."id" = b."branchId"
      LEFT JOIN "branch_products" bp
        ON bp."branchId" = b."branchId" AND bp."productId" = b."productId" AND bp."isDeleted" = false
      WHERE ${where}
      GROUP BY b."branchId", br."code", b."productId", p."code", p."name", bp."minStockLevel", p."minStockLevel"`;

    const [hits, [{ count }]] = await Promise.all([
      this.prisma.$queryRaw<ProductStockRow[]>(Prisma.sql`
        ${grouped}
        ORDER BY p."name", br."code"
        LIMIT ${limit} OFFSET ${(page - 1) * limit}`),
      this.prisma.$queryRaw<{ count: number }[]>(Prisma.sql`SELECT COUNT(*)::int AS "count" FROM (${grouped}) AS t`),
    ]);
    return { hits, total: count, page, totalPages: Math.ceil(count / limit), limit };
  }

  /**
   * Sản phẩm dưới ngưỡng tại MỘT chi nhánh. Đi từ `products` (không từ `stock_batches`) để sản phẩm có ngưỡng mà
   * chưa từng có lô nào ở chi nhánh vẫn hiện ra — đó chính là hàng cần nhập gấp nhất.
   */
  findLowStock(branchId: string, today: Date, page: number, limit: number) {
    return this.prisma.$queryRaw<(ProductStockRow & { shortage: number })[]>(Prisma.sql`
      WITH stock AS (
        SELECT b."productId",
               SUM(b."quantityOnHand")::int AS "onHand",
               SUM(b."reservedQuantity")::int AS "reserved",
               SUM(CASE WHEN b."status" = 'AVAILABLE' AND b."expiryDate" > ${today}::date
                        THEN b."quantityOnHand" - b."reservedQuantity" ELSE 0 END)::int AS "sellable",
               MIN(CASE WHEN b."quantityOnHand" > 0 THEN b."expiryDate" END) AS "nearestExpiry"
        FROM "stock_batches" b
        WHERE b."branchId" = ${branchId}::uuid AND b."isDeleted" = false
        GROUP BY b."productId"
      )
      SELECT ${branchId}::uuid AS "branchId", br."code" AS "branchCode", p."id" AS "productId", p."code" AS "productCode",
             p."name" AS "productName",
             COALESCE(s."onHand", 0) AS "onHand", COALESCE(s."reserved", 0) AS "reserved",
             COALESCE(s."sellable", 0) AS "sellable", s."nearestExpiry",
             COALESCE(bp."minStockLevel", p."minStockLevel")::int AS "minStockLevel",
             (COALESCE(bp."minStockLevel", p."minStockLevel") - COALESCE(s."sellable", 0))::int AS "shortage"
      FROM "products" p
      JOIN "branches" br ON br."id" = ${branchId}::uuid
      LEFT JOIN stock s ON s."productId" = p."id"
      LEFT JOIN "branch_products" bp
        ON bp."branchId" = ${branchId}::uuid AND bp."productId" = p."id" AND bp."isDeleted" = false
      WHERE p."isDeleted" = false AND p."status" = 'ACTIVE'
        AND COALESCE(bp."minStockLevel", p."minStockLevel") > 0
        AND COALESCE(s."sellable", 0) < COALESCE(bp."minStockLevel", p."minStockLevel")
      ORDER BY "shortage" DESC, p."name"
      LIMIT ${limit} OFFSET ${(page - 1) * limit}`);
  }

  /**
   * Nhập–xuất–tồn theo kỳ `[from, toExclusive)`: một lượt quét sổ kho, gom theo sản phẩm. Tồn đầu kỳ = tổng mọi bút
   * toán trước `from`; tồn cuối = đầu kỳ + phát sinh. Chi nhánh bỏ trống = gộp toàn chuỗi.
   */
  findMovementSummary(filter: { branchId?: string; from: Date; toExclusive: Date }): Promise<MovementSummaryRow[]> {
    const branchCondition = filter.branchId ? Prisma.sql`AND m."branchId" = ${filter.branchId}::uuid` : Prisma.empty;
    const inPeriod = Prisma.sql`m."createdAt" >= ${filter.from}`;
    const sumType = (type: string) =>
      Prisma.sql`SUM(CASE WHEN ${inPeriod} AND m."type" = ${type}::"StockMovementType" THEN m."quantity" ELSE 0 END)::int`;
    return this.prisma.$queryRaw<MovementSummaryRow[]>(Prisma.sql`
      SELECT m."productId", p."code" AS "productCode", p."name" AS "productName",
             SUM(CASE WHEN m."createdAt" < ${filter.from} THEN m."quantity" ELSE 0 END)::int AS "opening",
             SUM(CASE WHEN ${inPeriod} AND m."quantity" > 0 THEN m."quantity" ELSE 0 END)::int AS "inQuantity",
             SUM(CASE WHEN ${inPeriod} AND m."quantity" < 0 THEN -m."quantity" ELSE 0 END)::int AS "outQuantity",
             SUM(m."quantity")::int AS "closing",
             ${sumType('IMPORT')} AS "importQty",
             ${sumType('SALE')} AS "saleQty",
             ${sumType('TRANSFER_IN')} AS "transferInQty",
             ${sumType('TRANSFER_OUT')} AS "transferOutQty",
             ${sumType('ADJUST')} AS "adjustQty",
             ${sumType('DISPOSE')} AS "disposeQty",
             ${sumType('RETURN_IN')} AS "returnInQty",
             ${sumType('RETURN_OUT')} AS "returnOutQty"
      FROM "stock_movements" m
      JOIN "products" p ON p."id" = m."productId"
      WHERE m."createdAt" < ${filter.toExclusive} ${branchCondition}
      GROUP BY m."productId", p."code", p."name"
      ORDER BY p."name"`);
  }
}
