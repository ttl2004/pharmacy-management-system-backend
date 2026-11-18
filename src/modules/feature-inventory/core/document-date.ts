import { addDaysToDateOnly, todayInVietnam, vietnamDayStartUtc } from 'src/common/utils/date-only.util';
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
