-- Giá vốn theo ngày: sales_daily.cogsAmount = Σ sales_daily_product.cogsAmount theo (branchId, date, channel).
ALTER TABLE "sales_daily" ADD COLUMN "cogsAmount" BIGINT NOT NULL DEFAULT 0;

UPDATE "sales_daily" d
SET "cogsAmount" = p."cogs"
FROM (
  SELECT "branchId", "date", "channel", SUM("cogsAmount") AS "cogs"
  FROM "sales_daily_product"
  GROUP BY "branchId", "date", "channel"
) p
WHERE p."branchId" = d."branchId" AND p."date" = d."date" AND p."channel" = d."channel";
