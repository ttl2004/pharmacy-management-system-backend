import { pinoHttpOptions, swaggerEnabled } from './logger.config';

describe('cấu hình log theo môi trường (L13) và Swagger (L1)', () => {
  it('development: log dễ đọc (pino-pretty); production/test: JSON, không transport', () => {
    expect(pinoHttpOptions('development').transport).toMatchObject({ target: 'pino-pretty' });
    expect(pinoHttpOptions('production').transport).toBeUndefined();
    expect(pinoHttpOptions('test').transport).toBeUndefined();
  });

  it('serializer req che SĐT trong url', () => {
    const serialize = pinoHttpOptions('production').serializers.req;
    expect((serialize({ method: 'GET', url: '/order?search=0901234567' }) as { url: string }).url).toBe(
      '/order?search=*******567',
    );
  });

  it('serializer req che cả SĐT trong query đã tách (pino-http log thêm trường query)', () => {
    const out = pinoHttpOptions('production').serializers.req({
      url: '/customer?phone=0901234567&page=2',
      query: { phone: '0901234567', page: '2', tags: ['0912345678'] },
    }) as { query: Record<string, unknown> };
    expect(out.query).toEqual({ phone: '*******567', page: '2', tags: ['*******678'] });
  });

  it('Swagger chỉ bật khi NODE_ENV=development', () => {
    expect(swaggerEnabled('development')).toBe(true);
    expect(swaggerEnabled('production')).toBe(false);
    expect(swaggerEnabled('test')).toBe(false);
    expect(swaggerEnabled(undefined)).toBe(false);
  });
});
