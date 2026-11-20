-- Xoá mềm giờ nhả mã vạch (mã vạch gắn với hàng thật, hàng mới được dùng lại). Dữ liệu cũ: hàng/đơn vị đã xoá mềm
-- trước đây vẫn giữ mã vạch và chặn tạo mới (1601) — đặt về NULL. Chỉ sửa dữ liệu, không đổi cấu trúc.
UPDATE "products" SET "barcode" = NULL WHERE "isDeleted" = true AND "barcode" IS NOT NULL;
UPDATE "product_units" SET "barcode" = NULL WHERE "isDeleted" = true AND "barcode" IS NOT NULL;

-- Nhân viên đã xoá mềm trước đây: nhả SĐT/email (để NULL) và đổi username thành `<gốc>_DEL_<6 ký tự>` như lúc xoá mới,
-- để khôi phục (bỏ hậu tố) vẫn lấy lại được username gốc.
UPDATE "users" SET "phoneNumber" = NULL, "email" = NULL
WHERE "isDeleted" = true AND ("phoneNumber" IS NOT NULL OR "email" IS NOT NULL);
UPDATE "auths" a SET "username" = LEFT(a."username", 38) || '_DEL_' || SUBSTR(MD5(a."id"::text), 1, 6)
FROM "users" u
WHERE u."id" = a."userId" AND u."isDeleted" = true AND a."username" !~ '_DEL_[0-9a-z]{6}$';
