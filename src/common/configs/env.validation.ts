import { z } from 'zod';

const units = { s: 1, m: 60, h: 3600, d: 86400 } as const;

export function durationSeconds(value: string): number {
  return Number(value.slice(0, -1)) * units[value.slice(-1) as keyof typeof units];
}

const duration = z
  .string({ error: 'Thời hạn phải là chuỗi ký tự' })
  .regex(/^\d+[smhd]$/, 'Thời hạn phải là số nguyên dương kèm đơn vị s, m, h hoặc d')
  .refine(
    (v) => Number.isSafeInteger(durationSeconds(v)) && durationSeconds(v) > 0 && durationSeconds(v) <= 2147483647,
    'Thời hạn phải lớn hơn 0 và không vượt quá 2147483647 giây',
  );

// Không dùng z.coerce.boolean(): Boolean('false') === true, biến chuỗi 'false' sẽ thành true.
const boolStr = (defaultValue: 'true' | 'false') =>
  z.enum(['true', 'false'], { error: 'Chỉ nhận giá trị true hoặc false' }).default(defaultValue);

export const envSchema = z
  .object({
    //- Ứng dụng
    PORT: z.coerce.number().int().positive().default(3000),

    //- Cơ sở dữ liệu
    DB_LOGGING: boolStr('false'),
    DATABASE_URL: z
      .string({ error: 'DATABASE_URL là bắt buộc và phải là chuỗi ký tự' })
      .regex(/^postgres(ql)?:\/\//, 'DATABASE_URL phải là chuỗi kết nối PostgreSQL'),

    //- Xác thực
    JWT_ACCESS_SECRET: z
      .string({ error: 'JWT_ACCESS_SECRET là bắt buộc và phải là chuỗi ký tự' })
      .min(32, 'JWT_ACCESS_SECRET phải có ít nhất 32 ký tự'),
    JWT_ACCESS_TTL: duration.default('15m'),
    REFRESH_TTL: duration.default('7d'),
    AUTH_REFRESH_IN_BODY: boolStr('false'),
    COOKIE_SECURE: boolStr('false'),
    COOKIE_SAMESITE: z
      .enum(['strict', 'lax', 'none'], { error: 'COOKIE_SAMESITE chỉ nhận strict, lax hoặc none' })
      .default('strict'),
    COOKIE_PATH: z
      .string({ error: 'COOKIE_PATH phải là chuỗi ký tự' })
      .startsWith('/', 'COOKIE_PATH phải bắt đầu bằng /')
      .default('/auth'),

    //- Quản trị viên cấp cao
    SUPER_ADMIN_EMAIL: z.string().optional(),
    SUPER_ADMIN_USERNAME: z.string().optional(),
    SUPER_ADMIN_PASSWORD: z.string().optional(),
    SUPER_ADMIN_FULL_NAME: z.string().default('Super Admin'),
    // Không default '' cho SĐT: cột là UNIQUE, hai bản ghi rỗng sẽ vi phạm ràng buộc.
    SUPER_ADMIN_PHONE_NUMBER: z.string().optional(),
    SUPER_ADMIN_ADDRESS: z.string().optional(),
    SUPER_ADMIN_DATE_OF_BIRTH: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'SUPER_ADMIN_DATE_OF_BIRTH phải có dạng YYYY-MM-DD')
      .optional(),
    SUPER_ADMIN_GENDER: z
      .enum(['MALE', 'FEMALE', 'OTHER'], { error: 'SUPER_ADMIN_GENDER chỉ nhận MALE, FEMALE hoặc OTHER' })
      .optional(),

    //- Mailer
    MAIL_GMAIL_USER: z.string().optional(),
    MAIL_GMAIL_APP_PASSWORD: z.string().optional(),
    MAIL_FROM_DEFAULT: z.string().optional(),
    MAIL_TEMPLATE_DIR: z.string().default('src/providers/mailer/templates'),
    MAIL_RABBITMQ_URL: z.string().optional(),
    MAIL_RABBITMQ_EXCHANGE: z.string().default('mailer.exchange'),
    MAIL_RABBITMQ_QUEUE: z.string().default('mailer.queue'),
  })
  .refine((env) => env.COOKIE_SAMESITE !== 'none' || env.COOKIE_SECURE === 'true', {
    message: 'COOKIE_SAMESITE=none yêu cầu COOKIE_SECURE=true',
  });

export type EnvConfig = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): EnvConfig & Record<string, unknown> {
  // `dotenv` biến dòng `KEY=` thành chuỗi rỗng, còn `.optional()` của zod chỉ bỏ qua `undefined`.
  // Chuẩn hoá rỗng thành "không khai báo" để file `.env.example` để trống không làm chết ứng dụng
  // khi dựng máy mới; biến bắt buộc vẫn bị từ chối vì thiếu hẳn giá trị.
  const normalized = Object.fromEntries(
    Object.entries(config).map(([key, value]) => [key, value === '' ? undefined : value]),
  );

  const result = envSchema.safeParse(normalized);

  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n  - ');
    throw new Error(`Cấu hình biến môi trường không hợp lệ:\n  - ${details}`);
  }

  return { ...config, ...result.data };
}
