import {
  addDaysToDateOnly,
  isValidDateOnly,
  todayInVietnam,
  vietnamDayStartUtc,
} from 'src/common/utils/date-only.util';
import { badRequest } from './inventory.error';

/** Ghi lùi chứng từ tối đa chừng này ngày (tính theo ngày giờ VN) — L9. */
export const DOCUMENT_BACKDATE_DAYS = 7;
/** Cho lệch đồng hồ client: ngày gửi lên được vượt hiện tại tối đa chừng này. */
const FUTURE_TOLERANCE_MS = 60_000;

/**
 * Ngày người dùng tự nhập trên chứng từ (ngày chi NCC, ngày điều chỉnh nợ, ngày chứng từ phiếu điều chỉnh kho):
 * - không ở tương lai (gõ nhầm năm 2062 → chứng từ "biến mất" khỏi mọi báo cáo hiện tại);
 * - lùi tối đa 7 ngày tính từ 00:00 giờ VN của 7 ngày trước — ghi bù việc quên nhập tuần này thì được, còn ghi lùi
 *   vào kỳ đã chốt báo cáo thì không.
 */
export function assertDocumentDate(value: Date, label: string, now: Date = new Date()): void {
  if (value.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) {
    throw badRequest(`${label} không được ở tương lai`);
  }
  const earliest = vietnamDayStartUtc(addDaysToDateOnly(todayInVietnam(now), -DOCUMENT_BACKDATE_DAYS));
  if (value < earliest) {
    throw badRequest(`${label} chỉ được lùi tối đa ${DOCUMENT_BACKDATE_DAYS} ngày (từ ${todayInVietnam(earliest)})`);
  }
}

/**
 * Đọc ngày chứng từ client gửi lên và kiểm theo {@link assertDocumentDate}.
 * Chuỗi chỉ có ngày (`YYYY-MM-DD`) được hiểu là NGÀY LỊCH giờ VN: `new Date('2026-11-20')` là 00:00 UTC = 07:00 VN,
 * nên 06:30 sáng 20/11 "hôm nay" sẽ bị coi là tương lai. Với dạng này: so theo ngày VN (hôm nay và 7 ngày trước đều được);
 * lưu `now` nếu là hôm nay, ngược lại lưu 00:00 giờ VN của ngày đó (vẫn rơi đúng ngày VN khi báo cáo gom theo ngày).
 * Chuỗi có giờ giữ nguyên hành vi cũ.
 */
export function parseDocumentDate(raw: string, label: string, now: Date = new Date()): Date {
  if (!isValidDateOnly(raw)) {
    const value = new Date(raw);
    // Không dựa hoàn toàn vào DTO: ngày hỏng (NaN) lọt qua cả hai phép so sánh rồi thành lỗi 500 ở Prisma.
    if (Number.isNaN(value.getTime())) throw badRequest(`${label} không hợp lệ`);
    assertDocumentDate(value, label, now);
    return value;
  }
  const today = todayInVietnam(now);
  if (raw > today) throw badRequest(`${label} không được ở tương lai`);
  const earliestDay = addDaysToDateOnly(today, -DOCUMENT_BACKDATE_DAYS);
  if (raw < earliestDay) {
    throw badRequest(`${label} chỉ được lùi tối đa ${DOCUMENT_BACKDATE_DAYS} ngày (từ ${earliestDay})`);
  }
  return raw === today ? now : vietnamDayStartUtc(raw);
}
