#!/usr/bin/env bash
# Đo GET /reports/sales (có giá vốn, topBy=revenue|grossProfit; thêm bản cũ để so sánh) trên DB riêng sales_bench trong container, in p50/p95/p99 (ms) mỗi giao dịch (3 truy vấn).
# Dùng: scripts/bench/run-sales-report-bench.sh [giây mỗi kịch bản, mặc định 30]
# Cần DB sales_bench đã áp migration + chạy sales-report-bench-setup.sql (xem file đó).
set -euo pipefail
C=${CONTAINER:-postgres-docker-db-1}
T=${1:-30}
DIR=$(cd "$(dirname "$0")" && pwd)
docker exec "$C" rm -rf /tmp/bench && docker exec "$C" mkdir -p /tmp/bench/log
# Sinh hai biến thể thứ tự top: doanh thu (cũ) và lãi gộp (giống SalesReportRepository).
REV_IN='SUM(s."revenue") DESC, SUM(s."qtyBase") DESC, s."productId"'; REV_OUT='t."revenue" DESC, t."qtyBase" DESC, p."id"'
GP_IN='SUM(s."revenue") - SUM(s."cogsAmount") DESC, SUM(s."revenue") DESC, s."productId"'; GP_OUT='t."revenue" - t."cogs" DESC, t."revenue" DESC, p."id"'
TMP=$(mktemp -d)
sed -e "s/:inner/$REV_IN/" -e "s/:outer/$REV_OUT/" "$DIR/sales-report-bench.sql" > "$TMP/rev.sql"
sed -e "s/:inner/$GP_IN/" -e "s/:outer/$GP_OUT/" "$DIR/sales-report-bench.sql" > "$TMP/gp.sql"
cp "$DIR/sales-report-bench-old.sql" "$TMP/old.sql"
docker cp "$TMP/rev.sql" "$C:/tmp/bench/"; docker cp "$TMP/gp.sql" "$C:/tmp/bench/"; docker cp "$TMP/old.sql" "$C:/tmp/bench/"
rm -rf "$TMP"
printf '%-24s %8s %8s %8s %8s\n' scenario tps p50_ms p95_ms p99_ms
run() { # tên, days, one, file (rev|gp|old)
  out=$(docker exec "$C" sh -c "cd /tmp/bench/log && rm -f $1.* && pgbench -n -U postgres -c 10 -j 2 -T $T -l --log-prefix=$1 -D days=$2 -D one=$3 -f /tmp/bench/$4.sql sales_bench")
  tps=$(echo "$out" | sed -n 's/^tps = \([0-9.]*\).*/\1/p' | head -1)
  stats=$(docker exec "$C" sh -c "cat /tmp/bench/log/$1.* | awk '{print \$3/1000}' | sort -n" | awk '{a[NR]=$1} END {printf "%.2f %.2f %.2f", a[int(NR*0.50)], a[int(NR*0.95)], a[int(NR*0.99)]}')
  set -- "$1" $stats
  printf '%-24s %8s %8s %8s %8s\n' "$1" "$tps" "$2" "$3" "$4"
}
for f in old rev gp; do
  run "$f-1cn-30ngay" 29 1 $f
  run "$f-chuoi-30ngay" 29 0 $f
  run "$f-chuoi-90ngay" 89 0 $f
  run "$f-chuoi-366ngay" 365 0 $f
done
