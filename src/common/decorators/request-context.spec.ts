import type { FastifyRequest } from 'fastify';
import { requestContextOf } from './request-context';

const req = (p: Partial<{ ip: string; id: string; headers: Record<string, string> }>) =>
  ({ headers: {}, ...p }) as unknown as FastifyRequest;

describe('requestContextOf', () => {
  it('lấy ip, user-agent và id của request', () => {
    expect(requestContextOf(req({ ip: '1.2.3.4', id: 'abc', headers: { 'user-agent': 'jest' } }))).toEqual({
      ip: '1.2.3.4',
      userAgent: 'jest',
      requestId: 'abc',
    });
  });

  it('cắt user-agent ở 255 ký tự', () => {
    const ctx = requestContextOf(req({ headers: { 'user-agent': 'a'.repeat(300) } }));
    expect(ctx.userAgent).toHaveLength(255);
  });

  it('thiếu thông tin thì trả null', () => {
    expect(requestContextOf(req({}))).toEqual({ ip: null, userAgent: null, requestId: null });
  });
});
