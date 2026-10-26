-- CreateEnum
CREATE TYPE "SupplierPaymentSource" AS ENUM ('MANUAL', 'RECEIPT');

-- AlterTable
ALTER TABLE "goods_receipt_items" ADD COLUMN     "note" TEXT,
ADD COLUMN     "unitDiscount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "goods_receipts" ADD COLUMN     "discountPercent" DECIMAL(5,2),
ADD COLUMN     "expenses" JSONB,
ADD COLUMN     "otherExpenseAmount" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "paymentMethod" "PaymentMethod",
ADD COLUMN     "receiverId" UUID,
ADD COLUMN     "supplierExpenseAmount" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "suppliers" ADD COLUMN     "companyName" VARCHAR(200),
ADD COLUMN     "groupId" UUID,
ADD COLUMN     "idNumber" VARCHAR(20);

-- CreateTable
CREATE TABLE "supplier_groups" (
    "id" UUID NOT NULL,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" UUID,
    "updatedAt" TIMESTAMPTZ(3),
    "updatedBy" UUID,
    "name" VARCHAR(100) NOT NULL,
    "note" TEXT,

    CONSTRAINT "supplier_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_payments" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" UUID,
    "updatedAt" TIMESTAMPTZ(3),
    "updatedBy" UUID,
    "code" VARCHAR(20) NOT NULL,
    "supplierId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "paidAt" TIMESTAMPTZ(3) NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amount" BIGINT NOT NULL,
    "note" TEXT,
    "source" "SupplierPaymentSource" NOT NULL DEFAULT 'MANUAL',
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelledBy" UUID,
    "cancelReason" TEXT,

    CONSTRAINT "supplier_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_payment_allocations" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paymentId" UUID NOT NULL,
    "receiptId" UUID NOT NULL,
    "amount" BIGINT NOT NULL,

    CONSTRAINT "supplier_payment_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_debt_adjustments" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" UUID,
    "updatedAt" TIMESTAMPTZ(3),
    "updatedBy" UUID,
    "code" VARCHAR(20) NOT NULL,
    "supplierId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "adjustedAt" TIMESTAMPTZ(3) NOT NULL,
    "debtBefore" BIGINT NOT NULL,
    "debtAfter" BIGINT NOT NULL,
    "delta" BIGINT NOT NULL,
    "note" TEXT NOT NULL,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelledBy" UUID,
    "cancelReason" TEXT,

    CONSTRAINT "supplier_debt_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "supplier_payments_code_key" ON "supplier_payments"("code");

-- CreateIndex
CREATE INDEX "supplier_payments_supplierId_paidAt_idx" ON "supplier_payments"("supplierId", "paidAt");

-- CreateIndex
CREATE INDEX "supplier_payments_branchId_idx" ON "supplier_payments"("branchId");

-- CreateIndex
CREATE INDEX "supplier_payment_allocations_receiptId_idx" ON "supplier_payment_allocations"("receiptId");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_payment_allocations_paymentId_receiptId_key" ON "supplier_payment_allocations"("paymentId", "receiptId");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_debt_adjustments_code_key" ON "supplier_debt_adjustments"("code");

-- CreateIndex
CREATE INDEX "supplier_debt_adjustments_supplierId_createdAt_idx" ON "supplier_debt_adjustments"("supplierId", "createdAt");

-- CreateIndex
CREATE INDEX "supplier_debt_adjustments_branchId_idx" ON "supplier_debt_adjustments"("branchId");

-- CreateIndex
CREATE INDEX "suppliers_groupId_idx" ON "suppliers"("groupId");

-- AddForeignKey
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "supplier_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_receiverId_fkey" FOREIGN KEY ("receiverId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_groups" ADD CONSTRAINT "supplier_groups_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_groups" ADD CONSTRAINT "supplier_groups_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_cancelledBy_fkey" FOREIGN KEY ("cancelledBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "supplier_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "goods_receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_debt_adjustments" ADD CONSTRAINT "supplier_debt_adjustments_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_debt_adjustments" ADD CONSTRAINT "supplier_debt_adjustments_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_debt_adjustments" ADD CONSTRAINT "supplier_debt_adjustments_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_debt_adjustments" ADD CONSTRAINT "supplier_debt_adjustments_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_debt_adjustments" ADD CONSTRAINT "supplier_debt_adjustments_cancelledBy_fkey" FOREIGN KEY ("cancelledBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ============================================================================
-- PHẦN VIẾT TAY (Prisma không quản lý: SEQUENCE, CHECK, backfill)
-- ============================================================================

CREATE SEQUENCE "supplier_payment_code_seq";
CREATE SEQUENCE "supplier_debt_adjustment_code_seq";

-- Đổi công thức tổng phiếu nhập: cộng thêm chi phí NCC. Cột mới default 0 nên dữ liệu cũ vẫn thoả.
ALTER TABLE "goods_receipts"
  DROP CONSTRAINT "goods_receipts_total_formula_chk",
  ADD CONSTRAINT "goods_receipts_total_formula_chk"
    CHECK ("totalAmount" = "subtotalAmount" - "discountAmount" + "vatAmount" + "supplierExpenseAmount"),
  ADD CONSTRAINT "goods_receipts_expenses_non_negative_chk" CHECK ("supplierExpenseAmount" >= 0 AND "otherExpenseAmount" >= 0),
  ADD CONSTRAINT "goods_receipts_discount_percent_chk" CHECK ("discountPercent" IS NULL OR "discountPercent" BETWEEN 0 AND 100),
  ADD CONSTRAINT "goods_receipts_payment_method_chk" CHECK ("paymentMethod" IS NULL OR "paymentMethod" <> 'COD');

-- Đổi công thức thành tiền dòng: trừ giảm giá trên đơn vị. unitDiscount default 0 nên dữ liệu cũ vẫn thoả.
ALTER TABLE "goods_receipt_items"
  DROP CONSTRAINT "goods_receipt_items_total_formula_chk",
  ADD CONSTRAINT "goods_receipt_items_total_formula_chk"
    CHECK ("totalPrice" = "quantity"::bigint * ("importPrice" - "unitDiscount")),
  ADD CONSTRAINT "goods_receipt_items_unit_discount_chk" CHECK ("unitDiscount" >= 0 AND "unitDiscount" <= "importPrice");

ALTER TABLE "supplier_payments"
  ADD CONSTRAINT "supplier_payments_amount_positive_chk" CHECK ("amount" > 0),
  ADD CONSTRAINT "supplier_payments_method_chk" CHECK ("method" <> 'COD');

ALTER TABLE "supplier_payment_allocations"
  ADD CONSTRAINT "supplier_payment_allocations_amount_positive_chk" CHECK ("amount" > 0);

ALTER TABLE "supplier_debt_adjustments"
  ADD CONSTRAINT "supplier_debt_adjustments_delta_chk" CHECK ("delta" = "debtAfter" - "debtBefore" AND "delta" <> 0),
  ADD CONSTRAINT "supplier_debt_adjustments_after_non_negative_chk" CHECK ("debtAfter" >= 0);

-- Backfill: mỗi phiếu CONFIRMED có paidAmount > 0 -> 1 phiếu chi TTPN (RECEIPT, tiền mặt) + 1 dòng phân bổ.
-- Chỉ INSERT vào bảng mới; không sửa dữ liệu phiếu nhập cũ.
WITH src AS (
  SELECT
    gen_random_uuid() AS payment_id,
    r."id" AS receipt_id,
    r."supplierId", r."branchId", r."paidAmount",
    COALESCE(r."updatedAt", r."confirmedAt", r."createdAt") AS paid_at,
    COALESCE(r."updatedBy", r."confirmedBy", r."createdBy") AS actor,
    r."createdAt"
  FROM "goods_receipts" r
  WHERE r."status" = 'CONFIRMED' AND r."paidAmount" > 0 AND r."isDeleted" = false
),
ins_payment AS (
  INSERT INTO "supplier_payments"
    ("id", "createdAt", "createdBy", "code", "supplierId", "branchId", "paidAt", "method", "amount", "source", "note")
  SELECT
    s.payment_id, s.paid_at, s.actor,
    'TTPN' || lpad(nextval('supplier_payment_code_seq')::text, 6, '0'),
    s."supplierId", s."branchId", s.paid_at, 'CASH', s."paidAmount", 'RECEIPT', 'Backfill từ tiền đã trả của phiếu nhập'
  FROM src s
  ORDER BY s."createdAt"
  RETURNING "id"
)
INSERT INTO "supplier_payment_allocations" ("id", "createdAt", "paymentId", "receiptId", "amount")
SELECT gen_random_uuid(), s.paid_at, s.payment_id, s.receipt_id, s."paidAmount"
FROM src s
WHERE s.payment_id IN (SELECT "id" FROM ins_payment);
