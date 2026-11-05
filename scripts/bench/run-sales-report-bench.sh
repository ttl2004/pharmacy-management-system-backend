#!/usr/bin/env bash
# Đo GET /reports/sales trên DB riêng sales_bench trong container, in p50/p95/p99 (ms) mỗi giao dịch (3 truy vấn).
# Dùng: scripts/bench/run-sales-report-bench.sh [giây mỗi kịch bản, mặc định 30]
# Cần DB sales_bench đã áp migration + chạy sales-report-bench-setup.sql (xem file đó).
set -euo pipefail
C=${CONTAINER:-postgres-docker-db-1}
T=${1:-30}
DIR=$(cd "$(dirname "$0")" && pwd)
docker exec "$C" rm -rf /tmp/bench && docker exec "$C" mkdir -p /tmp/bench/log
docker cp "$DIR/sales-report-bench.sql" "$C:/tmp/bench/"
printf '%-22s %8s %8s %8s %8s\n' scenario tps p50_ms p95_ms p99_ms
run() { # tên, days, one
  out=$(docker exec "$C" sh -c "cd /tmp/bench/log && rm -f $1.* && pgbench -n -U postgres -c 10 -j 2 -T $T -l --log-prefix=$1 -D days=$2 -D one=$3 -f /tmp/bench/sales-report-bench.sql sales_bench")
  tps=$(echo "$out" | sed -n 's/^tps = \([0-9.]*\).*/\1/p' | head -1)
  stats=$(docker exec "$C" sh -c "cat /tmp/bench/log/$1.* | awk '{print \$3/1000}' | sort -n" | awk '{a[NR]=$1} END {printf "%.2f %.2f %.2f", a[int(NR*0.50)], a[int(NR*0.95)], a[int(NR*0.99)]}')
  set -- "$1" $stats
  printf '%-22s %8s %8s %8s %8s\n' "$1" "$tps" "$2" "$3" "$4"
}
run 1cn-30ngay 29 1
run chuoi-90ngay 89 0
run chuoi-366ngay 365 0
