import {
  addDaysToDateOnly,
  daysBetweenDateOnly,
  isValidDateOnly,
  parseDateOnly,
  toDateOnlyString,
  todayInVietnam,
  vietnamDayStartUtc,
} from './date-only.util';

describe('todayInVietnam', () => {
  it('06:00 sáng giờ VN (23:00 UTC hôm trước) đã là ngày mới', () => {
    expect(todayInVietnam(new Date('2026-10-14T23:00:00.000Z'))).toBe('2026-10-15');
  });

  it('16:59 UTC vẫn là ngày cũ theo giờ VN (23:59)', () => {
    expect(todayInVietnam(new Date('2026-10-14T16:59:00.000Z'))).toBe('2026-10-14');
  });
});

describe('isValidDateOnly', () => {
  it.each(['2026-02-30', '2026-13-01', '26-01-01', '2026-1-1', ''])('từ chối %p', (value) => {
    expect(isValidDateOnly(value)).toBe(false);
  });

  it('nhận ngày có thật, kể cả 29/02 năm nhuận', () => {
    expect(isValidDateOnly('2028-02-29')).toBe(true);
  });
});

describe('chuyển đổi YYYY-MM-DD ↔ Date', () => {
  it('đi vòng không đổi giá trị', () => {
    expect(toDateOnlyString(parseDateOnly('2027-01-31'))).toBe('2027-01-31');
  });

  it('parseDateOnly ném lỗi khi chuỗi sai', () => {
    expect(() => parseDateOnly('2027-02-30')).toThrow('Ngày không hợp lệ');
  });

  it('cộng ngày qua tháng và qua năm', () => {
    expect(addDaysToDateOnly('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysToDateOnly('2026-10-14', 90)).toBe('2027-01-12');
  });

  it('đếm ngày giữa hai mốc, âm khi đi lùi', () => {
    expect(daysBetweenDateOnly('2026-10-14', '2027-01-12')).toBe(90);
    expect(daysBetweenDateOnly('2026-10-14', '2026-10-13')).toBe(-1);
  });
});

describe('vietnamDayStartUtc', () => {
  it('00:00 ngày 15/10 giờ VN là 17:00 UTC ngày 14/10', () => {
    expect(vietnamDayStartUtc('2026-10-15').toISOString()).toBe('2026-10-14T17:00:00.000Z');
  });
});
