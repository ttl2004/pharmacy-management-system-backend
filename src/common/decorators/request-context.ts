import type { FastifyRequest } from 'fastify';

const USER_AGENT_MAX = 255;

/** Thông tin về request đang xử lý, không phụ thuộc đã đăng nhập hay chưa. */
export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

export function requestContextOf(req: FastifyRequest): RequestContext {
  const ua = req.headers?.['user-agent'];
  return {
    ip: req.ip ?? null,
    userAgent: typeof ua === 'string' && ua ? ua.slice(0, USER_AGENT_MAX) : null,
    requestId: req.id ?? null,
  };
}
