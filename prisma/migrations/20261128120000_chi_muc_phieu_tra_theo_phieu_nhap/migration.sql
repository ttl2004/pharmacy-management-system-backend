-- Tra phiếu trả NCC theo phiếu nhập gốc (nợ thật của phiếu nhập = tổng − trả hàng). CHỈ thêm index — không sửa dữ liệu.
-- Một phần (partial): phần lớn phiếu điều chỉnh không gắn phiếu nhập. Tên theo quy ước Prisma của @@index([goodsReceiptId]).
CREATE INDEX IF NOT EXISTS "stock_adjustments_goodsReceiptId_idx" ON "stock_adjustments" ("goodsReceiptId") WHERE "goodsReceiptId" IS NOT NULL;
