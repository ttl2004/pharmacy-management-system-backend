-- Mã hàng (thuốc + hàng hoá, cùng bảng "products") do hệ thống tự sinh: `SP` + số từ sequence, như mã chứng từ kho.
-- CHỈ thêm sequence — không sửa dòng nào. Prisma không khai được SEQUENCE nhưng cũng không xoá nó ở migration sau.
CREATE SEQUENCE IF NOT EXISTS "product_code_seq";

-- Bắt đầu sau số lớn nhất của các mã dạng SP<số> đã có (kể cả bản ghi xoá mềm, vì code unique trên toàn bảng) để
-- mã sinh ra không đụng mã nhập tay như "SP0010". Giới hạn 15 chữ số cho vừa bigint; mã dài hơn không thể trùng.
-- is_called = (max_no > 0): có mã → nextval kế tiếp = max_no + 1; bảng chưa có mã SP → nextval đầu tiên ra 1.
SELECT setval('"product_code_seq"', GREATEST(s.max_no, 1), s.max_no > 0)
FROM (
  SELECT COALESCE(MAX(substring("code" FROM '^SP([0-9]{1,15})$')::bigint), 0) AS max_no
  FROM "products"
  WHERE "code" ~ '^SP[0-9]{1,15}$'
) s;
