-- Chuẩn hoá hãng sản xuất: khoá tên để tìm-hoặc-tạo nguyên tử, sequence sinh mã NSX0001…, quốc gia chuẩn.
-- Không xoá/gộp hãng trùng (để sau).

-- 1. Khoá tên đã chuẩn hoá. KHÔNG unique: dữ liệu cũ có thể đã trùng tên biến thể; service chống tạo trùng
--    bằng pg_advisory_xact_lock(hashtext(nameKey)). Index thường để tra cứu nhanh.
--    Giá trị được tính bằng hàm TypeScript `normalizeManufacturerName` (bỏ dấu, bỏ cụm pháp nhân, I→1…),
--    không biểu diễn chắc chắn bằng SQL → để NULL ở đây; service tự điền các dòng NULL ngay trong transaction
--    resolve/tạo/sửa, và `npm run backfill:manufacturer` tính lại toàn bộ (idempotent).
ALTER TABLE "manufacturers" ADD COLUMN "nameKey" VARCHAR(200);
CREATE INDEX "manufacturers_nameKey_idx" ON "manufacturers"("nameKey");

-- 2. Sequence sinh mã tự động. Bắt đầu sau số lớn nhất của các mã dạng NSX<số> đã có (kể cả bản ghi xoá mềm,
--    vì code unique trên toàn bảng) để mã sinh ra không đụng mã nhập tay như "NSX0005".
CREATE SEQUENCE "manufacturer_code_seq";

WITH existing AS (
  SELECT COALESCE(MAX(substring("code" FROM '^NSX([0-9]{1,15})$')::bigint), 0) AS max_no
  FROM "manufacturers"
  WHERE "code" ~ '^NSX[0-9]{1,15}$'
),
pending AS (
  SELECT "id", ROW_NUMBER() OVER (ORDER BY "createdAt", "id") AS rn
  FROM "manufacturers"
  WHERE "code" IS NULL
)
UPDATE "manufacturers" m
SET "code" = 'NSX' || lpad((e.max_no + p.rn)::text, GREATEST(4, length((e.max_no + p.rn)::text)), '0')
FROM pending p, existing e
WHERE m."id" = p."id";

-- Đặt sequence = số lớn nhất hiện có (sau khi sinh mã ở trên); bảng rỗng thì nextval đầu tiên ra 1.
SELECT setval('"manufacturer_code_seq"', GREATEST(s.max_no, 1), s.max_no > 0)
FROM (
  SELECT COALESCE(MAX(substring("code" FROM '^NSX([0-9]{1,15})$')::bigint), 0) AS max_no
  FROM "manufacturers"
  WHERE "code" ~ '^NSX[0-9]{1,15}$'
) s;

-- 3. Quốc gia: đưa các bí danh phổ biến về tên chuẩn tiếng Việt (bảng đầy đủ ở `canonicalCountry`,
--    script backfill áp phần còn lại). Chuỗi rỗng → NULL.
UPDATE "manufacturers" SET "country" = NULL WHERE "country" IS NOT NULL AND btrim("country") = '';

UPDATE "manufacturers"
SET "country" = CASE lower(btrim("country"))
    WHEN 'vn' THEN 'Việt Nam'
    WHEN 'viet nam' THEN 'Việt Nam'
    WHEN 'vietnam' THEN 'Việt Nam'
    WHEN 'việt nam' THEN 'Việt Nam'
    WHEN 'us' THEN 'Mỹ'
    WHEN 'usa' THEN 'Mỹ'
    WHEN 'united states' THEN 'Mỹ'
    WHEN 'hoa kỳ' THEN 'Mỹ'
    WHEN 'hoa ky' THEN 'Mỹ'
    WHEN 'uk' THEN 'Anh'
    WHEN 'england' THEN 'Anh'
    WHEN 'united kingdom' THEN 'Anh'
    WHEN 'india' THEN 'Ấn Độ'
    WHEN 'china' THEN 'Trung Quốc'
    WHEN 'korea' THEN 'Hàn Quốc'
    WHEN 'south korea' THEN 'Hàn Quốc'
    WHEN 'japan' THEN 'Nhật Bản'
    WHEN 'france' THEN 'Pháp'
    WHEN 'germany' THEN 'Đức'
    WHEN 'italy' THEN 'Ý'
    WHEN 'spain' THEN 'Tây Ban Nha'
    WHEN 'switzerland' THEN 'Thuỵ Sĩ'
    WHEN 'thụy sĩ' THEN 'Thuỵ Sĩ'
    WHEN 'belgium' THEN 'Bỉ'
    WHEN 'netherlands' THEN 'Hà Lan'
    WHEN 'austria' THEN 'Áo'
    WHEN 'poland' THEN 'Ba Lan'
    WHEN 'thailand' THEN 'Thái Lan'
    WHEN 'australia' THEN 'Úc'
    WHEN 'turkey' THEN 'Thổ Nhĩ Kỳ'
    WHEN 'taiwan' THEN 'Đài Loan'
    WHEN 'russia' THEN 'Nga'
    ELSE btrim("country")
  END
WHERE "country" IS NOT NULL;
