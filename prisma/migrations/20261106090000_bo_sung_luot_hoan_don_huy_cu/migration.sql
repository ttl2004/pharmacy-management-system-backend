-- Bổ sung lượt hoàn (payments.kind = 'REFUND') cho hoá đơn đã thu rồi huỷ TRƯỚC khi có `payments.kind`.
-- Khi đó huỷ hoá đơn luôn hoàn đủ tiền nhưng không ghi dòng hoàn, nên báo cáo doanh thu (thu - hoàn đã ghi) tính thừa.
-- Chỉ thêm dữ liệu, không đổi cấu trúc; chạy lại không thêm gì (NOT EXISTS). Không đụng audit_logs/security_events.
INSERT INTO "payments" ("id", "orderId", "kind", "method", "amount", "status", "paidAt", "createdAt", "createdBy", "note")
SELECT gen_random_uuid(),
       o."id",
       'REFUND',
       (SELECT p."method" FROM "payments" p
         WHERE p."orderId" = o."id" AND p."kind" = 'PAYMENT' AND p."status" = 'SUCCESS'
         ORDER BY p."paidAt" DESC NULLS LAST, p."createdAt" DESC LIMIT 1),
       paid."amount",
       'SUCCESS',
       COALESCE(o."cancelledAt", o."updatedAt", o."createdAt"),
       COALESCE(o."cancelledAt", o."updatedAt", o."createdAt"),
       o."updatedBy",
       'Bổ sung lượt hoàn cho đơn huỷ trước v2.1'
FROM "orders" o
CROSS JOIN LATERAL (
  SELECT COALESCE(SUM(p."amount"), 0) AS "amount" FROM "payments" p
  WHERE p."orderId" = o."id" AND p."kind" = 'PAYMENT' AND p."status" = 'SUCCESS'
) paid
WHERE o."status" = 'CANCELLED'
  AND o."paymentStatus" = 'REFUNDED'
  AND paid."amount" > 0
  AND NOT EXISTS (SELECT 1 FROM "payments" r WHERE r."orderId" = o."id" AND r."kind" = 'REFUND');
