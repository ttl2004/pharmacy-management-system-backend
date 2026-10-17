-- CreateEnum
CREATE TYPE "OrderChannel" AS ENUM ('POS', 'ONLINE');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'CONFIRMED', 'PREPARING', 'SHIPPING', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'BANK_TRANSFER', 'COD');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" UUID,
    "updatedAt" TIMESTAMPTZ(3),
    "updatedBy" UUID,
    "code" VARCHAR(20) NOT NULL,
    "branchId" UUID NOT NULL,
    "customerId" UUID,
    "staffId" UUID,
    "channel" "OrderChannel" NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "subtotalAmount" BIGINT NOT NULL DEFAULT 0,
    "shippingFee" INTEGER NOT NULL DEFAULT 0,
    "totalAmount" BIGINT NOT NULL DEFAULT 0,
    "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'UNPAID',
    "prescriptionCode" VARCHAR(50),
    "prescriberName" VARCHAR(150),
    "prescriptionImageUrl" TEXT,
    "note" TEXT,
    "cancelReason" TEXT,
    "confirmedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" UUID,
    "updatedAt" TIMESTAMPTZ(3),
    "updatedBy" UUID,
    "orderId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "productUnitId" UUID NOT NULL,
    "productName" VARCHAR(250) NOT NULL,
    "unitName" VARCHAR(50) NOT NULL,
    "conversionRate" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "baseQuantity" INTEGER NOT NULL,
    "unitPrice" INTEGER NOT NULL,
    "totalPrice" BIGINT NOT NULL,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_item_batches" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "orderItemId" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitCost" INTEGER NOT NULL,

    CONSTRAINT "order_item_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" UUID,
    "updatedAt" TIMESTAMPTZ(3),
    "orderId" UUID NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amount" BIGINT NOT NULL,
    "status" "TransactionStatus" NOT NULL DEFAULT 'PENDING',
    "transactionCode" VARCHAR(100),
    "paidAt" TIMESTAMPTZ(3),
    "note" TEXT,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "orders_code_key" ON "orders"("code");

-- CreateIndex
CREATE INDEX "orders_branchId_status_idx" ON "orders"("branchId", "status");

-- CreateIndex
CREATE INDEX "orders_branchId_createdAt_idx" ON "orders"("branchId", "createdAt");

-- CreateIndex
CREATE INDEX "orders_customerId_idx" ON "orders"("customerId");

-- CreateIndex
CREATE INDEX "orders_createdAt_idx" ON "orders"("createdAt");

-- CreateIndex
CREATE INDEX "orders_status_channel_createdAt_idx" ON "orders"("status", "channel", "createdAt");

-- CreateIndex
CREATE INDEX "order_items_orderId_idx" ON "order_items"("orderId");

-- CreateIndex
CREATE INDEX "order_items_productId_idx" ON "order_items"("productId");

-- CreateIndex
CREATE INDEX "order_item_batches_batchId_idx" ON "order_item_batches"("batchId");

-- CreateIndex
CREATE UNIQUE INDEX "order_item_batches_orderItemId_batchId_key" ON "order_item_batches"("orderItemId", "batchId");

-- CreateIndex
CREATE INDEX "payments_orderId_idx" ON "payments"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "payments_method_transactionCode_key" ON "payments"("method", "transactionCode");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_productUnitId_fkey" FOREIGN KEY ("productUnitId") REFERENCES "product_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_batches" ADD CONSTRAINT "order_item_batches_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_batches" ADD CONSTRAINT "order_item_batches_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "stock_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ============================================================
--  PHẦN VIẾT TAY — Prisma không khai được CHECK / SEQUENCE nhưng cũng không xoá chúng ở migration sau.
--  Mỗi ràng buộc dưới đây có một test e2e chứng minh DB từ chối dữ liệu sai (test/sales-schema.e2e-spec.ts).
-- ============================================================

-- Mã đơn hàng: HD000001. Có thể hụt số khi transaction rollback — chấp nhận, mã chỉ cần duy nhất.
CREATE SEQUENCE "order_code_seq";

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_amounts_non_negative_chk" CHECK ("subtotalAmount" >= 0 AND "shippingFee" >= 0),
  ADD CONSTRAINT "orders_total_formula_chk" CHECK ("totalAmount" = "subtotalAmount" + "shippingFee"),
  ADD CONSTRAINT "orders_pos_no_shipping_chk" CHECK ("channel" <> 'POS' OR "shippingFee" = 0),
  -- Thanh toán một lần, chưa có hoàn tiền: đơn chỉ UNPAID/PAID (PARTIAL, REFUNDED dành cho phiếu nhập).
  ADD CONSTRAINT "orders_payment_status_chk" CHECK ("paymentStatus" IN ('UNPAID', 'PAID')),
  ADD CONSTRAINT "orders_cancel_reason_chk" CHECK ("status" <> 'CANCELLED' OR "cancelReason" IS NOT NULL);

ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_quantity_positive_chk" CHECK ("quantity" > 0),
  ADD CONSTRAINT "order_items_conversion_positive_chk" CHECK ("conversionRate" > 0),
  ADD CONSTRAINT "order_items_base_quantity_chk" CHECK ("baseQuantity" = "quantity" * "conversionRate"),
  ADD CONSTRAINT "order_items_price_non_negative_chk" CHECK ("unitPrice" >= 0),
  ADD CONSTRAINT "order_items_total_formula_chk" CHECK ("totalPrice" = "quantity"::bigint * "unitPrice");

ALTER TABLE "order_item_batches"
  ADD CONSTRAINT "order_item_batches_quantity_positive_chk" CHECK ("quantity" > 0),
  ADD CONSTRAINT "order_item_batches_cost_non_negative_chk" CHECK ("unitCost" >= 0);

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_amount_positive_chk" CHECK ("amount" > 0);
