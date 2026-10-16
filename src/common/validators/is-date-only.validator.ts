import { registerDecorator, ValidationOptions } from 'class-validator';
import { isValidDateOnly } from '../utils/date-only.util';

/**
 * Khoảng năm chấp nhận từ người dùng. Chặn ngày cực đoan: `toDate=9999-12-31` cộng 1 ngày để lấy mốc "trước ngày hôm
 * sau" thành năm 10000 — vượt định dạng `YYYY-MM-DD` và trả 500. Hạn dùng, ngày sản xuất, ngày hoá đơn đều nằm gọn trong
 * khoảng này.
 */
const MIN_YEAR = 1900;
const MAX_YEAR = 2999;

function isAcceptedDateOnly(value: unknown): boolean {
  if (typeof value !== 'string' || !isValidDateOnly(value)) return false;
  const year = Number(value.slice(0, 4));
  return year >= MIN_YEAR && year <= MAX_YEAR;
}

/**
 * Trường ngày không giờ (`YYYY-MM-DD`) và là ngày có thật. Không dùng `@IsDateString()` vì nó nhận cả
 * `2027-01-31T10:00:00Z` — giờ trong hạn dùng là vô nghĩa và dễ lệch ngày khi đổi múi giờ.
 */
export function IsDateOnly(options?: ValidationOptions): PropertyDecorator {
  return (target: object, propertyName: string | symbol) => {
    registerDecorator({
      name: 'isDateOnly',
      target: target.constructor,
      propertyName: propertyName as string,
      options: {
        message: `${String(propertyName)} phải là ngày dạng YYYY-MM-DD, năm từ ${MIN_YEAR} đến ${MAX_YEAR}`,
        ...options,
      },
      validator: {
        validate: isAcceptedDateOnly,
      },
    });
  };
}
