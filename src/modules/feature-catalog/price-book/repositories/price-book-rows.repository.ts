import { Injectable } from '@nestjs/common';
import { Prisma, RecordStatus } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';
import { containsPattern } from 'src/common/utils/like-pattern.util';
import { BranchScope } from '../../../feature-auth/permission/branch-scope';
import type { PriceCompareOp, PriceStockFilter } from '../dtos/price-book-rows.request';
import type { PriceRowsFilter } from '../price-book-rows-filter';

/** Một dòng trang Thiết lập giá = một đơn vị bán; giá vốn đã nhân hệ số đơn vị. */
export interface RawPriceRow {
  productUnitId: string;
  productId: string;
  unitId: string;
  code: string;
  name: string;
  unitName: string;
  factor: number;
  generalPrice: number;
  avgCost: number;
  lastPurchaseCost: number;
}

const COMPARE_SQL: Record<PriceCompareOp, Prisma.Sql> = {
  lt: Prisma.raw('<'),
  lte: Prisma.raw('<='),
  eq: Prisma.raw('='),
  gt: Prisma.raw('>'),
  gte: Prisma.raw('>='),
};

/**
 * Đọc dòng giá bằng SQL thô: một câu cho trang + một câu đếm, không N+1.
 *
 * Giá vốn (D3) = bình quân `importPrice` theo SỐ CÒN LẠI của các lô AVAILABLE ở chi nhánh, tính theo đơn vị gốc, rồi
 * × hệ số đơn vị. Giá nhập cuối (D11) = (đơn giá − giảm giá) / hệ số của dòng phiếu nhập CONFIRMED gần nhất ở chi nhánh.
 * Không có `branchId` → hai giá đó = 0 và lọc tồn bị bỏ qua.
 */
@Injectable()
export class PriceBookRowsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findPage(filter: PriceRowsFilter, page: number, pageSize: number) {
    const base = this.rowsQuery(filter);
    const [items, [{ count }]] = await Promise.all([
      this.prisma.$queryRaw<RawPriceRow[]>(Prisma.sql`
        ${base} ORDER BY t."code", t."factor", t."productUnitId" LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`),
      this.prisma.$queryRaw<{ count: number }[]>(Prisma.sql`SELECT COUNT(*)::int AS "count" FROM (${base}) AS q`),
    ]);
    return { items, total: count };
  }

  /** Mọi dòng khớp bộ lọc, không phân trang — cho áp công thức. */
  findAll(filter: PriceRowsFilter): Promise<RawPriceRow[]> {
    return this.prisma.$queryRaw<RawPriceRow[]>(Prisma.sql`
      ${this.rowsQuery(filter)} ORDER BY t."code", t."factor", t."productUnitId"`);
  }

  private rowsQuery(f: PriceRowsFilter): Prisma.Sql {
    const branchId = f.branchId ?? null;
    const inner: Prisma.Sql[] = [
      Prisma.sql`pu."isDeleted" = false AND pu."status" = 'ACTIVE'`,
      Prisma.sql`p."isDeleted" = false AND p."status" = 'ACTIVE'`,
    ];
    if (f.productUnitIds) inner.push(Prisma.sql`pu."id" = ANY(${f.productUnitIds}::uuid[])`);
    if (f.codes.length) inner.push(Prisma.sql`lower(p."code") = ANY(${f.codes.map((c) => c.toLowerCase())}::text[])`);
    if (f.code) inner.push(Prisma.sql`p."code" ILIKE ${containsPattern(f.code)}`);
    if (f.name) inner.push(Prisma.sql`p."name" ILIKE ${containsPattern(f.name)}`);
    if (f.categoryIds.length) inner.push(Prisma.sql`p."categoryId" = ANY(${f.categoryIds}::uuid[])`);
    if (branchId) inner.push(...this.stockConditions(f.stock));

    // Lọc theo so sánh giá chung với giá vốn / giá nhập cuối — làm trên giá đã làm tròn như hiển thị.
    const outer =
      f.priceOp && f.priceCompare
        ? Prisma.sql`t."generalPrice" ${COMPARE_SQL[f.priceOp]} t.${Prisma.raw(`"${f.priceCompare}"`)}`
        : Prisma.sql`TRUE`;

    return Prisma.sql`
      WITH cost AS (
        SELECT b."productId",
               COALESCE(SUM(b."quantityOnHand"), 0)::int AS "onHand",
               COALESCE(
                 SUM(b."importPrice"::float8 * b."quantityOnHand") FILTER (WHERE b."status" = 'AVAILABLE')
                 / NULLIF(SUM(b."quantityOnHand") FILTER (WHERE b."status" = 'AVAILABLE'), 0), 0) AS "avgBase"
        FROM "stock_batches" b
        WHERE b."branchId" = ${branchId}::uuid AND b."isDeleted" = false
        GROUP BY b."productId"
      ), last_purchase AS (
        SELECT DISTINCT ON (i."productId") i."productId",
               (i."importPrice" - i."unitDiscount")::float8 / i."conversionRate" AS "netBase"
        FROM "goods_receipt_items" i
        JOIN "goods_receipts" r ON r."id" = i."receiptId"
        WHERE r."branchId" = ${branchId}::uuid AND r."status" = 'CONFIRMED' AND r."isDeleted" = false AND i."isDeleted" = false
        ORDER BY i."productId", COALESCE(r."confirmedAt", r."receivedAt", r."createdAt") DESC, i."createdAt" DESC, i."id" DESC
      )
      SELECT t.* FROM (
        SELECT pu."id" AS "productUnitId", p."id" AS "productId", pu."unitId", p."code", p."name", u."name" AS "unitName",
               pu."conversionRate" AS "factor", pu."salePrice" AS "generalPrice",
               ROUND(COALESCE(c."avgBase", 0) * pu."conversionRate")::float8 AS "avgCost",
               ROUND(COALESCE(l."netBase", 0) * pu."conversionRate")::float8 AS "lastPurchaseCost"
        FROM "product_units" pu
        JOIN "products" p ON p."id" = pu."productId"
        JOIN "units" u ON u."id" = pu."unitId"
        LEFT JOIN cost c ON c."productId" = p."id"
        LEFT JOIN last_purchase l ON l."productId" = p."id"
        LEFT JOIN "branch_products" bp
          ON bp."branchId" = ${branchId}::uuid AND bp."productId" = p."id" AND bp."isDeleted" = false
        WHERE ${Prisma.join(inner, ' AND ')}
      ) AS t
      WHERE ${outer}`;
  }

  /** Lọc tồn trên số lượng tồn của chi nhánh; ngưỡng tối thiểu rơi về ngưỡng chung của sản phẩm (như trang Tồn kho). */
  private stockConditions(stock: PriceStockFilter): Prisma.Sql[] {
    const onHand = Prisma.sql`COALESCE(c."onHand", 0)`;
    const minStock = Prisma.sql`COALESCE(bp."minStockLevel", p."minStockLevel")`;
    switch (stock) {
      case 'in_stock': return [Prisma.sql`${onHand} > 0`];
      case 'out_of_stock': return [Prisma.sql`${onHand} <= 0`];
      case 'below_min': return [Prisma.sql`${minStock} > 0 AND ${onHand} < ${minStock}`];
      case 'above_max': return [Prisma.sql`p."maxStockLevel" IS NOT NULL AND ${onHand} > p."maxStockLevel"`];
      default: return [];
    }
  }

  /** Giá của các bảng cho một tập dòng đơn vị; chỉ lấy bảng trong `bookIds`. */
  findBookPrices(bookIds: string[], productUnitIds: string[]) {
    if (!bookIds.length || !productUnitIds.length) return Promise.resolve([]);
    return this.prisma.priceBookItem.findMany({
      where: { priceBookId: { in: bookIds }, productUnitId: { in: productUnitIds } },
      select: { priceBookId: true, productUnitId: true, price: true },
    });
  }

  /** Trong `bookIds`, những bảng người gọi được XEM (cột giá của bảng ngoài phạm vi không lộ ra). */
  async findReadableBookIds(scope: BranchScope, bookIds: string[]): Promise<string[]> {
    if (!bookIds.length) return [];
    const books = await this.prisma.priceBook.findMany({
      where: {
        id: { in: bookIds },
        ...(scope.kind === 'BRANCH'
          ? { OR: [{ branches: { none: {} } }, { branches: { some: { branchId: scope.branchId } } }] }
          : {}),
      },
      select: { id: true },
    });
    return books.map((b) => b.id);
  }

  /** Dòng đơn vị bán đang hoạt động của (sản phẩm, đơn vị tính); null nếu đơn vị không thuộc hàng. */
  findProductUnit(productId: string, unitId: string, db: Prisma.TransactionClient = this.prisma) {
    return db.productUnit.findFirst({
      where: { productId, unitId, isDeleted: false, status: RecordStatus.ACTIVE },
      select: { id: true, salePrice: true },
    });
  }

  async setGeneralPrice(db: Prisma.TransactionClient, productUnitId: string, price: number, actorId: string): Promise<void> {
    await db.productUnit.update({
      where: { id: productUnitId },
      data: { salePrice: price, updatedAt: new Date(), updatedBy: actorId },
    });
  }

  async setItem(
    priceBookId: string,
    productUnitId: string,
    price: number | null,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    if (price === null) {
      await db.priceBookItem.deleteMany({ where: { priceBookId, productUnitId } });
      return;
    }
    await db.priceBookItem.upsert({
      where: { priceBookId_productUnitId: { priceBookId, productUnitId } },
      create: { priceBookId, productUnitId, price },
      update: { price },
    });
  }

  /** Ghi hàng loạt trong MỘT câu (mỗi câu ~100 ms qua pooler nên không upsert từng dòng). */
  async upsertItems(
    db: Prisma.TransactionClient,
    priceBookId: string,
    entries: { productUnitId: string; price: number }[],
  ): Promise<void> {
    if (!entries.length) return;
    await db.$executeRaw`
      INSERT INTO "price_book_items" ("priceBookId", "productUnitId", "price")
      SELECT ${priceBookId}::uuid, x."id", x."price"
      FROM unnest(${entries.map((e) => e.productUnitId)}::uuid[], ${entries.map((e) => e.price)}::int[]) AS x("id", "price")
      ON CONFLICT ("priceBookId", "productUnitId") DO UPDATE SET "price" = EXCLUDED."price"`;
  }

  /** Mã dòng đơn vị đang có trong bảng — để tính lại công thức cho đúng các dòng này. */
  async findItemUnitIds(db: Prisma.TransactionClient, priceBookId: string): Promise<string[]> {
    const items = await db.priceBookItem.findMany({ where: { priceBookId }, select: { productUnitId: true } });
    return items.map((i) => i.productUnitId);
  }
}
