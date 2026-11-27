import { CronTime } from 'cron';
import { z } from 'zod';

function isValidCron(value: string): boolean {
  try {
    new CronTime(value);
    return true;
  } catch {
    return false;
  }
}

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

// Số proxy tin cậy phía trước app (0 = không có proxy). Dùng chung cho schema env và main.ts (adapter dựng trước ConfigService).
export const trustProxySchema = z.coerce
  .number({ error: 'TRUST_PROXY phải là số' })
  .int('TRUST_PROXY phải là số nguyên')
  .min(0, 'TRUST_PROXY không được âm')
  .max(5, 'TRUST_PROXY tối đa là 5')
  .default(0);

export const envSchema = z
  .object({
    //- Ứng dụng
    // Không khai báo = coi như chạy thật (production): Swagger tắt, log JSON. Máy dev đặt NODE_ENV=development.
    NODE_ENV: z
      .enum(['development', 'production', 'test'], { error: 'NODE_ENV chỉ nhận development, production hoặc test' })
      .default('production'),
    PORT: z.coerce.number().int().positive().default(3790),
    // Origin được gọi API kèm cookie, ngăn cách bằng dấu phẩy. Để trống: không cho trình duyệt gọi chéo origin.
    CORS_ORIGINS: z
      .string()
      .default('')
      .transform((value) =>
        value
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean),
      )
      // CORS so origin theo chuỗi tuyệt đối: giá trị phải đúng dạng chuẩn trình duyệt gửi (chữ thường, không / cuối,
      // không ký tự đại diện), nếu không sẽ hợp lệ khi kiểm mà không bao giờ khớp.
      .pipe(
        z.array(
          z
            .string()
            .refine(
              (origin) =>
                URL.canParse(origin) && /^https?:$/.test(new URL(origin).protocol) && new URL(origin).origin === origin,
              'Mỗi origin có dạng http(s)://host[:port], chữ thường, không có / cuối',
            ),
        ),
      ),

    TRUST_PROXY: trustProxySchema,

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

    //- Đối soát doanh thu hằng đêm
    REPORT_RECONCILE_ENABLED: boolStr('true'),
    // Biểu thức cron (giờ Asia/Ho_Chi_Minh); sai cú pháp thì app không khởi động chứ không lặng lẽ không chạy.
    REPORT_RECONCILE_CRON: z
      .string({ error: 'REPORT_RECONCILE_CRON phải là chuỗi ký tự' })
      .refine(isValidCron, 'REPORT_RECONCILE_CRON không phải biểu thức cron hợp lệ')
      .default('15 0 * * *'),

    //- Mailer
    MAIL_GMAIL_USER: z.string().optional(),
    MAIL_GMAIL_APP_PASSWORD: z.string().optional(),
    MAIL_FROM_DEFAULT: z.string().optional(),
    MAIL_TEMPLATE_DIR: z.string().default('src/providers/mailer/templates'),
    MAIL_RABBITMQ_URL: z.string().optional(),
    MAIL_RABBITMQ_EXCHANGE: z.string().default('mailer.exchange'),
    MAIL_RABBITMQ_QUEUE: z.string().default('mailer.queue'),

    //- Nguồn danh mục thuốc CSDL Dược quốc gia (hiện là API giả lập ở repo CSDL-Drug)
    DRUG_SOURCE_URL: z
      .string()
      .refine(
        (url) => URL.canParse(url) && /^https?:$/.test(new URL(url).protocol),
        'DRUG_SOURCE_URL phải là URL http(s)',
      )
      .default('http://localhost:8001'),

    //- Trợ lý hỏi đáp thuốc (RAG service: projects/base-rag/api.py hoặc bản RAG hoàn chỉnh cùng hợp đồng)
    RAG_SERVICE_URL: z
      .string()
      .refine(
        (url) => URL.canParse(url) && /^https?:$/.test(new URL(url).protocol),
        'RAG_SERVICE_URL phải là URL http(s)',
      )
      .default('http://127.0.0.1:8790'),
    // Gửi qua header X-Internal-Key; phải trùng RAG_INTERNAL_KEY bên RAG service. Bỏ trống = không gửi.
    RAG_INTERNAL_KEY: z.string().optional(),

    //- Service kiểm tra tương tác thuốc (repo TTT-BE, dữ liệu DDInter)
    INTERACTION_SERVICE_URL: z
      .string()
      .refine(
        (url) => URL.canParse(url) && /^https?:$/.test(new URL(url).protocol),
        'INTERACTION_SERVICE_URL phải là URL http(s)',
      )
      .default('http://127.0.0.1:8791'),
    // Gửi qua header X-Internal-Key; phải trùng INTERACTION_INTERNAL_KEY bên TTT-BE. Bỏ trống = không gửi.
    INTERACTION_INTERNAL_KEY: z.string().optional(),

    //- OCR service đọc tờ HDSD (repo pharmacy-ocr). Bỏ trống URL = tắt tính năng nhập thuốc từ ảnh.
    // "" (dòng `OCR_SERVICE_URL=` trong .env) được coi như không đặt.
    OCR_SERVICE_URL: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z
        .string()
        .refine(
          (url) => URL.canParse(url) && /^https?:$/.test(new URL(url).protocol),
          'OCR_SERVICE_URL phải là URL http(s)',
        )
        .optional(),
    ),
    // Gửi qua header X-API-Key; bắt buộc khi có OCR_SERVICE_URL.
    OCR_SERVICE_API_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  })
  .refine((env) => !env.OCR_SERVICE_URL || !!env.OCR_SERVICE_API_KEY, {
    message: 'OCR_SERVICE_URL yêu cầu OCR_SERVICE_API_KEY',
    path: ['OCR_SERVICE_API_KEY'],
  })
  .refine((env) => env.COOKIE_SAMESITE !== 'none' || env.COOKIE_SECURE === 'true', {
    message: 'COOKIE_SAMESITE=none yêu cầu COOKIE_SECURE=true',
  });

export type EnvConfig = z.infer<typeof envSchema>;

/**
 * Cảnh báo cấu hình chạy thật thiếu an toàn (chỉ cảnh báo, không chặn khởi động để không làm hỏng lần triển khai).
 * `TRUST_PROXY` = 0 gồm cả trường hợp không khai báo.
 */
export function productionEnvWarnings(env: {
  NODE_ENV?: string;
  COOKIE_SECURE?: string;
  TRUST_PROXY?: number;
}): string[] {
  if (env.NODE_ENV !== 'production') return [];
  const warnings: string[] = [];
  if (env.COOKIE_SECURE !== 'true') {
    warnings.push(
      'COOKIE_SECURE chưa bật (true) khi chạy production: cookie refresh token có thể bị gửi qua HTTP thường và bị đánh cắp. Hãy đặt COOKIE_SECURE=true khi chạy sau HTTPS.',
    );
  }
  if (!env.TRUST_PROXY) {
    warnings.push(
      'TRUST_PROXY chưa khai báo (hoặc =0) khi chạy production: nếu app đứng sau reverse proxy/load balancer thì mọi request sẽ mang IP của proxy, làm sai giới hạn tần suất, phát hiện dò mật khẩu và nhật ký IP. Đặt TRUST_PROXY = số proxy đứng trước app (vd. 1).',
    );
  }
  return warnings;
}

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
