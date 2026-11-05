-- Ba truy vấn của GET /reports/sales (giống SalesReportRepository). Biến pgbench:
--   -D days=N   : khoảng [2026-11-05 - N, 2026-11-05], tức N+1 ngày
--   -D one=1|0  : 1 = chỉ chi nhánh 1, 0 = toàn chuỗi (không lọc chi nhánh)
\if :one
SELECT to_char(s."date", 'YYYY-MM-DD') AS "date", SUM(s."orderCount")::int AS "orders", SUM(s."revenue")::bigint AS "revenue"
FROM sales_daily s WHERE s."date" BETWEEN date '2026-11-05' - :days AND date '2026-11-05' AND s."branchId" = ANY(ARRAY[md5('branch1')::uuid])
GROUP BY s."date" ORDER BY s."date";
SELECT b."id", b."name", COALESCE(s."orderCount", 0)::int, COALESCE(s."revenue", 0)::bigint
FROM branches b LEFT JOIN (SELECT s."branchId", SUM(s."orderCount") AS "orderCount", SUM(s."revenue") AS "revenue"
  FROM sales_daily s WHERE s."date" BETWEEN date '2026-11-05' - :days AND date '2026-11-05' AND s."branchId" = ANY(ARRAY[md5('branch1')::uuid]) GROUP BY s."branchId") s ON s."branchId" = b."id"
WHERE (b."isDeleted" = false OR s."branchId" IS NOT NULL) AND b."id" = ANY(ARRAY[md5('branch1')::uuid]) ORDER BY 4 DESC, b."name", b."id";
SELECT p."id", p."name", t."qtyBase"::int, t."revenue"::bigint
FROM (SELECT s."productId", SUM(s."qtyBase") AS "qtyBase", SUM(s."revenue") AS "revenue" FROM sales_daily_product s
  WHERE s."date" BETWEEN date '2026-11-05' - :days AND date '2026-11-05' AND s."branchId" = ANY(ARRAY[md5('branch1')::uuid])
  GROUP BY s."productId" HAVING SUM(s."qtyBase") > 0 ORDER BY SUM(s."revenue") DESC, SUM(s."qtyBase") DESC, s."productId" LIMIT 10) t
JOIN products p ON p."id" = t."productId" ORDER BY t."revenue" DESC, t."qtyBase" DESC, p."id";
\else
SELECT to_char(s."date", 'YYYY-MM-DD') AS "date", SUM(s."orderCount")::int AS "orders", SUM(s."revenue")::bigint AS "revenue"
FROM sales_daily s WHERE s."date" BETWEEN date '2026-11-05' - :days AND date '2026-11-05'
GROUP BY s."date" ORDER BY s."date";
SELECT b."id", b."name", COALESCE(s."orderCount", 0)::int, COALESCE(s."revenue", 0)::bigint
FROM branches b LEFT JOIN (SELECT s."branchId", SUM(s."orderCount") AS "orderCount", SUM(s."revenue") AS "revenue"
  FROM sales_daily s WHERE s."date" BETWEEN date '2026-11-05' - :days AND date '2026-11-05' GROUP BY s."branchId") s ON s."branchId" = b."id"
WHERE (b."isDeleted" = false OR s."branchId" IS NOT NULL) ORDER BY 4 DESC, b."name", b."id";
SELECT p."id", p."name", t."qtyBase"::int, t."revenue"::bigint
FROM (SELECT s."productId", SUM(s."qtyBase") AS "qtyBase", SUM(s."revenue") AS "revenue" FROM sales_daily_product s
  WHERE s."date" BETWEEN date '2026-11-05' - :days AND date '2026-11-05'
  GROUP BY s."productId" HAVING SUM(s."qtyBase") > 0 ORDER BY SUM(s."revenue") DESC, SUM(s."qtyBase") DESC, s."productId" LIMIT 10) t
JOIN products p ON p."id" = t."productId" ORDER BY t."revenue" DESC, t."qtyBase" DESC, p."id";
\endif
