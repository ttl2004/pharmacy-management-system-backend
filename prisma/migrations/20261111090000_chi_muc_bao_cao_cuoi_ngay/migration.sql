-- Báo cáo cuối ngày lọc theo ngày thu tiền / ngày huỷ đơn: trước đây quét cả bảng.
CREATE INDEX IF NOT EXISTS "payments_paidAt_idx" ON "payments"("paidAt");
CREATE INDEX IF NOT EXISTS "orders_cancelledAt_idx" ON "orders"("cancelledAt");
