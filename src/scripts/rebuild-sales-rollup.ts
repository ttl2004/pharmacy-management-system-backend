import { PrismaClient } from '@prisma/client';
import { addDaysToDateOnly, isValidDateOnly, todayInVietnam } from 'src/common/utils/date-only.util';
import { SalesRollupRepository } from 'src/modules/feature-report/sales-rollup.repository';

/*
 * report:rebuild — dựng lại bảng tổng hợp doanh thu (`sales_daily`, `sales_daily_product`) từ đơn hàng.
 * Dùng: npm run report:rebuild [-- --from YYYY-MM-DD --to YYYY-MM-DD]
 * Mặc định: từ ngày thu đơn đầu tiên tới hôm nay (giờ VN). Mỗi tháng một transaction; chạy lại an toàn.
 */

function argOf(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requireDate(name: string, value: string | undefined): string | undefined {
  if (value !== undefined && !isValidDateOnly(value)) throw new Error(`--${name} phải là YYYY-MM-DD, nhận: ${value}`);
  return value;
}

/** Chia [from, to] thành các đoạn theo tháng dương lịch. */
export function monthChunks(from: string, to: string): [string, string][] {
  const chunks: [string, string][] = [];
  let cursor = from;
  while (cursor <= to) {
    const [y, m] = cursor.split('-').map(Number);
    const lastOfMonth = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const end = lastOfMonth < to ? lastOfMonth : to;
    chunks.push([cursor, end]);
    cursor = addDaysToDateOnly(end, 1);
  }
  return chunks;
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const repo = new SalesRollupRepository();
  try {
    const to = requireDate('to', argOf('to')) ?? todayInVietnam();
    let from = requireDate('from', argOf('from'));
    if (!from) {
      const [row] = await prisma.$queryRaw<{ first: string | null }[]>`
        SELECT to_char(min("completedAt") AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') AS "first"
        FROM orders WHERE "completedAt" IS NOT NULL`;
      from = row?.first ?? to;
    }
    if (from > to) throw new Error(`--from (${from}) sau --to (${to})`);

    let rows = 0;
    for (const [start, end] of monthChunks(from, to)) {
      const result = await prisma.$transaction((tx) => repo.rebuild(tx, start, end), { timeout: 10 * 60_000 });
      rows += result.rows;
      console.log(`${start} → ${end}: ${result.days} ngày, ${result.rows} dòng`);
    }
    console.log(`Xong: ${from} → ${to}, tổng ${rows} dòng`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
