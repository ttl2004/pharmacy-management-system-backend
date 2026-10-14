import { Prisma } from '@prisma/client';

/**
 * Khoá advisory của Postgres theo chuỗi khoá, giữ tới hết transaction (`pg_advisory_xact_lock`). Dùng khi cần cho
 * các transaction chạy nối tiếp theo một khái niệm không có sẵn dòng để khoá `FOR UPDATE` (vd. một bản ghi chưa được
 * tạo). Khoá nằm trong DB nên vẫn đúng khi chạy nhiều instance.
 *
 * Chờ khoá diễn ra BÊN TRONG transaction: thời gian chờ tính vào `timeout` của transaction và giữ một kết nối của
 * pool — chỉ khoá hẹp, quanh những đoạn ngắn.
 *
 * Nhiều khoá được lấy theo thứ tự giá trị băm, để hai transaction cùng giữ nhiều khoá không chờ nhau thành deadlock.
 * Hai khoá khác nhau trùng băm (64 bit) thì thành một khoá — chỉ làm chờ thừa, không sai dữ liệu.
 */
export async function lockAdvisoryKeys(tx: Prisma.TransactionClient, keys: readonly string[]): Promise<void> {
  if (!keys.length) return;
  // `$executeRaw` vì hàm trả về `void` — `$queryRaw` không đọc được cột kiểu này.
  await tx.$executeRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(h."hash")
    FROM (SELECT DISTINCT hashtextextended(k, 0) AS "hash" FROM unnest(${[...keys]}::text[]) AS k) AS h
    ORDER BY h."hash"`);
}
