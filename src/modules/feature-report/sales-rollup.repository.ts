import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { addDaysToDateOnly, daysBetweenDateOnly, vietnamDayStartUtc } from 'src/common/utils/date-only.util';

/** Ngày của đơn = ngày giờ Việt Nam của `completedAt`. Cùng một biểu thức cho cả khoá, upsert và dựng lại. */
const VN_DAY = Prisma.sql`(o."completedAt" AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`;

/**
 * Khoá advisory theo ngày VN — MỘT hàm cho cả `applyOrder` (chia sẻ) và `rebuild` (độc quyền) để hai bên luôn cùng khoá.
 * Dùng `to_char` (không phụ thuộc DateStyle) để khoá luôn là `sales-rollup:YYYY-MM-DD`.
 */
const dayLockKey = (date: Prisma.Sql) =>
  Prisma.sql`hashtextextended('sales-rollup:' || to_char(${date}, 'YYYY-MM-DD'), 0)`;

/** Số phần tử tối đa của danh sách lệch lưu vào nhật ký (số đếm vẫn là tổng thật). */
export const MAX_MISMATCHES = 100;

export type ReconcileMismatch =
  | {
      table: 'sales_daily';
      branchId: string;
      date: string;
      channel: string;
      stored: { orderCount: number; revenue: number };
      expected: { orderCount: number; revenue: number };
    }
  | {
      table: 'sales_daily_product' | 'sales_daily_product_chain';
      date: string;
      rowCount: number;
      qtyBaseDiff: number;
      revenueDiff: number;
      cogsAmountDiff: number;
    };

export interface RebuildResult {
  days: number;
  rows: number;
  mismatchCount: number;
  mismatches: ReconcileMismatch[];
  /** Chi nhánh có dòng lệch (đầy đủ, không bị cắt như `mismatches`). */
  branchIds: string[];
}

/** Đơn đã xoá mềm không tính — cùng điều kiện ở `applyOrder` và `rebuild`. */
const LIVE_ORDER = Prisma.sql`o."isDeleted" = false`;

/**
 * Bảng tổng hợp doanh thu theo ngày (`sales_daily`, `sales_daily_product`). Ghi bằng SQL thô vì cần upsert cộng dồn
 * nguyên tử; mọi hàm nhận `tx` để nằm trong cùng transaction với nghiệp vụ thu tiền / huỷ hoá đơn.
 */
@Injectable()
export class SalesRollupRepository {
  /**
   * Cộng (sign = 1) hoặc trừ (sign = -1) một đơn vào tổng hợp, theo ngày thu VN của đơn. `revenueDelta` là phần doanh
   * thu thêm/bớt của đơn (thu: +tổng; huỷ: −tiền hoàn); dòng sản phẩm luôn cộng/trừ trọn vẹn số lượng, doanh thu và
   * giá vốn của đơn. Đúng 1 câu cho mỗi bảng (ngày, sản phẩm theo chi nhánh, sản phẩm toàn chuỗi), thêm 1 câu khoá chia
   * sẻ theo ngày để `rebuild` không chạy xen vào. Thứ tự khoá dòng cố định: dòng ngày → dòng sản phẩm chi nhánh → dòng
   * sản phẩm chuỗi, mỗi nhóm theo productId tăng dần — mọi giao dịch cùng thứ tự nên không deadlock.
   */
  async applyOrder(tx: Prisma.TransactionClient, orderId: string, sign: 1 | -1, revenueDelta: bigint): Promise<void> {
    await tx.$executeRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock_shared(${dayLockKey(VN_DAY)})
      FROM orders o WHERE o."id" = ${orderId}::uuid AND o."completedAt" IS NOT NULL AND ${LIVE_ORDER}`);

    await tx.$executeRaw(Prisma.sql`
      INSERT INTO sales_daily ("branchId", "date", "channel", "orderCount", "revenue", "updatedAt")
      SELECT o."branchId", ${VN_DAY}, o."channel", ${sign}::int, ${revenueDelta}::bigint, now()
      FROM orders o
      WHERE o."id" = ${orderId}::uuid AND o."completedAt" IS NOT NULL AND ${LIVE_ORDER}
      ON CONFLICT ("branchId", "date", "channel") DO UPDATE SET
        "orderCount" = sales_daily."orderCount" + EXCLUDED."orderCount",
        "revenue" = sales_daily."revenue" + EXCLUDED."revenue",
        "updatedAt" = now()`);

    // ORDER BY productId: mọi giao dịch khoá các dòng sản phẩm theo cùng thứ tự → không deadlock khi hai đơn trùng hàng.
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO sales_daily_product ("branchId", "date", "channel", "productId", "qtyBase", "revenue", "cogsAmount")
      SELECT o."branchId", ${VN_DAY}, o."channel", oi."productId",
             (${sign}::bigint * SUM(oi."baseQuantity"))::int,
             ${sign}::bigint * SUM(oi."totalPrice"),
             ${sign}::bigint * COALESCE(SUM(c."cost"), 0)
      FROM orders o
      JOIN order_items oi ON oi."orderId" = o."id" AND oi."isDeleted" = false
      LEFT JOIN LATERAL (
        SELECT SUM(b."quantity"::bigint * b."unitCost") AS "cost"
        FROM order_item_batches b WHERE b."orderItemId" = oi."id"
      ) c ON true
      WHERE o."id" = ${orderId}::uuid AND o."completedAt" IS NOT NULL AND ${LIVE_ORDER}
      GROUP BY o."branchId", ${VN_DAY}, o."channel", oi."productId"
      ORDER BY oi."productId"
      ON CONFLICT ("branchId", "date", "channel", "productId") DO UPDATE SET
        "qtyBase" = sales_daily_product."qtyBase" + EXCLUDED."qtyBase",
        "revenue" = sales_daily_product."revenue" + EXCLUDED."revenue",
        "cogsAmount" = sales_daily_product."cogsAmount" + EXCLUDED."cogsAmount"`);

    // Gộp mọi chi nhánh: nguồn của topDrugs toàn chuỗi. Các chi nhánh tranh nhau dòng này (cùng sản phẩm, cùng ngày).
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO sales_daily_product_chain ("date", "channel", "productId", "qtyBase", "revenue", "cogsAmount", "updatedAt")
      SELECT ${VN_DAY}, o."channel", oi."productId",
             (${sign}::bigint * SUM(oi."baseQuantity"))::int,
             ${sign}::bigint * SUM(oi."totalPrice"),
             ${sign}::bigint * COALESCE(SUM(c."cost"), 0),
             now()
      FROM orders o
      JOIN order_items oi ON oi."orderId" = o."id" AND oi."isDeleted" = false
      LEFT JOIN LATERAL (
        SELECT SUM(b."quantity"::bigint * b."unitCost") AS "cost"
        FROM order_item_batches b WHERE b."orderItemId" = oi."id"
      ) c ON true
      WHERE o."id" = ${orderId}::uuid AND o."completedAt" IS NOT NULL AND ${LIVE_ORDER}
      GROUP BY ${VN_DAY}, o."channel", oi."productId"
      ORDER BY oi."productId"
      ON CONFLICT ("date", "channel", "productId") DO UPDATE SET
        "qtyBase" = sales_daily_product_chain."qtyBase" + EXCLUDED."qtyBase",
        "revenue" = sales_daily_product_chain."revenue" + EXCLUDED."revenue",
        "cogsAmount" = sales_daily_product_chain."cogsAmount" + EXCLUDED."cogsAmount",
        "updatedAt" = now()`);
  }

  /**
   * Dựng lại tổng hợp cho các ngày VN trong [fromDate, toDate] từ dữ liệu gốc, và so với sổ phụ đang có TRƯỚC khi ghi đè.
   * Khoá độc quyền từng ngày (theo thứ tự tăng dần) trước khi đọc: đơn đang thu dở giữ khoá chia sẻ nên `rebuild` chờ nó
   * commit rồi mới đọc. Số "đúng" tính một lần vào bảng tạm (cùng câu SELECT dùng để ghi) → so sánh → xoá → ghi từ bảng tạm,
   * nên số đem so và số được ghi luôn là một.
   */
  async rebuild(tx: Prisma.TransactionClient, fromDate: string, toDate: string): Promise<RebuildResult> {
    const days = daysBetweenDateOnly(fromDate, toDate) + 1;
    if (days < 1) throw new Error(`Khoảng ngày không hợp lệ: ${fromDate} → ${toDate}`);
    const start = vietnamDayStartUtc(fromDate);
    const end = vietnamDayStartUtc(addDaysToDateOnly(toDate, 1));
    const range = (column: string) => Prisma.sql`${Prisma.raw(column)} BETWEEN ${fromDate}::date AND ${toDate}::date`;

    await tx.$executeRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(${dayLockKey(Prisma.sql`g."d"::date`)})
      FROM generate_series(${fromDate}::date, ${toDate}::date, interval '1 day') AS g("d")`);

    // Đơn đã thu = COMPLETED (còn hiệu lực) hoặc CANCELLED mà có `completedAt` (thu rồi mới huỷ). Đơn huỷ vẫn sinh dòng
    // (với 0 đơn / phần tiền giữ lại), đúng như khi `applyOrder` cộng rồi trừ.
    await tx.$executeRaw(Prisma.sql`DROP TABLE IF EXISTS pg_temp.rb_daily`);
    await tx.$executeRaw(Prisma.sql`
      CREATE TEMP TABLE rb_daily ON COMMIT DROP AS
      SELECT o."branchId", ${VN_DAY} AS "date", o."channel",
             (COUNT(*) FILTER (WHERE o."status" = 'COMPLETED'))::int AS "orderCount",
             COALESCE(SUM(CASE WHEN o."status" = 'COMPLETED' THEN o."totalAmount" ELSE o."totalAmount" - r."refund" END), 0)::bigint AS "revenue"
      FROM orders o
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(p."amount"), 0) AS "refund" FROM payments p
        WHERE p."orderId" = o."id" AND p."kind" = 'REFUND' AND p."status" = 'SUCCESS'
      ) r ON true
      WHERE o."completedAt" >= ${start} AND o."completedAt" < ${end}
        AND o."status" IN ('COMPLETED', 'CANCELLED') AND ${LIVE_ORDER}
      GROUP BY o."branchId", ${VN_DAY}, o."channel"`);

    await tx.$executeRaw(Prisma.sql`DROP TABLE IF EXISTS pg_temp.rb_product`);
    await tx.$executeRaw(Prisma.sql`
      CREATE TEMP TABLE rb_product ON COMMIT DROP AS
      SELECT o."branchId", ${VN_DAY} AS "date", o."channel", oi."productId",
             COALESCE(SUM(CASE WHEN o."status" = 'COMPLETED' THEN oi."baseQuantity" ELSE 0 END), 0)::int AS "qtyBase",
             COALESCE(SUM(CASE WHEN o."status" = 'COMPLETED' THEN oi."totalPrice" ELSE 0 END), 0)::bigint AS "revenue",
             COALESCE(SUM(CASE WHEN o."status" = 'COMPLETED' THEN c."cost" ELSE 0 END), 0)::bigint AS "cogsAmount"
      FROM orders o
      JOIN order_items oi ON oi."orderId" = o."id" AND oi."isDeleted" = false
      LEFT JOIN LATERAL (
        SELECT SUM(b."quantity"::bigint * b."unitCost") AS "cost"
        FROM order_item_batches b WHERE b."orderItemId" = oi."id"
      ) c ON true
      WHERE o."completedAt" >= ${start} AND o."completedAt" < ${end}
        AND o."status" IN ('COMPLETED', 'CANCELLED') AND ${LIVE_ORDER}
      GROUP BY o."branchId", ${VN_DAY}, o."channel", oi."productId"`);

    await tx.$executeRaw(Prisma.sql`DROP TABLE IF EXISTS pg_temp.rb_chain`);
    await tx.$executeRaw(Prisma.sql`
      CREATE TEMP TABLE rb_chain ON COMMIT DROP AS
      SELECT e."date", e."channel", e."productId", SUM(e."qtyBase")::int AS "qtyBase",
             SUM(e."revenue")::bigint AS "revenue", SUM(e."cogsAmount")::bigint AS "cogsAmount"
      FROM rb_product e GROUP BY e."date", e."channel", e."productId"`);

    const diff = await this.diffAgainstStored(tx, range);

    await tx.$executeRaw(Prisma.sql`DELETE FROM sales_daily WHERE ${range('"date"')}`);
    await tx.$executeRaw(Prisma.sql`DELETE FROM sales_daily_product WHERE ${range('"date"')}`);
    await tx.$executeRaw(Prisma.sql`DELETE FROM sales_daily_product_chain WHERE ${range('"date"')}`);

    const daily = await tx.$executeRaw(Prisma.sql`
      INSERT INTO sales_daily ("branchId", "date", "channel", "orderCount", "revenue", "updatedAt")
      SELECT "branchId", "date", "channel", "orderCount", "revenue", now() FROM rb_daily`);
    const perProduct = await tx.$executeRaw(Prisma.sql`
      INSERT INTO sales_daily_product ("branchId", "date", "channel", "productId", "qtyBase", "revenue", "cogsAmount")
      SELECT "branchId", "date", "channel", "productId", "qtyBase", "revenue", "cogsAmount" FROM rb_product`);
    const chain = await tx.$executeRaw(Prisma.sql`
      INSERT INTO sales_daily_product_chain ("date", "channel", "productId", "qtyBase", "revenue", "cogsAmount", "updatedAt")
      SELECT "date", "channel", "productId", "qtyBase", "revenue", "cogsAmount", now() FROM rb_chain`);

    return { days, rows: daily + perProduct + chain, ...diff };
  }

  /** So số đúng (bảng tạm `rb_*`) với sổ phụ đang có, cho cả 3 bảng. Chỉ đọc. */
  private async diffAgainstStored(
    tx: Prisma.TransactionClient,
    range: (column: string) => Prisma.Sql,
  ): Promise<Pick<RebuildResult, 'mismatchCount' | 'mismatches' | 'branchIds'>> {
    const dailyRows = await tx.$queryRaw<
      {
        branchId: string;
        date: string;
        channel: string;
        storedCount: number;
        storedRevenue: bigint;
        expectedCount: number;
        expectedRevenue: bigint;
      }[]
    >(Prisma.sql`
      SELECT COALESCE(s."branchId", e."branchId") AS "branchId",
             to_char(COALESCE(s."date", e."date"), 'YYYY-MM-DD') AS "date",
             COALESCE(s."channel", e."channel")::text AS "channel",
             COALESCE(s."orderCount", 0) AS "storedCount", COALESCE(s."revenue", 0)::bigint AS "storedRevenue",
             COALESCE(e."orderCount", 0) AS "expectedCount", COALESCE(e."revenue", 0)::bigint AS "expectedRevenue"
      FROM (SELECT * FROM sales_daily WHERE ${range('"date"')}) s
      FULL OUTER JOIN rb_daily e
        ON e."branchId" = s."branchId" AND e."date" = s."date" AND e."channel" = s."channel"
      WHERE COALESCE(s."orderCount", 0) <> COALESCE(e."orderCount", 0)
         OR COALESCE(s."revenue", 0) <> COALESCE(e."revenue", 0)
      ORDER BY 2, 1, 3`);

    const productDiff = (table: 'sales_daily_product' | 'sales_daily_product_chain') => {
      const chain = table === 'sales_daily_product_chain';
      const keys = chain ? ['date', 'channel', 'productId'] : ['branchId', 'date', 'channel', 'productId'];
      const on = Prisma.raw(keys.map((k) => `e."${k}" = s."${k}"`).join(' AND '));
      return tx.$queryRaw<
        { date: string; rowCount: number; qty: bigint; revenue: bigint; cogs: bigint; branchIds: string[] | null }[]
      >(Prisma.sql`
        SELECT to_char(COALESCE(s."date", e."date"), 'YYYY-MM-DD') AS "date", COUNT(*)::int AS "rowCount",
               SUM(COALESCE(e."qtyBase", 0) - COALESCE(s."qtyBase", 0))::bigint AS "qty",
               SUM(COALESCE(e."revenue", 0) - COALESCE(s."revenue", 0))::bigint AS "revenue",
               SUM(COALESCE(e."cogsAmount", 0) - COALESCE(s."cogsAmount", 0))::bigint AS "cogs",
               ${chain ? Prisma.sql`NULL::text[]` : Prisma.sql`array_agg(DISTINCT COALESCE(s."branchId", e."branchId")::text)`} AS "branchIds"
        FROM (SELECT * FROM ${Prisma.raw(table)} WHERE ${range('"date"')}) s
        FULL OUTER JOIN ${Prisma.raw(chain ? 'rb_chain' : 'rb_product')} e ON ${on}
        WHERE COALESCE(s."qtyBase", 0) <> COALESCE(e."qtyBase", 0)
           OR COALESCE(s."revenue", 0) <> COALESCE(e."revenue", 0)
           OR COALESCE(s."cogsAmount", 0) <> COALESCE(e."cogsAmount", 0)
        GROUP BY 1 ORDER BY 1`);
    };
    const branchRows = await productDiff('sales_daily_product');
    const chainRows = await productDiff('sales_daily_product_chain');

    const mismatches: ReconcileMismatch[] = [
      ...dailyRows.map((r) => ({
        table: 'sales_daily' as const,
        branchId: r.branchId,
        date: r.date,
        channel: r.channel,
        stored: { orderCount: r.storedCount, revenue: Number(r.storedRevenue) },
        expected: { orderCount: r.expectedCount, revenue: Number(r.expectedRevenue) },
      })),
      ...(['sales_daily_product', 'sales_daily_product_chain'] as const).flatMap((table) =>
        (table === 'sales_daily_product' ? branchRows : chainRows).map((r) => ({
          table,
          date: r.date,
          rowCount: r.rowCount,
          qtyBaseDiff: Number(r.qty),
          revenueDiff: Number(r.revenue),
          cogsAmountDiff: Number(r.cogs),
        })),
      ),
    ];
    const mismatchCount = dailyRows.length + [...branchRows, ...chainRows].reduce((sum, row) => sum + row.rowCount, 0);
    const branchIds = [
      ...new Set([...dailyRows.map((r) => r.branchId), ...branchRows.flatMap((r) => r.branchIds ?? [])]),
    ].sort();
    return { mismatchCount, mismatches: mismatches.slice(0, MAX_MISMATCHES), branchIds };
  }
}
