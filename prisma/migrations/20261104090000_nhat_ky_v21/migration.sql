-- Migration nhat_ky_v21: cột sự kiện cho audit_logs, bảng security_events, backfill dữ liệu cũ,
-- CHECK và trigger bất biến (append-only). Phần viết tay ở cuối file, dưới banner PHẦN VIẾT TAY.
-- "event" thêm dạng nullable trước vì bảng đã có dữ liệu; SET NOT NULL sau khi backfill.

-- DropIndex
DROP INDEX "audit_logs_branchId_createdAt_idx";

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "actorBranchId" UUID,
ADD COLUMN     "actorRoleCode" VARCHAR(50),
ADD COLUMN     "actorType" VARCHAR(10) NOT NULL DEFAULT 'USER',
ADD COLUMN     "amount" BIGINT,
ADD COLUMN     "branchIds" UUID[] DEFAULT ARRAY[]::UUID[],
ADD COLUMN     "entityLabel" VARCHAR(120),
ADD COLUMN     "event" VARCHAR(64),
ADD COLUMN     "metadata" JSONB,
ADD COLUMN     "metadataVersion" SMALLINT NOT NULL DEFAULT 1,
ADD COLUMN     "requestId" UUID,
ADD COLUMN     "searchText" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "severity" SMALLINT NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "security_events" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" VARCHAR(40) NOT NULL,
    "outcome" VARCHAR(10) NOT NULL,
    "severity" SMALLINT NOT NULL DEFAULT 0,
    "actorId" UUID,
    "actorRoleCode" VARCHAR(50),
    "sessionId" VARCHAR(50),
    "ipAddress" VARCHAR(45),
    "userAgent" VARCHAR(255),
    "requestId" UUID,
    "metadata" JSONB,

    CONSTRAINT "security_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "security_events_createdAt_id_idx" ON "security_events"("createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "security_events_actorId_type_createdAt_idx" ON "security_events"("actorId", "type", "createdAt");

-- CreateIndex
CREATE INDEX "security_events_type_createdAt_idx" ON "security_events"("type", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_id_idx" ON "audit_logs"("createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_event_createdAt_idx" ON "audit_logs"("event", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_branchIds_idx" ON "audit_logs" USING GIN ("branchIds");

-- CreateIndex
CREATE INDEX "audit_logs_search_trgm_idx" ON "audit_logs" USING GIN ("searchText" extensions.gin_trgm_ops);

-- ============================================================
-- PHẦN VIẾT TAY
-- Thứ tự: vn_fold → backfill (event, actorType, branchIds, metadataVersion, searchText)
--         → event NOT NULL → CHECK → trigger bất biến (cuối cùng, sau mọi UPDATE backfill).
-- Không suy "amount" cho dòng cũ (D13). actorRoleCode/actorBranchId/requestId/entityLabel để NULL.
-- ============================================================

-- 1. vn_fold: bỏ dấu tiếng Việt, PHẢI cho kết quả y hệt foldVn (src/common/utils/vn-fold.util.ts).
--    134 ký tự có dấu (67 thường kể cả đ + 67 hoa) → không dấu; NULL → ''. Chỉ dùng cho backfill.
CREATE OR REPLACE FUNCTION vn_fold(input text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT btrim(regexp_replace(
    translate(
      lower(normalize(coalesce(input, ''), NFC)),
      'àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđÀÁẢÃẠĂẰẮẲẴẶÂẦẤẨẪẬÈÉẺẼẸÊỀẾỂỄỆÌÍỈĨỊÒÓỎÕỌÔỒỐỔỖỘƠỜỚỞỠỢÙÚỦŨỤƯỪỨỬỮỰỲÝỶỸỴĐ',
      'aaaaaaaaaaaaaaaaaeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyydaaaaaaaaaaaaaaaaaeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyyd'
    ),
    '\s+', ' ', 'g'
  ), ' ')
$$;

-- 2. Backfill "event" (ánh xạ plan v2 Task 1 Step 3.1).
UPDATE "audit_logs" AS a
SET "event" = CASE
  -- orders
  WHEN a."entityType" = 'orders' AND a."before"->>'status' = 'COMPLETED' AND a."after"->>'status' = 'CANCELLED'
    THEN 'ORDER.VOID_PAID'
  WHEN a."entityType" = 'orders' AND a."actorId" = '00000000-0000-0000-0000-000000000000' AND a."after"->>'status' = 'CANCELLED'
    THEN 'ORDER.AUTO_EXPIRED'
  WHEN a."entityType" = 'orders' AND a."after"->>'status' = 'CANCELLED' THEN 'ORDER.CANCELLED'
  WHEN a."entityType" = 'orders' AND a."after"->>'status' = 'COMPLETED' THEN 'ORDER.PAID'
  WHEN a."entityType" = 'orders' AND a."action" = 'CREATE' THEN 'ORDER.CREATED'
  WHEN a."entityType" = 'orders' AND a."action" = 'UPDATE' THEN 'ORDER.ITEMS_REPLACED'
  -- users
  WHEN a."entityType" = 'users' AND a."action" = 'CREATE' THEN 'CUSTOMER.CREATED'
  -- stock_adjustments: tiền tố theo stock_adjustments.type
  WHEN a."entityType" = 'stock_adjustments' THEN
    coalesce(
      (SELECT CASE sa."type"::text
                WHEN 'DISPOSE' THEN 'DISPOSAL'
                WHEN 'RETURN_TO_SUPPLIER' THEN 'PURCHASE_RETURN'
              END
         FROM "stock_adjustments" AS sa WHERE sa."id" = a."entityId"),
      'STOCK_ADJUSTMENT'
    )
    || '.' ||
    CASE
      WHEN a."action" = 'CREATE' THEN 'CREATED'
      WHEN a."action" = 'UPDATE' THEN 'UPDATED'
      WHEN a."action" = 'DELETE' THEN 'DELETED'
      WHEN a."after"->>'status' = 'CONFIRMED' THEN 'CONFIRMED'
      WHEN a."after"->>'status' = 'CANCELLED' THEN 'CANCELLED'
      ELSE 'STATUS_CHANGED'
    END
  -- stock_batches
  WHEN a."entityType" = 'stock_batches' AND a."after"->>'status' = 'RECALLED' THEN 'BATCH.RECALLED'
  WHEN a."entityType" = 'stock_batches' THEN 'BATCH.STATUS_CHANGED'
  -- stock_transfers
  WHEN a."entityType" = 'stock_transfers' AND a."action" = 'CREATE' THEN 'TRANSFER.CREATED'
  WHEN a."entityType" = 'stock_transfers' AND a."action" = 'UPDATE' THEN 'TRANSFER.UPDATED'
  WHEN a."entityType" = 'stock_transfers' AND a."after"->>'status' = 'IN_TRANSIT' THEN 'TRANSFER.SHIPPED'
  WHEN a."entityType" = 'stock_transfers' AND a."after"->>'status' = 'RECEIVED' THEN 'TRANSFER.RECEIVED'
  WHEN a."entityType" = 'stock_transfers' AND a."after"->>'status' = 'CANCELLED' THEN 'TRANSFER.CANCELLED'
  -- products
  WHEN a."entityType" = 'products' AND a."action" = 'UPDATE' AND a."after" ? 'salePrice' THEN 'PRODUCT.PRICE_CHANGED'
  -- mặc định: <entityType số ít>.<CREATED|UPDATED|DELETED|STATUS_CHANGED>
  ELSE
    CASE a."entityType"
      WHEN 'goods_receipts' THEN 'GOODS_RECEIPT'
      WHEN 'supplier_payments' THEN 'SUPPLIER_PAYMENT'
      WHEN 'supplier_debt_adjustments' THEN 'SUPPLIER_DEBT'
      WHEN 'branch_products' THEN 'BRANCH_PRODUCT'
      WHEN 'price_books' THEN 'PRICE_BOOK'
      WHEN 'suppliers' THEN 'SUPPLIER'
      WHEN 'supplier_groups' THEN 'SUPPLIER_GROUP'
      WHEN 'products' THEN 'PRODUCT'
      WHEN 'stock_transfers' THEN 'TRANSFER'
      WHEN 'orders' THEN 'ORDER'
      WHEN 'users' THEN 'USER'
      ELSE upper(regexp_replace(a."entityType", 's$', ''))
    END
    || '.' ||
    CASE a."action"
      WHEN 'CREATE' THEN 'CREATED'
      WHEN 'UPDATE' THEN 'UPDATED'
      WHEN 'DELETE' THEN 'DELETED'
      ELSE 'STATUS_CHANGED'
    END
END;

-- 3. actorType: actor hệ thống (SYSTEM_ACTOR_ID) → SYSTEM, còn lại giữ DEFAULT 'USER'.
UPDATE "audit_logs" SET "actorType" = 'SYSTEM'
WHERE "actorId" = '00000000-0000-0000-0000-000000000000';

-- 4. branchIds (plan v2 Task 1 Step 3.2), ba ca.
-- 4a. Mặc định: ARRAY["branchId"] khi có branchId; còn lại mảng rỗng (không để NULL).
UPDATE "audit_logs"
SET "branchIds" = CASE WHEN "branchId" IS NOT NULL THEN ARRAY["branchId"] ELSE ARRAY[]::UUID[] END;

-- 4b. Bảng giá: lấy coalesce(after, before)->'branchIds' (jsonb → uuid[]) khi là mảng.
UPDATE "audit_logs"
SET "branchIds" = ARRAY(
  SELECT jsonb_array_elements_text(coalesce("after", "before")->'branchIds')::uuid
)
WHERE "entityType" = 'price_books'
  AND jsonb_typeof(coalesce("after", "before")->'branchIds') = 'array';

-- 4c. Điều chuyển: ARRAY[fromBranchId, toBranchId] từ stock_transfers.
UPDATE "audit_logs" AS a
SET "branchIds" = ARRAY[t."fromBranchId", t."toBranchId"]
FROM "stock_transfers" AS t
WHERE a."entityType" = 'stock_transfers' AND t."id" = a."entityId";

-- 5. metadataVersion = 0 cho mọi dòng cũ.
UPDATE "audit_logs" SET "metadataVersion" = 0;

-- 6. searchText: mã/tên suy từ before/after + lý do, đã bỏ dấu.
UPDATE "audit_logs"
SET "searchText" = vn_fold(
  coalesce("after"->>'code', "before"->>'code', "after"->>'name', "before"->>'name', '') || ' ' || coalesce("reason", '')
);

-- 7. event bắt buộc từ đây.
ALTER TABLE "audit_logs" ALTER COLUMN "event" SET NOT NULL;

-- 8. CHECK (B.5).
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_event_chk" CHECK ("event" ~ '^[A-Z_]+\.[A-Z_]+$');
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_type_chk" CHECK ("actorType" IN ('USER', 'SYSTEM', 'JOB'));
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_severity_chk" CHECK ("severity" BETWEEN 0 AND 2);
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_outcome_chk" CHECK ("outcome" IN ('SUCCESS', 'DENIED', 'FAILED'));
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_type_chk" CHECK ("type" ~ '^[A-Z_]+\.[A-Z_]+$');

-- 9. Trigger bất biến: chặn UPDATE/DELETE/TRUNCATE trừ khi transaction bật app.audit_maintenance = 'on'
--    (SELECT set_config('app.audit_maintenance', 'on', true) — xem withAuditMaintenance trong test-support).
CREATE OR REPLACE FUNCTION audit_block_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.audit_maintenance', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'audit log is append-only' USING ERRCODE = 'P0001';
  END IF;
  RETURN COALESCE(OLD, NEW);
END;
$$;

CREATE TRIGGER "audit_logs_block_mutation"
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION audit_block_mutation();
CREATE TRIGGER "audit_logs_block_truncate"
  BEFORE TRUNCATE ON "audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_block_mutation();

CREATE TRIGGER "security_events_block_mutation"
  BEFORE UPDATE OR DELETE ON "security_events"
  FOR EACH ROW EXECUTE FUNCTION audit_block_mutation();
CREATE TRIGGER "security_events_block_truncate"
  BEFORE TRUNCATE ON "security_events"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_block_mutation();
