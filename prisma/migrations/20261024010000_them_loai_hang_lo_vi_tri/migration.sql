-- CreateEnum
CREATE TYPE "ProductType" AS ENUM ('DRUG', 'GOODS');

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "trackBatches" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "type" "ProductType" NOT NULL DEFAULT 'DRUG';

-- CreateTable
CREATE TABLE "shelf_locations" (
    "id" UUID NOT NULL,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" UUID,
    "updatedAt" TIMESTAMPTZ(3),
    "updatedBy" UUID,
    "name" VARCHAR(100) NOT NULL,

    CONSTRAINT "shelf_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_locations" (
    "productId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_locations_pkey" PRIMARY KEY ("productId","locationId")
);

-- CreateIndex
CREATE INDEX "products_type_idx" ON "products"("type");

-- CreateIndex
CREATE UNIQUE INDEX "shelf_locations_name_key" ON "shelf_locations"("name");

-- CreateIndex
CREATE INDEX "product_locations_locationId_idx" ON "product_locations"("locationId");

-- AddForeignKey
ALTER TABLE "product_locations" ADD CONSTRAINT "product_locations_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_locations" ADD CONSTRAINT "product_locations_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "shelf_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill: sản phẩm có sẵn được gán loại theo tên nhóm, khớp cách FE đoán trước đây
-- (nhóm có chữ "thuốc" → thuốc theo lô; còn lại → hàng hoá không theo lô).
UPDATE "products" AS p
SET "type" = 'GOODS', "trackBatches" = false
FROM "categories" AS c
WHERE c."id" = p."categoryId" AND c."name" NOT ILIKE '%thuốc%';
