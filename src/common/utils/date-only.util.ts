/**
 * Ngày không giờ (`@db.Date`: hạn dùng, ngày sản xuất, ngày hoá đơn) và "hôm nay" theo giờ Việt Nam.
 *
 * Prisma đọc/ghi cột `date` dưới dạng `Date` ở **00:00 UTC**. Máy chủ chạy UTC, nên `new Date()` lúc 06:00 sáng
 * giờ VN vẫn là ngày hôm trước — so hạn dùng bằng `new Date()` sẽ coi lô hết hạn "hôm nay" là còn hạn suốt
 * 7 tiếng đầu ngày. Mọi so sánh hạn dùng phải đi qua các hàm ở đây, làm việc trên chuỗi `YYYY-MM-DD`.
 */

const VIETNAM_TIME_ZONE = 'Asia/Ho_Chi_Minh';
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** Định dạng `en-CA` cho ra đúng `YYYY-MM-DD`. */
const vietnamDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: VIETNAM_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Ngày hôm nay theo giờ Việt Nam, dạng `YYYY-MM-DD`. Nhận `now` để test cố định được thời điểm. */
export function todayInVietnam(now: Date = new Date()): string {
  return vietnamDateFormatter.format(now);
}

/** `true` nếu là chuỗi `YYYY-MM-DD` và là ngày có thật (chặn `2026-02-30`). */
export function isValidDateOnly(value: string): boolean {
  if (!DATE_ONLY_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** `YYYY-MM-DD` → `Date` 00:00 UTC — đúng dạng Prisma cần để ghi cột `@db.Date`. */
export function parseDateOnly(value: string): Date {
  if (!isValidDateOnly(value)) throw new Error(`Ngày không hợp lệ: ${value}`);
  return new Date(`${value}T00:00:00.000Z`);
}

/** `Date` đọc từ cột `@db.Date` → `YYYY-MM-DD`. Lấy theo UTC vì Prisma trả 00:00 UTC. */
export function toDateOnlyString(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** Cộng `days` ngày vào một ngày `YYYY-MM-DD` (số âm để lùi). */
export function addDaysToDateOnly(value: string, days: number): string {
  return toDateOnlyString(new Date(parseDateOnly(value).getTime() + days * DAY_MS));
}

/** Số ngày từ `from` tới `to` (cả hai `YYYY-MM-DD`); âm nếu `to` trước `from`. */
export function daysBetweenDateOnly(from: string, to: string): number {
  return Math.round((parseDateOnly(to).getTime() - parseDateOnly(from).getTime()) / DAY_MS);
}

/**
 * Mốc 00:00 giờ Việt Nam của một ngày `YYYY-MM-DD`, quy ra UTC — dùng lọc `createdAt` theo "ngày" mà người dùng
 * nhìn thấy (đơn lập lúc 01:00 sáng 15/10 giờ VN là 18:00 UTC ngày 14/10, vẫn phải rơi vào ngày 15/10).
 */
export function vietnamDayStartUtc(value: string): Date {
  if (!isValidDateOnly(value)) throw new Error(`Ngày không hợp lệ: ${value}`);
  return new Date(`${value}T00:00:00.000+07:00`);
}
