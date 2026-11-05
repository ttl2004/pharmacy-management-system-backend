import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { addDaysToDateOnly, daysBetweenDateOnly, vietnamDayStartUtc } from 'src/common/utils/date-only.util';

/** Ngày của đơn = ngày giờ Việt Nam của `completedAt`. Cùng một biểu thức cho cả khoá, upsert và dựng lại. */
const VN_DAY = Prisma.sql`(o."completedAt" AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`;

/** Khoá advisory theo ngày: `applyOrder` giữ chế độ chia sẻ (nhiều đơn song song), `rebuild` giữ độc quyền. */
const dayLockKey = (date: Prisma.Sql) => Prisma.sql`hashtextextended('sales-rollup:' || (${date})::text, 0)`;

/**
 * Bảng tổng hợp doanh thu theo ngày (`sales_daily`, `sales_daily_product`). Ghi bằng SQL thô vì cần upsert cộng dồn
 * nguyên tử; mọi hàm nhận `tx` để nằm trong cùng transaction với nghiệp vụ thu tiền / huỷ hoá đơn.
 */
@Injectable()
export class SalesRollupRepository {
  /**
   * Cộng (sign = 1) hoặc trừ (sign = -1) một đơn vào tổng hợp, theo ngày thu VN của đơn. `revenueDelta` là phần doanh
   * thu thêm/bớt của đơn (thu: +tổng; huỷ: −tiền hoàn); dòng sản phẩm luôn cộng/trừ trọn vẹn số lượng, doanh thu và
   * giá vốn của đơn. Đúng 1 câu cho mỗi bảng, thêm 1 câu khoá chia sẻ theo ngày để `rebuild` không chạy xen vào.
   */
  async applyOrder(tx: Prisma.TransactionClient, orderId: string, sign: 1 | -1, revenueDelta: bigint): Promise<void> {
    await tx.$executeRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock_shared(${dayLockKey(VN_DAY)})
      FROM orders o WHERE o."id" = ${orderId}::uuid AND o."completedAt" IS NOT NULL`);

    await tx.$executeRaw(Prisma.sql`
      INSERT INTO sales_daily ("branchId", "date", "channel", "orderCount", "revenue", "updatedAt")
      SELECT o."branchId", ${VN_DAY}, o."channel", ${sign}::int, ${revenueDelta}::bigint, now()
      FROM orders o
      WHERE o."id" = ${orderId}::uuid AND o."completedAt" IS NOT NULL
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
      WHERE o."id" = ${orderId}::uuid AND o."completedAt" IS NOT NULL
      GROUP BY o."branchId", ${VN_DAY}, o."channel", oi."productId"
      ORDER BY oi."productId"
      ON CONFLICT ("branchId", "date", "channel", "productId") DO UPDATE SET
        "qtyBase" = sales_daily_product."qtyBase" + EXCLUDED."qtyBase",
        "revenue" = sales_daily_product."revenue" + EXCLUDED."revenue",
        "cogsAmount" = sales_daily_product."cogsAmount" + EXCLUDED."cogsAmount"`);
  }

  /**
   * Xoá rồi dựng lại tổng hợp cho các ngày VN trong [fromDate, toDate] từ dữ liệu gốc. Khoá độc quyền từng ngày
   * (theo thứ tự tăng dần) trước khi xoá: đơn đang thu dở giữ khoá chia sẻ nên `rebuild` chờ nó commit rồi mới đọc.
   */
  async rebuild(
    tx: Prisma.TransactionClient,
    fromDate: string,
    toDate: string,
  ): Promise<{ days: number; rows: number }> {
    const days = daysBetweenDateOnly(fromDate, toDate) + 1;
    if (days < 1) throw new Error(`Khoảng ngày không hợp lệ: ${fromDate} → ${toDate}`);
    const start = vietnamDayStartUtc(fromDate);
    const end = vietnamDayStartUtc(addDaysToDateOnly(toDate, 1));

    await tx.$executeRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(hashtextextended('sales-rollup:' || g."d"::date::text, 0))
      FROM generate_series(${fromDate}::date, ${toDate}::date, interval '1 day') AS g("d")`);

    await tx.$executeRaw(
      Prisma.sql`DELETE FROM sales_daily WHERE "date" BETWEEN ${fromDate}::date AND ${toDate}::date`,
    );
    await tx.$executeRaw(
      Prisma.sql`DELETE FROM sales_daily_product WHERE "date" BETWEEN ${fromDate}::date AND ${toDate}::date`,
    );

    // Đơn đã thu = COMPLETED (còn hiệu lực) hoặc CANCELLED mà có `completedAt` (thu rồi mới huỷ). Đơn huỷ vẫn sinh dòng
    // (với 0 đơn / phần tiền giữ lại), đúng như khi `applyOrder` cộng rồi trừ.
    const daily = await tx.$executeRaw(Prisma.sql`
      INSERT INTO sales_daily ("branchId", "date", "channel", "orderCount", "revenue", "updatedAt")
      SELECT o."branchId", ${VN_DAY}, o."channel",
             (COUNT(*) FILTER (WHERE o."status" = 'COMPLETED'))::int,
             COALESCE(SUM(CASE WHEN o."status" = 'COMPLETED' THEN o."totalAmount" ELSE o."totalAmount" - r."refund" END), 0)::bigint,
             now()
      FROM orders o
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(p."amount"), 0) AS "refund" FROM payments p
        WHERE p."orderId" = o."id" AND p."kind" = 'REFUND' AND p."status" = 'SUCCESS'
      ) r ON true
      WHERE o."completedAt" >= ${start} AND o."completedAt" < ${end}
        AND o."status" IN ('COMPLETED', 'CANCELLED') AND o."isDeleted" = false
      GROUP BY o."branchId", ${VN_DAY}, o."channel"`);

    const perProduct = await tx.$executeRaw(Prisma.sql`
      INSERT INTO sales_daily_product ("branchId", "date", "channel", "productId", "qtyBase", "revenue", "cogsAmount")
      SELECT o."branchId", ${VN_DAY}, o."channel", oi."productId",
             COALESCE(SUM(CASE WHEN o."status" = 'COMPLETED' THEN oi."baseQuantity" ELSE 0 END), 0)::int,
             COALESCE(SUM(CASE WHEN o."status" = 'COMPLETED' THEN oi."totalPrice" ELSE 0 END), 0)::bigint,
             COALESCE(SUM(CASE WHEN o."status" = 'COMPLETED' THEN c."cost" ELSE 0 END), 0)::bigint
      FROM orders o
      JOIN order_items oi ON oi."orderId" = o."id" AND oi."isDeleted" = false
      LEFT JOIN LATERAL (
        SELECT SUM(b."quantity"::bigint * b."unitCost") AS "cost"
        FROM order_item_batches b WHERE b."orderItemId" = oi."id"
      ) c ON true
      WHERE o."completedAt" >= ${start} AND o."completedAt" < ${end}
        AND o."status" IN ('COMPLETED', 'CANCELLED') AND o."isDeleted" = false
      GROUP BY o."branchId", ${VN_DAY}, o."channel", oi."productId"`);

    return { days, rows: daily + perProduct };
  }
}
