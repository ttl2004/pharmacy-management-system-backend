import type { Params } from 'nestjs-pino';
import { maskPhonesInText } from '../utils/mask.util';

export type NodeEnv = 'development' | 'production' | 'test';

/** Che SĐT trong mọi chuỗi của một giá trị query (chuỗi, mảng, object lồng). Không sửa object gốc. */
function maskDeep(value: unknown): unknown {
  if (typeof value === 'string') return maskPhonesInText(value);
  if (Array.isArray(value)) return value.map(maskDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskDeep(item)]));
  }
  return value;
}

/** Swagger `/docs` chỉ mở khi chạy dev (L1): chạy thật không để lộ toàn bộ danh sách API. */
export function swaggerEnabled(nodeEnv: string | undefined): boolean {
  return nodeEnv === 'development';
}

/**
 * Cấu hình pino-http (L13):
 * - dev: `pino-pretty` một dòng, có màu, dễ đọc; chạy thật/test: JSON thuần (nhanh, đưa vào hệ thống gom log được).
 * - URL trong log đã che SĐT: tìm đơn/khách theo SĐT đi qua query string.
 * - Header xác thực, cookie, mật khẩu, refresh token không bao giờ ra log.
 */
export function pinoHttpOptions(nodeEnv: string | undefined): NonNullable<Params['pinoHttp']> & {
  serializers: Record<string, (value: unknown) => unknown>;
  transport?: { target: string; options?: Record<string, unknown> };
} {
  return {
    redact: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      'req.body.password',
      'req.body.refreshToken',
    ],
    level: 'info',
    serializers: {
      req: (req: unknown) => {
        const value = req as { url?: unknown; query?: unknown };
        if (typeof value.url === 'string') value.url = maskPhonesInText(value.url);
        // pino-http còn ghi riêng `query` đã tách — che cả ở đây, nếu không SĐT vẫn lộ.
        if (value.query && typeof value.query === 'object') value.query = maskDeep(value.query);
        return value;
      },
    },
    ...(nodeEnv === 'development'
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, singleLine: true, translateTime: 'SYS:standard' },
          },
        }
      : {}),
  };
}
