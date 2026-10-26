-- AlterEnum
ALTER TYPE "StockRefType" ADD VALUE 'OPENING_STOCK';

-- AlterEnum (viên sủi, thuốc xịt của FE)
ALTER TYPE "DosageForm" ADD VALUE 'EFFERVESCENT' BEFORE 'OTHER';
ALTER TYPE "DosageForm" ADD VALUE 'SPRAY' BEFORE 'OTHER';

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "isControlled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "registrationNumber" VARCHAR(50),
ADD COLUMN     "countryOfOrigin" VARCHAR(100),
ADD COLUMN     "maxStockLevel" INTEGER,
ADD COLUMN     "shortName" VARCHAR(100),
ADD COLUMN     "weight" DECIMAL(12,3),
ADD COLUMN     "weightUnit" VARCHAR(5) NOT NULL DEFAULT 'g',
ADD COLUMN     "description" TEXT,
ADD COLUMN     "orderNote" TEXT,
ADD COLUMN     "isFavourite" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "nationalDrugCode" VARCHAR(50),
ADD COLUMN     "routeId" UUID;

-- AlterTable
ALTER TABLE "product_units" ADD COLUMN     "allowLooseSale" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "nationalUnitCode" VARCHAR(50);

-- CreateTable
CREATE TABLE "administration_routes" (
    "id" UUID NOT NULL,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" UUID,
    "updatedAt" TIMESTAMPTZ(3),
    "updatedBy" UUID,
    "name" VARCHAR(100) NOT NULL,

    CONSTRAINT "administration_routes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "administration_routes_name_key" ON "administration_routes"("name");

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "administration_routes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable: phiếu điều chỉnh (đợt 6) — ngày chứng từ, người xuất/nhận, loại xuất nội bộ, sao, mã 40 ký tự
ALTER TABLE "stock_adjustments" ALTER COLUMN "code" TYPE VARCHAR(40),
ADD COLUMN     "documentDate" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "handlerId" UUID,
ADD COLUMN     "receiverId" UUID,
ADD COLUMN     "internalUseTypeId" UUID,
ADD COLUMN     "isFavourite" BOOLEAN NOT NULL DEFAULT false;

-- Phiếu cũ: ngày chứng từ = lúc lập.
UPDATE "stock_adjustments" SET "documentDate" = "createdAt";

-- CreateTable
CREATE TABLE "internal_use_types" (
    "id" UUID NOT NULL,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" UUID,
    "updatedAt" TIMESTAMPTZ(3),
    "updatedBy" UUID,
    "name" VARCHAR(100) NOT NULL,

    CONSTRAINT "internal_use_types_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "internal_use_types_name_key" ON "internal_use_types"("name");

-- AddForeignKey
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_handlerId_fkey" FOREIGN KEY ("handlerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_receiverId_fkey" FOREIGN KEY ("receiverId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_internalUseTypeId_fkey" FOREIGN KEY ("internalUseTypeId") REFERENCES "internal_use_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable: nhận điều chuyển thiếu + lý do lệch
ALTER TABLE "stock_transfer_items" ADD COLUMN "receivedQuantity" INTEGER,
ADD COLUMN "varianceReason" TEXT;

-- Phiếu đã nhận trước đây: nhận đủ.
UPDATE "stock_transfer_items" AS i SET "receivedQuantity" = i."quantity"
FROM "stock_transfers" AS t WHERE t."id" = i."transferId" AND t."status" = 'RECEIVED';

-- AlterTable: tiền phiếu trả NCC + liên kết phiếu nhập gốc
ALTER TABLE "stock_adjustments" ADD COLUMN "goodsReceiptId" UUID,
ADD COLUMN "goodsAmount" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN "discountAmount" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN "discountPercent" DECIMAL(5,2),
ADD COLUMN "refundExpenseAmount" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN "refundExpenses" JSONB,
ADD COLUMN "totalAmount" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN "supplierPaid" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN "paymentMethod" "PaymentMethod";

ALTER TABLE "stock_adjustment_items" ADD COLUMN "returnPrice" INTEGER,
ADD COLUMN "goodsReceiptItemId" UUID;

ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_goodsReceiptId_fkey" FOREIGN KEY ("goodsReceiptId") REFERENCES "goods_receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_adjustment_items" ADD CONSTRAINT "stock_adjustment_items_goodsReceiptItemId_fkey" FOREIGN KEY ("goodsReceiptItemId") REFERENCES "goods_receipt_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "stock_adjustment_items_goodsReceiptItemId_idx" ON "stock_adjustment_items"("goodsReceiptItemId");

-- Tiền luôn hợp lệ (cùng luật với service): không âm, NCC trả ≤ cần trả, cần trả = hàng − giảm + hoàn.
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_money_check" CHECK (
  "goodsAmount" >= 0 AND "discountAmount" >= 0 AND "discountAmount" <= "goodsAmount" AND "refundExpenseAmount" >= 0
  AND "totalAmount" = "goodsAmount" - "discountAmount" + "refundExpenseAmount"
  AND "supplierPaid" >= 0 AND "supplierPaid" <= "totalAmount"
);

-- Bán hàng (đợt 7): thanh toán thẻ, giảm giá đơn, ghi đè tương tác, huỷ hoá đơn đã thu (hoàn tiền).
ALTER TYPE "PaymentMethod" ADD VALUE 'CARD';

ALTER TABLE "orders" ADD COLUMN "discountAmount" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN "interactionOverride" JSONB;

ALTER TABLE "orders" DROP CONSTRAINT "orders_total_formula_chk",
  ADD CONSTRAINT "orders_total_formula_chk" CHECK ("totalAmount" = "subtotalAmount" + "shippingFee" - "discountAmount"),
  ADD CONSTRAINT "orders_discount_range_chk" CHECK ("discountAmount" >= 0 AND "discountAmount" <= "subtotalAmount"),
  DROP CONSTRAINT "orders_payment_status_chk",
  -- REFUNDED: hoá đơn đã thu bị huỷ (hoàn tiền + hoàn kho).
  ADD CONSTRAINT "orders_payment_status_chk" CHECK ("paymentStatus" IN ('UNPAID', 'PAID', 'REFUNDED'));

-- Seed: 14 đường dùng như danh mục mặc định của FE (13 của KiotViet + Bôi ngoài da).
INSERT INTO "administration_routes" ("id", "name") VALUES
  (gen_random_uuid(), 'Đặt âm đạo'),
  (gen_random_uuid(), 'Đặt hậu môn'),
  (gen_random_uuid(), 'Nhỏ mắt'),
  (gen_random_uuid(), 'Nhỏ mũi'),
  (gen_random_uuid(), 'Nhỏ tai'),
  (gen_random_uuid(), 'Tiêm bắp'),
  (gen_random_uuid(), 'Tiêm dưới da'),
  (gen_random_uuid(), 'Tiêm tĩnh mạch'),
  (gen_random_uuid(), 'Tra mắt'),
  (gen_random_uuid(), 'Truyền'),
  (gen_random_uuid(), 'Uống'),
  (gen_random_uuid(), 'Xịt mũi họng'),
  (gen_random_uuid(), 'Xông hít'),
  (gen_random_uuid(), 'Bôi ngoài da')
ON CONFLICT ("name") DO NOTHING;
