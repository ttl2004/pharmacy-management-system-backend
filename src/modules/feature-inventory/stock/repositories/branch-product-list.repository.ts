import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';
import { type ProductListItem, findListItemsInOrder } from 'src/common/databases/product-list-item';
import {
  PRODUCT_FILTER_JOINS,
  type ProductListFilter,
  catalogSortExpr,
  orderBySql,
  productFilterConditions,
} from 'src/common/databases/sql/product-filter.sql';
import { availableQtySql, availableValueSql, lastPurchaseSql } from 'src/common/databases/sql/stock-cost.sql';
import type { BranchProductSortKey, BranchStockFilter, StockOp } from '../dtos/branch-product-list.query';

/** Id chi nhánh, hoặc `'ALL'` = toàn chuỗi. */
type ScopeKey = string;

/** Kỳ lấy mẫu tốc độ bán cho "Dự kiến hết hàng" (như KiotViet). */
export const SALES_WINDOW_DAYS = 30;

export interface BranchProductListFilter {
  product: ProductListFilter;
  /** `null` = toàn chuỗi (đã qua kiểm phạm vi ở service). */
  branchId: string | null;
  supplierIds: string[];
  stock: BranchStockFilter;
  stockOp: StockOp;
  stockValue?: number;
  /** Hôm nay theo giờ VN (YYYY-MM-DD) — mốc hạn dùng "còn bán được" và cửa sổ bán 30 ngày. */
  today: string;
}

export interface BranchProductPageOptions {
  page: number;
  limit: number;
  sortBy?: BranchProductSortKey;
  sortDir: 'asc' | 'desc';
}

/** Số liệu tồn của một hàng trong phạm vi (một chi nhánh hoặc cộng cả chuỗi). */
export interface StockAggRow {
  productId: string;
  onHand: number;
  sellable: number;
  /** Giá vốn đơn vị gốc đã làm tròn như Thiết lập giá; null = không còn lô AVAILABLE có tồn. */
  avgCost: number | null;
  nearestExpiry: Date | null;
  /** Định mức tối thiểu: chi nhánh = branch_products rơi về chung; toàn chuỗi = tổng các chi nhánh có lô. */
  minStock: number;
  maxStock: number | null;
}

export interface BranchBreakdownRow extends StockAggRow {
  branchId: string;
  branchCode: string;
  branchName: string;
}

type RawAgg = Omit<StockAggRow, 'onHand' | 'sellable' | 'minStock'> & {
  onHand: bigint;
  sellable: bigint;
  minStock: bigint;
};

const OPS: Record<StockOp, Prisma.Sql> = {
  lt: Prisma.raw('<'),
  lte: Prisma.raw('<='),
  eq: Prisma.raw('='),
  gt: Prisma.raw('>'),
  gte: Prisma.raw('>='),
};

/** `Prisma.join` từ chối mảng rỗng. */
const joinOrEmpty = (parts: Prisma.Sql[]) => (parts.length ? Prisma.join(parts, ' ') : Prisma.empty);

const toAgg = <T extends RawAgg>(row: T) => ({
  ...row,
  onHand: Number(row.onHand),
  sellable: Number(row.sellable),
  minStock: Number(row.minStock),
});

/**
 * Hàng hoá chi nhánh: chỉ hàng ĐÃ TỪNG CÓ LÔ (chưa xoá) trong phạm vi — kể cả tồn 0 — gộp từ `stock_batches`.
 * Lọc/sắp xếp/phân trang/đếm/tổng tồn đều ở SQL; số liệu phụ (giá nhập cuối, lượng bán, chi tiết chi nhánh) chỉ tính
 * cho các hàng của trang. Giá vốn / giá nhập cuối cùng định nghĩa với Thiết lập giá (`stock-cost.sql.ts`).
 */
@Injectable()
export class BranchProductListRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Trang (đã sắp xếp) + tổng số dòng + tổng tồn theo bộ lọc. */
  async findPage(
    f: BranchProductListFilter,
    o: BranchProductPageOptions,
  ): Promise<{ rows: StockAggRow[]; total: number; totalQtyOnHand: number }> {
    const where = Prisma.join(this.conditions(f), ' AND ');
    const needLast = o.sortBy === 'lastPurchaseCost';
    const needSold = o.sortBy === 'stockoutDate';
    const ctes = [this.stockCtes(f.branchId, f.today)];
    if (needLast) ctes.push(Prisma.sql`lp AS (${lastPurchaseSql({ branchId: f.branchId ?? 'ALL' })})`);
    if (needSold) ctes.push(Prisma.sql`sold AS (${this.soldSql(f.branchId ?? 'ALL', f.today)})`);
    const joins = Prisma.sql`
      ${needLast ? Prisma.sql`LEFT JOIN lp ON lp."productId" = p."id"` : Prisma.empty}
      ${needSold ? Prisma.sql`LEFT JOIN sold ON sold."productId" = p."id"` : Prisma.empty}`;
    const order = orderBySql(o.sortBy ? this.sortExpr(o.sortBy) : null, o.sortDir);

    const [rows, [summary]] = await Promise.all([
      this.prisma.$queryRaw<RawAgg[]>(Prisma.sql`
        WITH ${Prisma.join(ctes, ', ')}
        SELECT s."productId", s."onHand", s."sellable", ROUND(s."avgBase")::float8 AS "avgCost",
               s."nearestExpiry", s."minStock", p."maxStockLevel" AS "maxStock"
        FROM s
        JOIN "products" p ON p."id" = s."productId"
        ${PRODUCT_FILTER_JOINS}
        ${joins}
        WHERE ${where}
        ORDER BY ${order}
        LIMIT ${o.limit} OFFSET ${(o.page - 1) * o.limit}`),
      this.prisma.$queryRaw<{ count: number; qty: bigint }[]>(Prisma.sql`
        WITH ${this.stockCtes(f.branchId, f.today)}
        SELECT COUNT(*)::int AS "count", COALESCE(SUM(s."onHand"), 0)::bigint AS "qty"
        FROM s
        JOIN "products" p ON p."id" = s."productId"
        ${PRODUCT_FILTER_JOINS}
        WHERE ${where}`),
    ]);
    return { rows: rows.map(toAgg), total: summary.count, totalQtyOnHand: Number(summary.qty) };
  }

  /** Đủ trường sản phẩm cho các hàng của trang, giữ thứ tự. */
  findItems(productIds: string[]): Promise<ProductListItem[]> {
    return findListItemsInOrder(this.prisma, productIds);
  }

  /**
   * Giá nhập cuối (đơn vị gốc, làm tròn như Thiết lập giá) của các hàng. `perBranch` → khoá `branchId:productId`,
   * ngược lại khoá `productId`.
   */
  async findLastPurchase(branchId: ScopeKey, productIds: string[], perBranch = false): Promise<Map<string, number>> {
    if (!productIds.length) return new Map();
    const rows = await this.prisma.$queryRaw<{ branchId?: string; productId: string; cost: number }[]>(Prisma.sql`
      SELECT lp.*, ROUND(lp."netBase")::float8 AS "cost"
      FROM (${lastPurchaseSql({ branchId, productIds, perBranch })}) lp`);
    return new Map(rows.map((r) => [perBranch ? `${r.branchId}:${r.productId}` : r.productId, r.cost]));
  }

  /** Lượng bán ròng (đơn vị gốc) trong 30 ngày gần nhất. Khoá như `findLastPurchase`. */
  async findSold(
    branchId: ScopeKey,
    productIds: string[],
    today: string,
    perBranch = false,
  ): Promise<Map<string, number>> {
    if (!productIds.length) return new Map();
    const rows = await this.prisma.$queryRaw<{ branchId?: string; productId: string; qty: bigint }[]>(
      this.soldSql(branchId, today, productIds, perBranch),
    );
    return new Map(rows.map((r) => [perBranch ? `${r.branchId}:${r.productId}` : r.productId, Number(r.qty)]));
  }

  /** Toàn chuỗi: số liệu từng chi nhánh CÓ LÔ của các hàng trong trang, xếp theo mã chi nhánh. */
  async findBranchBreakdown(productIds: string[], today: string): Promise<BranchBreakdownRow[]> {
    if (!productIds.length) return [];
    const rows = await this.prisma.$queryRaw<(RawAgg & { branchId: string; branchCode: string; branchName: string })[]>(
      Prisma.sql`
        WITH ${this.perBranchCte(null, today, productIds)}
        SELECT pb."branchId", br."code" AS "branchCode", br."name" AS "branchName", pb."productId",
               pb."onHand", pb."sellable", ROUND(pb."availValue" / NULLIF(pb."availQty", 0))::float8 AS "avgCost",
               pb."nearestExpiry", COALESCE(bp."minStockLevel", p."minStockLevel")::bigint AS "minStock",
               p."maxStockLevel" AS "maxStock"
        FROM pb
        JOIN "branches" br ON br."id" = pb."branchId"
        JOIN "products" p ON p."id" = pb."productId"
        LEFT JOIN "branch_products" bp
          ON bp."branchId" = pb."branchId" AND bp."productId" = pb."productId" AND bp."isDeleted" = false
        ORDER BY br."code", br."id"`,
    );
    return rows.map(toAgg);
  }

  /** Tồn gộp theo (chi nhánh, hàng) từ lô chưa xoá; giá trị/số lượng AVAILABLE để cộng giá vốn bình quân gia quyền. */
  private perBranchCte(branchId: string | null, today: string, productIds?: string[]): Prisma.Sql {
    const extra: Prisma.Sql[] = [];
    if (branchId) extra.push(Prisma.sql`AND b."branchId" = ${branchId}::uuid`);
    if (productIds) extra.push(Prisma.sql`AND b."productId" = ANY(${productIds}::uuid[])`);
    return Prisma.sql`pb AS (
      SELECT b."branchId", b."productId",
             SUM(b."quantityOnHand")::bigint AS "onHand",
             SUM(CASE WHEN b."status" = 'AVAILABLE' AND b."expiryDate" > ${today}::date
                      THEN b."quantityOnHand" - b."reservedQuantity" ELSE 0 END)::bigint AS "sellable",
             ${availableValueSql('b')} AS "availValue",
             ${availableQtySql('b')} AS "availQty",
             MIN(CASE WHEN b."quantityOnHand" > 0 THEN b."expiryDate" END) AS "nearestExpiry"
      FROM "stock_batches" b
      WHERE b."isDeleted" = false ${joinOrEmpty(extra)}
      GROUP BY b."branchId", b."productId")`;
  }

  /**
   * `pb` (theo chi nhánh) + `s` (theo hàng trong phạm vi). Giá vốn toàn chuỗi = Σ giá trị AVAILABLE / Σ tồn AVAILABLE
   * cả chuỗi (bình quân gia quyền theo tồn). Cờ định mức tính theo TỪNG chi nhánh rồi OR lại.
   */
  private stockCtes(branchId: string | null, today: string): Prisma.Sql {
    const minOf = Prisma.sql`COALESCE(bp."minStockLevel", sp."minStockLevel")`;
    return Prisma.sql`${this.perBranchCte(branchId, today)}, s AS (
      SELECT pb."productId",
             SUM(pb."onHand")::bigint AS "onHand",
             SUM(pb."sellable")::bigint AS "sellable",
             SUM(pb."availValue") / NULLIF(SUM(pb."availQty"), 0) AS "avgBase",
             MIN(pb."nearestExpiry") AS "nearestExpiry",
             SUM(${minOf})::bigint AS "minStock",
             bool_or(${minOf} > 0 AND pb."onHand" < ${minOf}) AS "belowMin",
             bool_or(sp."maxStockLevel" IS NOT NULL AND pb."onHand" > sp."maxStockLevel") AS "aboveMax"
      FROM pb
      JOIN "products" sp ON sp."id" = pb."productId"
      LEFT JOIN "branch_products" bp
        ON bp."branchId" = pb."branchId" AND bp."productId" = pb."productId" AND bp."isDeleted" = false
      GROUP BY pb."productId")`;
  }

  /**
   * Lượng bán ròng 30 ngày (hôm nay và 29 ngày trước, ngày VN) từ bảng tổng hợp `sales_daily_product` — đã trừ đơn
   * huỷ sau khi thu (RETURN_IN) và cập nhật cùng giao dịch thu tiền, nên không phải quét sổ kho.
   */
  private soldSql(branchId: ScopeKey, today: string, productIds?: string[], perBranch = false): Prisma.Sql {
    const extra: Prisma.Sql[] = [];
    if (branchId !== 'ALL') extra.push(Prisma.sql`AND sd."branchId" = ${branchId}::uuid`);
    if (productIds) extra.push(Prisma.sql`AND sd."productId" = ANY(${productIds}::uuid[])`);
    const key = perBranch ? Prisma.sql`sd."branchId", sd."productId"` : Prisma.sql`sd."productId"`;
    return Prisma.sql`
      SELECT ${key}, SUM(sd."qtyBase")::bigint AS "qty"
      FROM "sales_daily_product" sd
      WHERE sd."date" > ${today}::date - ${SALES_WINDOW_DAYS}::int ${joinOrEmpty(extra)}
      GROUP BY ${key}`;
  }

  private conditions(f: BranchProductListFilter): Prisma.Sql[] {
    const c: Prisma.Sql[] = [Prisma.sql`p."isDeleted" = false`];
    c.push(...productFilterConditions(f.product, f.branchId ?? 'ALL'));
    if (f.supplierIds.length) {
      const branch = f.branchId ? Prisma.sql`AND r."branchId" = ${f.branchId}::uuid` : Prisma.empty;
      c.push(Prisma.sql`EXISTS (
        SELECT 1 FROM "goods_receipt_items" i
        JOIN "goods_receipts" r ON r."id" = i."receiptId"
        WHERE i."productId" = p."id" AND i."isDeleted" = false
          AND r."status" = 'CONFIRMED' AND r."isDeleted" = false
          AND r."supplierId" = ANY(${f.supplierIds}::uuid[]) ${branch})`);
    }
    switch (f.stock) {
      case 'in_stock':
        c.push(Prisma.sql`s."onHand" > 0`);
        break;
      case 'out_of_stock':
        c.push(Prisma.sql`s."onHand" <= 0`);
        break;
      case 'below_min':
        c.push(Prisma.sql`s."belowMin"`);
        break;
      case 'above_max':
        c.push(Prisma.sql`s."aboveMax"`);
        break;
      case 'custom':
        if (f.stockValue !== undefined) c.push(Prisma.sql`s."onHand" ${OPS[f.stockOp]} ${f.stockValue}`);
        break;
      default:
        break;
    }
    return c;
  }

  private sortExpr(key: BranchProductSortKey): Prisma.Sql {
    switch (key) {
      case 'qtyOnHand':
        return Prisma.sql`s."onHand"`;
      case 'sellable':
        return Prisma.sql`s."sellable"`;
      case 'avgCost':
        return Prisma.sql`s."avgBase"`;
      case 'lastPurchaseCost':
        return Prisma.sql`lp."netBase"`;
      case 'nearestExpiry':
        return Prisma.sql`s."nearestExpiry"`;
      case 'stockoutDate':
        // Cùng công thức với service: số ngày còn bán = floor(tồn × 30 / lượng bán 30 ngày); không ước lượng được → NULL.
        return Prisma.sql`CASE WHEN s."onHand" > 0 AND sold."qty" > 0
          THEN floor(s."onHand" * ${SALES_WINDOW_DAYS}::float8 / sold."qty") END`;
      default:
        return catalogSortExpr(key);
    }
  }
}
