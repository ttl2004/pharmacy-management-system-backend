import { registerDecorator, ValidationOptions } from 'class-validator';
import { isValidDateOnly } from '../utils/date-only.util';

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
      options: { message: `${String(propertyName)} phải là ngày dạng YYYY-MM-DD`, ...options },
      validator: {
        validate: (value: unknown) => typeof value === 'string' && isValidDateOnly(value),
      },
    });
  };
}
