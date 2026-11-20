-- Migration kiem_soat_theo_danh_muc_thuoc (D3): thuốc có phân loại kiểm soát (controlType) trong danh mục quốc gia
-- thì hàng hoá liên kết với nó luôn là thuốc kiểm soát. Dữ liệu cũ: chỉ BẬT cờ cho hàng chưa xoá đang trỏ tới
-- thuốc như vậy mà cờ còn tắt. Không bao giờ tắt cờ nào (an toàn, chạy lại được).
UPDATE "products" p
SET "isControlled" = true
FROM "drugs" d
WHERE p."drugId" = d."id"
  AND p."isDeleted" = false
  AND p."isControlled" = false
  AND COALESCE(TRIM(d."controlType"), '') <> '';
