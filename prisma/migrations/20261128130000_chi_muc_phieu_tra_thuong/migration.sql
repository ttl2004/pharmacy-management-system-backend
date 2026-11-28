-- Đổi index một phần của migration trước thành index thường khớp @@index([goodsReceiptId]) (schema cấm partial index, tránh drift).
-- Chỉ đổi index — không sửa dữ liệu.
DROP INDEX IF EXISTS "stock_adjustments_goodsReceiptId_idx";
CREATE INDEX "stock_adjustments_goodsReceiptId_idx" ON "stock_adjustments"("goodsReceiptId");
