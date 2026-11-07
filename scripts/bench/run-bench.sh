#!/usr/bin/env bash
# Chạy pgbench cho từng kịch bản trên DB audit_bench trong container, in p50/p95/p99 (ms) từ log từng giao dịch.
# Dùng: scripts/bench/run-bench.sh [giây mỗi kịch bản, mặc định 60]
set -euo pipefail
C=${CONTAINER:-postgres-docker-db-1}
T=${1:-60}
DIR=$(cd "$(dirname "$0")" && pwd)
docker exec "$C" rm -rf /tmp/bench && docker exec "$C" mkdir -p /tmp/bench/log
docker cp "$DIR/." "$C:/tmp/bench/"
printf '%-24s %8s %8s %8s %8s\n' scenario tps p50_ms p95_ms p99_ms
for f in ${SCENARIOS:-admin-list pm-big pm-small cursor-p50 cursor-p50-pm entity-history event-severity \
         search-common search-common-pm search-common-pm-small search-rare search-rare-phrase}; do
  out=$(docker exec "$C" sh -c "cd /tmp/bench/log && rm -f $f.* && pgbench -n -U postgres -c 10 -j 2 -T $T -l --log-prefix=$f -f /tmp/bench/$f.sql audit_bench")
  tps=$(echo "$out" | sed -n 's/^tps = \([0-9.]*\).*/\1/p' | head -1)
  stats=$(docker exec "$C" sh -c "cat /tmp/bench/log/$f.* | awk '{print \$3/1000}' | sort -n" | awk '{a[NR]=$1} END {printf "%.2f %.2f %.2f", a[int(NR*0.50)], a[int(NR*0.95)], a[int(NR*0.99)]}')
  set -- $stats
  printf '%-24s %8s %8s %8s %8s\n' "$f" "$tps" "$1" "$2" "$3"
done
