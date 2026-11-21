-- Viết tay — Prisma không khai được CHECK nhưng cũng không xoá nó ở migration sau.
-- Ràng buộc đơn vị bán (D11): quy đổi >= 1, giá bán >= 0, đơn vị cơ bản luôn quy đổi = 1.
-- NOT VALID: không quét dữ liệu cũ nên deploy không lỗi nếu có dòng sai từ trước; dòng thêm/sửa từ giờ đều bị kiểm.
-- Dọn dữ liệu cũ xong có thể chạy `ALTER TABLE "product_units" VALIDATE CONSTRAINT <tên>` để hợp lệ hoá.
ALTER TABLE "product_units"
  ADD CONSTRAINT "product_units_rate_chk" CHECK ("conversionRate" >= 1) NOT VALID,
  ADD CONSTRAINT "product_units_price_chk" CHECK ("salePrice" >= 0) NOT VALID,
  ADD CONSTRAINT "product_units_base_rate_chk" CHECK (NOT "isBaseUnit" OR "conversionRate" = 1) NOT VALID;
