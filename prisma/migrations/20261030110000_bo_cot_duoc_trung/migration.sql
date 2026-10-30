-- Hoạt chất, hàm lượng, số đăng ký, nước sản xuất, mã DQG là thông tin của THUỐC: đọc qua products."drugId" -> drugs,
-- không lưu trùng trên hàng hoá (chốt 2026-10-30, cách A — dữ liệu dev là seed, seed đã gắn drugId trước migration này).
ALTER TABLE "products" DROP COLUMN "activeIngredient",
DROP COLUMN "strength",
DROP COLUMN "registrationNumber",
DROP COLUMN "countryOfOrigin",
DROP COLUMN "nationalDrugCode";

-- Viết tay — Prisma không khai được CHECK nhưng cũng không xoá nó ở migration sau.
-- Hàng DRUG chưa xoá bắt buộc trỏ tới thuốc; hàng GOODS không trỏ. Hàng đã xoá là lịch sử nên được miễn.
-- Còn hàng DRUG chưa xoá thiếu drugId thì câu lệnh lỗi ngay, không âm thầm bỏ qua.
ALTER TABLE "products"
  ADD CONSTRAINT "products_drug_link_chk" CHECK ("isDeleted" OR (("type" = 'DRUG') = ("drugId" IS NOT NULL)));
