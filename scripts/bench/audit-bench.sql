-- Dựng dữ liệu đo hiệu năng nhật ký v2.1: 2.000.000 dòng, 7 chi nhánh.
-- Chạy trên DB RIÊNG đã `prisma migrate deploy` (không bao giờ appdb):
--   docker exec postgres-docker-db-1 createdb -U postgres audit_bench
--   DATABASE_URL=postgresql://.../audit_bench npx prisma migrate deploy
--   docker cp scripts/bench/. postgres-docker-db-1:/tmp/bench/
--   docker exec postgres-docker-db-1 psql -U postgres -d audit_bench -f /tmp/bench/audit-bench.sql
--   (đo: scripts/bench/run-bench.sh; xong: dropdb audit_bench)
--
-- Phân bố:
--   * chi nhánh 1..7 chiếm 40/25/15/10/5/4/1 % số dòng có chi nhánh; 5% dòng toàn chuỗi (branchIds = '{}'),
--     3% dòng áp 2 chi nhánh. Id chi nhánh = md5('branch'||n)::uuid.
--   * event lệch (ORDER.CREATED 40% ... ORDER.VOID_PAID 0,5%); severity 1 ~5,5%, severity 2 0,5%.
--   * 5% dòng có reason (30% trong số đó là 'huỷ hàng hỏng' → từ khoá phổ biến);
--     nhãn 'DH<i>' duy nhất → từ khoá hiếm. searchText = vn_fold(entityLabel || ' ' || reason).
--   * 200.000 entityId phân biệt (md5('e'||n)::uuid), ~10 dòng mỗi đối tượng.
--   * createdAt rải đều 365 ngày gần nhất, id = uuidv7 theo createdAt.
-- INSERT không bị trigger chặn (trigger chỉ chặn UPDATE/DELETE/TRUNCATE).

\set ON_ERROR_STOP on
\timing on

INSERT INTO roles (id, code, name, level) VALUES (md5('role')::uuid, 'BENCH', 'Bench', 1) ON CONFLICT DO NOTHING;
INSERT INTO users (id, "fullName", "roleId") VALUES (md5('actor')::uuid, 'Bench actor', md5('role')::uuid) ON CONFLICT DO NOTHING;
INSERT INTO branches (id, code, name, phone, address)
SELECT md5('branch' || n)::uuid, 'B' || n, 'Chi nhánh ' || n, '09000000' || n, 'HN' FROM generate_series(1, 7) n
ON CONFLICT DO NOTHING;

CREATE OR REPLACE PROCEDURE bench_seed(total int, chunk int) LANGUAGE plpgsql AS $$
DECLARE lo int := 1;
BEGIN
  WHILE lo <= total LOOP
    INSERT INTO audit_logs (id, "createdAt", "actorId", action, event, "actorType", "actorRoleCode", "entityType", "entityId",
                            "entityLabel", "branchId", "branchIds", severity, amount, before, after, metadata, reason,
                            "searchText")
    SELECT
      uuidv7(t.ts - now()), t.ts, md5('actor')::uuid, 'UPDATE', t.event, 'USER', 'PHARMACY_MANAGER', 'orders',
      md5('e' || (1 + (t.i % 200000)))::uuid, t.label,
      CASE WHEN cardinality(t.bids) = 1 THEN t.bids[1] END, t.bids, t.sev,
      CASE WHEN t.event LIKE 'ORDER.%' THEN (t.r2 * 5000000)::bigint END,
      CASE WHEN t.r2 > 0.80 THEN jsonb_build_object('status', 'DRAFT', 'note', md5(t.i::text)) END,
      CASE WHEN t.r2 > 0.80 THEN jsonb_build_object('status', 'CONFIRMED', 'note', md5((t.i + 1)::text)) END,
      CASE WHEN t.r3 < 0.5 THEN jsonb_build_object('source', 'pos', 'terminal', t.i % 20) END,
      t.reason,
      vn_fold(t.label || ' ' || coalesce(t.reason, ''))
    FROM (
      SELECT s.i, s.r2, s.r3,
        now() - (total - s.i) * (interval '365 days' / total) AS ts,
        'DH' || s.i AS label,
        CASE WHEN s.r2 < 0.40 THEN 'ORDER.CREATED' WHEN s.r2 < 0.60 THEN 'ORDER.PAID'
             WHEN s.r2 < 0.72 THEN 'GOODS_RECEIPT.CONFIRMED' WHEN s.r2 < 0.80 THEN 'PRODUCT.UPDATED'
             WHEN s.r2 < 0.86 THEN 'PRICE_BOOK.UPDATED' WHEN s.r2 < 0.94 THEN 'BATCH.STATUS_CHANGED'
             WHEN s.r2 < 0.985 THEN 'STOCK_ADJUSTMENT.APPROVED' WHEN s.r2 < 0.995 THEN 'PAYMENT.REFUNDED'
             ELSE 'ORDER.VOID_PAID' END AS event,
        CASE WHEN s.r2 >= 0.995 THEN 2 WHEN s.r2 >= 0.94 THEN 1 ELSE 0 END AS sev,
        CASE WHEN s.r3 < 0.05 OR s.r2 >= 0.995 THEN
          (ARRAY['huỷ hàng hỏng','huỷ hàng hỏng','huỷ hàng hỏng','huỷ hàng hỏng','huỷ hàng hỏng','huỷ hàng hỏng',
                 'khách trả hàng','khách đổi ý','nhập sai số lượng','kiểm kê chênh lệch','hết hạn sử dụng','vỡ khi vận chuyển',
                 'sai giá niêm yết','điều chỉnh theo yêu cầu quản lý','nhầm lẫn khi bán','thuốc bị thu hồi','lỗi máy POS',
                 'khách không thanh toán','đổi lô theo hạn dùng','bù hàng cho khách'])[1 + (s.i % 20)]
          || CASE WHEN s.i % 5000 = 0 THEN ' sai lệch kiểm kê quý IV' ELSE '' END
        END AS reason,
        CASE
          WHEN s.r1 < 0.05 THEN ARRAY[]::uuid[]
          WHEN s.r1 < 0.08 THEN ARRAY[md5('branch' || s.b)::uuid, md5('branch' || (1 + s.b % 7))::uuid]
          ELSE ARRAY[md5('branch' || s.b)::uuid]
        END AS bids
      FROM (
        SELECT base.*,
          CASE WHEN r4 < 0.40 THEN 1 WHEN r4 < 0.65 THEN 2 WHEN r4 < 0.80 THEN 3 WHEN r4 < 0.90 THEN 4
               WHEN r4 < 0.95 THEN 5 WHEN r4 < 0.99 THEN 6 ELSE 7 END AS b
        FROM (SELECT g AS i, random() AS r1, random() AS r2, random() AS r3, random() AS r4
              FROM generate_series(lo, least(lo + chunk - 1, total)) g OFFSET 0) base
      ) s
    ) t;
    COMMIT;
    lo := lo + chunk;
  END LOOP;
END $$;

CALL bench_seed(2000000, 250000);
DROP PROCEDURE bench_seed(int, int);

VACUUM (ANALYZE) audit_logs;
SELECT count(*) AS rows, pg_size_pretty(pg_total_relation_size('audit_logs')) AS total_size FROM audit_logs;
