-- Dữ liệu cho bench báo cáo doanh thu: 10 chi nhánh, 800 sản phẩm, 366 ngày (đến 2026-11-05), kênh POS.
-- Mỗi (chi nhánh, ngày) có đủ 800 dòng sales_daily_product (cận trên của "~800 SP bán/ngày/CN").
-- Chạy trên DB riêng đã áp migration: psql -U postgres -d sales_bench -f sales-report-bench-setup.sql
INSERT INTO units (id, code, name, "createdAt", "updatedAt") VALUES (md5('unit')::uuid, 'VIEN', 'Viên', now(), now());
INSERT INTO categories (id, name, "createdAt") VALUES (md5('cat')::uuid, 'Thuốc', now());
INSERT INTO branches (id, code, name, phone, address)
SELECT md5('branch' || i)::uuid, 'CN' || lpad(i::text, 2, '0'), 'Chi nhánh ' || i, '090000' || lpad(i::text, 4, '0'), 'Hà Nội'
FROM generate_series(1, 10) i;
INSERT INTO products (id, code, name, "categoryId", "baseUnitId", type)
SELECT md5('product' || i)::uuid, 'SP' || lpad(i::text, 5, '0'), 'Sản phẩm ' || i, md5('cat')::uuid, md5('unit')::uuid, 'GOODS'
FROM generate_series(1, 800) i;

INSERT INTO sales_daily ("branchId", "date", channel, "orderCount", revenue)
SELECT md5('branch' || b)::uuid, d::date, 'POS', 150 + (random() * 100)::int, 40000000 + (random() * 20000000)::bigint
FROM generate_series(1, 10) b, generate_series(date '2025-11-05', date '2026-11-05', interval '1 day') d;

INSERT INTO sales_daily_product ("branchId", "date", channel, "productId", "qtyBase", revenue, "cogsAmount")
SELECT md5('branch' || b)::uuid, d::date, 'POS', md5('product' || p)::uuid,
       1 + (random() * 30)::int, 10000 + (random() * 500000)::bigint, 5000 + (random() * 250000)::bigint
FROM generate_series(1, 10) b, generate_series(date '2025-11-05', date '2026-11-05', interval '1 day') d, generate_series(1, 800) p;

-- Bảng chuỗi (gộp mọi chi nhánh) dựng từ bảng theo chi nhánh.
INSERT INTO sales_daily_product_chain ("date", channel, "productId", "qtyBase", revenue, "cogsAmount")
SELECT "date", channel, "productId", SUM("qtyBase"), SUM(revenue), SUM("cogsAmount") FROM sales_daily_product GROUP BY 1, 2, 3;

-- ~300 nghìn đơn đã thu rải trong 1 năm, để đo `rebuild` (EXPLAIN theo chỉ mục completedAt).
INSERT INTO orders (id, code, "branchId", channel, status, "paymentStatus", "totalAmount", "subtotalAmount", "completedAt")
SELECT md5('order' || i)::uuid, 'BD' || lpad(i::text, 7, '0'), md5('branch' || (1 + i % 10))::uuid, 'POS', 'COMPLETED', 'PAID', 100000, 100000,
       timestamptz '2026-11-05 23:00+07' - (random() * 366) * interval '1 day'
FROM generate_series(1, 300000) i;

VACUUM ANALYZE;
