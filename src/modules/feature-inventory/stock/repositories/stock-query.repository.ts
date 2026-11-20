import { Injectable } from '@nestjs/common';
import { Prisma, StockRefType } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';
import { lockAdvisoryKeys } from 'src/common/databases/advisory-lock';
import { parseDateOnly, toDateOnlyString, todayInVietnam, vietnamDayStartUtc } from 'src/common/utils/date-only.util';
import { containsPattern } from 'src/common/utils/like-pattern.util';
import { INVENTORY_TX_MAX_WAIT_MS, INVENTORY_TX_TIMEOUT_MS } from '../../core/inventory.constants';
import { accumulateProductBalance, buildBalanceSegments, type SegmentSums } from './movement-product-balance';

/**
 * Lần dựng đầu trên sổ kho hàng triệu dòng vượt 5 s mặc định của Prisma → rollback, lần sau dựng lại từ đầu (không
 * bao giờ xong). `timeout` đủ rộng cho người dựng; `maxWait` cho người chờ kết nối. Request khác chờ khoá advisory
 * cũng nằm trong transaction cùng cấu hình nên không hết hạn trước người dựng.
 */
export const MONTHLY_BUILD_TX_OPTIONS = { timeout: 120_000, maxWait: 10_000 } as const;

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
export type StockMovementWithBalance = StockMovementRow & {
  /** Tồn thuốc (mọi lô) của chi nhánh ngay sau bút toán này — khác `balanceAfter` là tồn của riêng lô. */
  productBalanceAfter: number;
};

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
  baseUnitName: string;
  opening: number;
  inQuantity: number;
  outQuantity: number;
  closing: number;
  /** Giá trị tiền (đồng) theo giá vốn ghi trên từng bút toán. */
  openingValue: number;
  inValue: number;
  outValue: number;
  closingValue: number;
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
 * Đọc tồn kho, sổ kho, báo cáo. Không ghi dữ liệu nghiệp vụ — chỉ dựng bảng tổng hợp `stock_movement_monthly` (dựng
 * lại được). Báo cáo là câu SQL gom nhóm, không kéo dòng về JS.
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

  /**
   * Trang sổ kho (mới nhất trước, (createdAt, id) giảm dần), mỗi dòng kèm `productBalanceAfter` = tồn THUỐC (mọi lô) của chi nhánh ngay sau bút toán,
   * theo đúng thứ tự (createdAt, id) của danh sách. Bộ lọc của danh sách (lô, loại, chứng từ, ngày, con trỏ) KHÔNG áp
   * cho phần cộng: mọi bút toán của thuốc đều tính.
   *
   * Sổ kho là nguồn chân lý của tồn (mọi thay đổi `quantityOnHand` đi qua `StockLedgerService` và ghi một bút toán), nên
   * sau m = tồn hiện tại − Σ bút toán đứng sau m. Trang + tồn hiện tại + các tổng đọc trong MỘT transaction
   * REPEATABLE READ (chỉ đọc) → cùng một ảnh chụp, bút toán ghi xen giữa không làm lệch cột. Tối đa 2 câu SQL
   * bất kể số dòng/sản phẩm; mỗi sản phẩm quét sổ kho một lần (index `[branchId, productId, createdAt]`) từ dòng cũ
   * nhất của nó trong trang tới hiện tại — dòng giữa được suy ra bằng cộng dồn ở bộ nhớ (xem `movement-product-balance`).
   * Không lọc `isDeleted` ở lô: sổ kho đếm cả lô đã xoá nên tồn phải cùng cơ sở (hiện không có luồng nào xoá mềm lô).
   */
  findMovementsWithProductBalance(
    where: Prisma.StockMovementWhereInput,
    take: number,
  ): Promise<StockMovementWithBalance[]> {
    return this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.stockMovement.findMany({
          where,
          select: MOVEMENT_SELECT,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take,
        });
        if (!rows.length) return [];

        const balanceRows = rows.map((row) => ({
          id: row.id,
          createdAt: row.createdAt,
          branchId: row.branch.id,
          productId: row.product.id,
          quantity: row.quantity,
        }));
        const values = Prisma.join(
          buildBalanceSegments(balanceRows).map(
            (s) =>
              Prisma.sql`(${s.id}::uuid, ${s.branchId}::uuid, ${s.productId}::uuid, ${s.createdAt}::timestamptz,
                ${s.upperCreatedAt}::timestamptz, ${s.upperId}::uuid)`,
          ),
        );
        // `createdAt >=` / `<=` đứng riêng để index đi theo khoảng thời gian; so sánh bộ (createdAt, id) lọc tiếp.
        const sums = await tx.$queryRaw<{ id: string; onHand: bigint; segment: bigint }[]>(Prisma.sql`
          SELECT v."id",
                 (SELECT COALESCE(SUM(b."quantityOnHand"), 0) FROM "stock_batches" b
                  WHERE b."branchId" = v."branchId" AND b."productId" = v."productId")::bigint AS "onHand",
                 (SELECT COALESCE(SUM(m."quantity"), 0) FROM "stock_movements" m
                  WHERE m."branchId" = v."branchId" AND m."productId" = v."productId"
                    AND m."createdAt" >= v."createdAt" AND (m."createdAt", m."id") > (v."createdAt", v."id")
                    AND m."createdAt" <= COALESCE(v."upperCreatedAt", 'infinity'::timestamptz)
                    AND (v."upperCreatedAt" IS NULL OR (m."createdAt", m."id") <= (v."upperCreatedAt", v."upperId"))
                 )::bigint AS "segment"
          FROM (VALUES ${values}) AS v("id", "branchId", "productId", "createdAt", "upperCreatedAt", "upperId")`);

        const sumById = new Map<string, SegmentSums>(
          sums.map((r) => [r.id, { onHand: Number(r.onHand), segment: Number(r.segment) }]),
        );
        const balances = accumulateProductBalance(balanceRows, sumById);
        return rows.map((row) => ({ ...row, productBalanceAfter: balances.get(row.id)! }));
      },
      // Timeout tường minh: mặc định 5 s của Prisma có thể bị vượt khi trang sâu của hàng bán chạy phải cộng nhiều bút
      // toán — quá hạn là rollback và lỗi 500 thay vì trả chậm. Cùng trần với transaction kho.
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        timeout: INVENTORY_TX_TIMEOUT_MS,
        maxWait: INVENTORY_TX_MAX_WAIT_MS,
      },
    );
  }

  /**
   * Mã chứng từ đọc được của các dòng sổ kho (sổ kho chỉ lưu `refType` + `refId`). Gom theo loại → một truy vấn mỗi
   * loại có mặt; tồn đầu tham chiếu sản phẩm nên lấy mã hàng. Không lọc xoá mềm: chứng từ đã xoá vẫn là nguồn bút toán.
   */
  async findRefCodes(refs: readonly { refType: StockRefType; refId: string }[]): Promise<Map<string, string>> {
    const idsOf = (type: StockRefType) => [...new Set(refs.filter((r) => r.refType === type).map((r) => r.refId))];
    const pick = { id: true, code: true } as const;
    const query = <T>(ids: string[], run: (ids: string[]) => Promise<T[]>) =>
      ids.length ? run(ids) : Promise.resolve([]);
    const groups = await Promise.all([
      query(idsOf(StockRefType.GOODS_RECEIPT), (ids) =>
        this.prisma.goodsReceipt.findMany({ where: { id: { in: ids } }, select: pick }),
      ),
      query(idsOf(StockRefType.ORDER), (ids) =>
        this.prisma.order.findMany({ where: { id: { in: ids } }, select: pick }),
      ),
      query(idsOf(StockRefType.STOCK_TRANSFER), (ids) =>
        this.prisma.stockTransfer.findMany({ where: { id: { in: ids } }, select: pick }),
      ),
      query(idsOf(StockRefType.STOCK_ADJUSTMENT), (ids) =>
        this.prisma.stockAdjustment.findMany({ where: { id: { in: ids } }, select: pick }),
      ),
      query(idsOf(StockRefType.OPENING_STOCK), (ids) =>
        this.prisma.product.findMany({ where: { id: { in: ids } }, select: pick }),
      ),
    ]);
    return new Map(groups.flat().map((row) => [row.id, row.code]));
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
   * Nhập–xuất–tồn theo kỳ `[from, toExclusive)`, gom theo sản phẩm. Chi nhánh bỏ trống = gộp toàn chuỗi.
   *
   * Tồn đầu kỳ = Σ phát sinh mọi tháng đã đóng trước mốc B (bảng `stock_movement_monthly`) + Σ sổ kho `[B, from)`, với
   * B = đầu tháng của `from` (không vượt tháng chưa đóng). Nhờ vậy chỉ quét sổ kho trong kỳ và tối đa ~1 tháng trước
   * kỳ, không quét lại cả lịch sử mỗi lần gọi. Tồn cuối = đầu kỳ + phát sinh trong kỳ. Số lượng/tiền cộng bằng bigint
   * (không tràn int4), đổi sang `number` ở TS.
   */
  async findMovementSummary(filter: {
    branchId?: string;
    from: Date;
    toExclusive: Date;
  }): Promise<MovementSummaryRow[]> {
    const boundary = monthlyBoundary(filter.from, new Date());
    await this.ensureMonthlyBuilt(boundary);

    const branchOf = (alias: string) =>
      filter.branchId ? Prisma.sql`AND ${Prisma.raw(alias)}."branchId" = ${filter.branchId}::uuid` : Prisma.empty;
    const value = Prisma.sql`m."quantity"::bigint * COALESCE(m."unitCost", 0)`;
    const sumType = (type: string) =>
      Prisma.sql`COALESCE(SUM(m."quantity") FILTER (WHERE m."type" = ${type}::"StockMovementType"), 0)::bigint`;

    const rows = await this.prisma.$queryRaw<RawMovementSummaryRow[]>(Prisma.sql`
      WITH opening_parts AS (
        SELECT s."productId", SUM(s."quantity") AS "qty", SUM(s."value") AS "val"
        FROM "stock_movement_monthly" s
        WHERE s."month" < ${boundary.month}::date ${branchOf('s')}
        GROUP BY s."productId"
        UNION ALL
        SELECT m."productId", SUM(m."quantity")::bigint, SUM(${value})
        FROM "stock_movements" m
        WHERE m."createdAt" >= ${boundary.at} AND m."createdAt" < ${filter.from} ${branchOf('m')}
        GROUP BY m."productId"
      ),
      opening AS (
        SELECT "productId", SUM("qty")::bigint AS "qty", SUM("val")::bigint AS "val"
        FROM opening_parts GROUP BY "productId"
      ),
      period AS (
        SELECT m."productId",
               COALESCE(SUM(m."quantity") FILTER (WHERE m."quantity" > 0), 0)::bigint AS "inQuantity",
               COALESCE(-SUM(m."quantity") FILTER (WHERE m."quantity" < 0), 0)::bigint AS "outQuantity",
               COALESCE(SUM(${value}) FILTER (WHERE m."quantity" > 0), 0)::bigint AS "inValue",
               COALESCE(-SUM(${value}) FILTER (WHERE m."quantity" < 0), 0)::bigint AS "outValue",
               ${sumType('IMPORT')} AS "importQty",
               ${sumType('SALE')} AS "saleQty",
               ${sumType('TRANSFER_IN')} AS "transferInQty",
               ${sumType('TRANSFER_OUT')} AS "transferOutQty",
               ${sumType('ADJUST')} AS "adjustQty",
               ${sumType('DISPOSE')} AS "disposeQty",
               ${sumType('RETURN_IN')} AS "returnInQty",
               ${sumType('RETURN_OUT')} AS "returnOutQty"
        FROM "stock_movements" m
        WHERE m."createdAt" >= ${filter.from} AND m."createdAt" < ${filter.toExclusive} ${branchOf('m')}
        GROUP BY m."productId"
      )
      SELECT p."id" AS "productId", p."code" AS "productCode", p."name" AS "productName", u."name" AS "baseUnitName",
             COALESCE(o."qty", 0) AS "opening", COALESCE(o."val", 0) AS "openingValue",
             COALESCE(t."inQuantity", 0) AS "inQuantity", COALESCE(t."outQuantity", 0) AS "outQuantity",
             COALESCE(t."inValue", 0) AS "inValue", COALESCE(t."outValue", 0) AS "outValue",
             COALESCE(t."importQty", 0) AS "importQty", COALESCE(t."saleQty", 0) AS "saleQty",
             COALESCE(t."transferInQty", 0) AS "transferInQty", COALESCE(t."transferOutQty", 0) AS "transferOutQty",
             COALESCE(t."adjustQty", 0) AS "adjustQty", COALESCE(t."disposeQty", 0) AS "disposeQty",
             COALESCE(t."returnInQty", 0) AS "returnInQty", COALESCE(t."returnOutQty", 0) AS "returnOutQty"
      FROM opening o
      FULL JOIN period t ON t."productId" = o."productId"
      JOIN "products" p ON p."id" = COALESCE(o."productId", t."productId")
      JOIN "units" u ON u."id" = p."baseUnitId"
      ORDER BY p."name", p."id"`);

    return rows.map((row) => {
      const n = (v: bigint) => Number(v);
      const opening = n(row.opening);
      const inQuantity = n(row.inQuantity);
      const outQuantity = n(row.outQuantity);
      const openingValue = n(row.openingValue);
      const inValue = n(row.inValue);
      const outValue = n(row.outValue);
      return {
        productId: row.productId,
        productCode: row.productCode,
        productName: row.productName,
        baseUnitName: row.baseUnitName,
        opening,
        inQuantity,
        outQuantity,
        closing: opening + inQuantity - outQuantity,
        openingValue,
        inValue,
        outValue,
        closingValue: openingValue + inValue - outValue,
        importQty: n(row.importQty),
        saleQty: n(row.saleQty),
        transferInQty: n(row.transferInQty),
        transferOutQty: n(row.transferOutQty),
        adjustQty: n(row.adjustQty),
        disposeQty: n(row.disposeQty),
        returnInQty: n(row.returnInQty),
        returnOutQty: n(row.returnOutQty),
      };
    });
  }

  /**
   * Bảo đảm `stock_movement_monthly` đã có mọi tháng trước `boundary.month`. Đường nhanh: một câu đọc tháng dựng gần
   * nhất. Thiếu thì dựng phần còn thiếu trong MỘT câu INSERT … GROUP BY tháng, dưới khoá advisory (hai request cùng
   * lúc không dựng trùng), rồi đánh dấu các tháng — kể cả tháng không phát sinh — để lần sau khỏi kiểm lại.
   */
  private async ensureMonthlyBuilt(boundary: MonthlyBoundary): Promise<void> {
    const needUpTo = boundary.previousMonth;
    if (await this.monthlyBuiltThrough(this.prisma, needUpTo)) return;

    await this.prisma.$transaction(async (tx) => {
      await lockAdvisoryKeys(tx, ['stock-movement-monthly']);
      if (await this.monthlyBuiltThrough(tx, needUpTo)) return;

      const [last] = await tx.$queryRaw<{ month: Date | null }[]>(
        Prisma.sql`SELECT MAX("month") AS "month" FROM "stock_movement_monthly_built"`,
      );
      // Tháng bắt đầu dựng: sau tháng đã dựng gần nhất; chưa dựng gì thì từ đầu sổ kho (không chặn dưới).
      const fromMonth = last?.month ? addMonthsToDateOnly(toDateOnlyString(last.month), 1) : null;
      const fromAt = fromMonth ? vietnamDayStartUtc(fromMonth) : null;
      const lower = fromAt ? Prisma.sql`AND m."createdAt" >= ${fromAt}` : Prisma.empty;

      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "stock_movement_monthly" ("branchId", "productId", "month", "quantity", "value")
        SELECT m."branchId", m."productId",
               date_trunc('month', m."createdAt" AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,
               SUM(m."quantity")::bigint, SUM(m."quantity"::bigint * COALESCE(m."unitCost", 0))::bigint
        FROM "stock_movements" m
        WHERE m."createdAt" < ${boundary.at} ${lower}
        GROUP BY 1, 2, 3
        ON CONFLICT DO NOTHING`);

      // Đánh dấu liền mạch tới tháng trước mốc. Lần đầu bắt đầu từ tháng sổ kho sớm nhất (không có sổ kho → chỉ
      // đánh dấu tháng trước mốc).
      const [first] = fromMonth
        ? [{ month: parseDateOnly(fromMonth) }]
        : await tx.$queryRaw<{ month: Date | null }[]>(Prisma.sql`
            SELECT date_trunc('month', MIN("createdAt") AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS "month"
            FROM "stock_movements" WHERE "createdAt" < ${boundary.at}`);
      const startMonth = first?.month ?? parseDateOnly(needUpTo);
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "stock_movement_monthly_built" ("month")
        SELECT g::date FROM generate_series(${startMonth}::date, ${needUpTo}::date, interval '1 month') AS g
        ON CONFLICT DO NOTHING`);
    }, MONTHLY_BUILD_TX_OPTIONS);
  }

  /**
   * Tháng đánh dấu liền mạch từ tháng sổ kho sớm nhất, nên có dấu ở `month` hoặc muộn hơn là đủ: tháng trước dấu
   * sớm nhất không có bút toán nào.
   */
  private async monthlyBuiltThrough(client: Prisma.TransactionClient, month: string): Promise<boolean> {
    const [row] = await client.$queryRaw<{ ok: boolean }[]>(
      Prisma.sql`SELECT EXISTS (SELECT 1 FROM "stock_movement_monthly_built" WHERE "month" >= ${month}::date) AS "ok"`,
    );
    return row?.ok === true;
  }
}

interface RawMovementSummaryRow {
  productId: string;
  productCode: string;
  productName: string;
  baseUnitName: string;
  opening: bigint;
  openingValue: bigint;
  inQuantity: bigint;
  outQuantity: bigint;
  inValue: bigint;
  outValue: bigint;
  importQty: bigint;
  saleQty: bigint;
  transferInQty: bigint;
  transferOutQty: bigint;
  adjustQty: bigint;
  disposeQty: bigint;
  returnInQty: bigint;
  returnOutQty: bigint;
}

/** Bút toán có thể mang `createdAt` = lúc BẮT ĐẦU transaction; tháng chỉ coi là đóng sau ngần này. */
const MONTH_CLOSE_GRACE_MS = 10 * 60_000;

export interface MonthlyBoundary {
  /** Ngày đầu tháng (giờ VN) của mốc B, `YYYY-MM-DD`. */
  month: string;
  /** Mốc B quy ra UTC. */
  at: Date;
  /** Tháng ngay trước B — tháng cuối cùng phải có trong bảng tháng. */
  previousMonth: string;
}

/**
 * Mốc B = đầu tháng (giờ VN) chứa `from`, nhưng không vượt đầu tháng chứa `now − 10 phút` — tháng chưa đóng (hoặc
 * vừa đóng chưa đủ lâu) không được ghi vào bảng tháng.
 */
export function monthlyBoundary(from: Date, now: Date): MonthlyBoundary {
  const fromMonth = monthStartOf(todayInVietnam(from));
  const closedMonth = monthStartOf(todayInVietnam(new Date(now.getTime() - MONTH_CLOSE_GRACE_MS)));
  const month = fromMonth < closedMonth ? fromMonth : closedMonth;
  return { month, at: vietnamDayStartUtc(month), previousMonth: addMonthsToDateOnly(month, -1) };
}

function monthStartOf(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** Cộng `months` tháng vào một ngày đầu tháng `YYYY-MM-01`. */
function addMonthsToDateOnly(monthStart: string, months: number): string {
  const d = parseDateOnly(monthStart);
  d.setUTCMonth(d.getUTCMonth() + months);
  return toDateOnlyString(d);
}
