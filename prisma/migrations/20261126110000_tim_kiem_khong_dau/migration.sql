-- Viết tay: tìm kiếm hàng hoá KHÔNG phân biệt dấu tiếng Việt (gõ "khau trang" thấy "Khẩu trang").
-- `unaccent` (contrib, có sẵn trên Supabase) nhanh hơn `vn_fold` (translate + regexp) khoảng 6 lần khi quét bảng
-- hàng hoá. Bản gốc `unaccent(text)` chỉ STABLE (phụ thuộc search_path để tìm từ điển) → bọc bằng hàm IMMUTABLE ghi rõ
-- schema của hàm lẫn từ điển, để chạy được cả khi search_path chỉ có schema riêng (vd schema test) và dùng được trong
-- index biểu thức sau này.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions;

CREATE OR REPLACE FUNCTION f_unaccent(input text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT extensions.unaccent('extensions.unaccent'::regdictionary, input)
$$;
