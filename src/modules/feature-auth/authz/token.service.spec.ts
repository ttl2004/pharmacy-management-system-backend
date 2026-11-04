import { ErrorCode } from 'src/common/types/error-code';
import { TokenService } from './token.service';

const AUTH = { id: 'auth-1', userId: 'u1', password: 'hash' };
const USER = { id: 'u1', status: 'ACTIVE', isDeleted: false, role: { code: 'SALES_STAFF' } };
const CTX = { ip: '1.1.1.1', userAgent: 'UA', requestId: null };

function makeService(overrides: { prisma?: Record<string, unknown>; tx?: Record<string, unknown> } = {}) {
  const tx = {
    auth: { findFirst: jest.fn().mockResolvedValue(AUTH) },
    user: { findFirst: jest.fn().mockResolvedValue(USER) },
    refreshToken: { updateMany: jest.fn(), create: jest.fn() },
    ...overrides.tx,
  };
  const transactions = { forUser: jest.fn((_userId: string, work: (client: unknown) => unknown) => work(tx)) };
  const sessions = { activate: jest.fn(), revoke: jest.fn() };
  const prisma = {
    refreshToken: { findFirst: jest.fn(), updateMany: jest.fn() },
    user: { findFirst: jest.fn().mockResolvedValue(USER) },
    ...overrides.prisma,
  };
  const security = { record: jest.fn().mockResolvedValue(undefined) };
  const jwt = { signAsync: jest.fn().mockResolvedValue('access-token') };
  const service = new TokenService(
    prisma as never,
    transactions as never,
    sessions as never,
    jwt as never,
    { refreshTtl: 3600 } as never,
    security as never,
  );
  return { service, tx, transactions, sessions, prisma, security };
}

const errorCodeOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: { getResponse?: () => { code?: number } }) => error.getResponse?.().code,
  );

describe('TokenService.login', () => {
  it('khoá theo người dùng; thu hồi mọi phiên cũ rồi cấp phiên mới trong cùng transaction (đăng nhập một máy)', async () => {
    const { service, tx, transactions } = makeService();

    const pair = await service.login(AUTH as never, CTX);

    expect(transactions.forUser).toHaveBeenCalledWith('u1', expect.any(Function));
    expect(tx.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'u1', revokedAt: null } }),
    );
    expect(tx.refreshToken.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      tx.refreshToken.create.mock.invocationCallOrder[0],
    );
    expect(pair.accessToken).toBe('access-token');
  });

  it('nhân viên login đúng ghi LOGIN_OK trong tx forUser, kèm sid', async () => {
    const { service, tx, security } = makeService();
    await service.login(AUTH as never, CTX);
    expect(security.record).toHaveBeenCalledTimes(1);
    const [events, client] = security.record.mock.calls[0] as [Record<string, unknown>[], unknown];
    expect(client).toBe(tx);
    expect(events[0]).toMatchObject({
      type: 'AUTH.LOGIN_OK',
      actorId: 'u1',
      actorRoleCode: 'SALES_STAFF',
      context: CTX,
      sessionId: expect.any(String) as string,
    });
    expect(JSON.stringify(events)).not.toMatch(/password|username/i);
  });

  it('khách hàng login đúng KHÔNG ghi gì', async () => {
    const { service, security } = makeService({
      tx: { user: { findFirst: jest.fn().mockResolvedValue({ ...USER, role: { code: 'CUSTOMER' } }) } },
    });
    await service.login(AUTH as never, CTX);
    expect(security.record).not.toHaveBeenCalled();
  });

  it('mật khẩu vừa bị đổi trong lúc so bcrypt → LOGIN_INVALID, không cấp phiên', async () => {
    const { service, tx } = makeService({
      tx: { auth: { findFirst: jest.fn().mockResolvedValue({ ...AUTH, password: 'hash-moi' }) } },
    });
    expect(await errorCodeOf(service.login(AUTH as never, CTX))).toBe(ErrorCode.LOGIN_INVALID);
    expect(tx.refreshToken.create).not.toHaveBeenCalled();
  });
});

describe('TokenService.refresh', () => {
  const live = { id: 'rt1', sid: 's1', userId: 'u1', revokedAt: null, expiresAt: new Date(Date.now() + 60_000) };

  it('không mở transaction phiên (không khoá) — chỉ đọc phiên và ghi lần sử dụng', async () => {
    const { service, transactions, prisma } = makeService({
      prisma: { refreshToken: { findFirst: jest.fn().mockResolvedValue(live), updateMany: jest.fn() } },
    });
    await expect(service.refresh('raw', CTX)).resolves.toEqual({ accessToken: 'access-token' });
    expect(transactions.forUser).not.toHaveBeenCalled();
    expect((prisma.refreshToken as { updateMany: jest.Mock }).updateMany).toHaveBeenCalled();
  });

  it('người dùng không còn hoạt động → thu hồi phiên rồi báo SESSION_REVOKED', async () => {
    const { service, sessions } = makeService({
      prisma: {
        refreshToken: { findFirst: jest.fn().mockResolvedValue(live), updateMany: jest.fn() },
        user: { findFirst: jest.fn().mockResolvedValue({ ...USER, status: 'LOCKED' }) },
      },
    });
    expect(await errorCodeOf(service.refresh('raw', CTX))).toBe(ErrorCode.SESSION_REVOKED);
    expect(sessions.revoke).toHaveBeenCalledWith('s1');
  });

  it('refresh bị từ chối vì user LOCKED ghi REFRESH_DENIED_INACTIVE; refresh thành công KHÔNG ghi', async () => {
    const denied = makeService({
      prisma: {
        refreshToken: { findFirst: jest.fn().mockResolvedValue(live), updateMany: jest.fn() },
        user: { findFirst: jest.fn().mockResolvedValue({ ...USER, status: 'LOCKED' }) },
      },
    });
    await errorCodeOf(denied.service.refresh('raw', CTX));
    expect(denied.security.record).toHaveBeenCalledWith([
      {
        type: 'AUTH.REFRESH_DENIED_INACTIVE',
        actorId: 'u1',
        actorRoleCode: 'SALES_STAFF',
        sessionId: 's1',
        context: CTX,
      },
    ]);

    const ok = makeService({
      prisma: { refreshToken: { findFirst: jest.fn().mockResolvedValue(live), updateMany: jest.fn() } },
    });
    await ok.service.refresh('raw', CTX);
    expect(ok.security.record).not.toHaveBeenCalled();
  });

  it('khách hàng bị từ chối refresh: KHÔNG ghi', async () => {
    const { service, security } = makeService({
      prisma: {
        refreshToken: { findFirst: jest.fn().mockResolvedValue(live), updateMany: jest.fn() },
        user: { findFirst: jest.fn().mockResolvedValue({ ...USER, isDeleted: true, role: { code: 'CUSTOMER' } }) },
      },
    });
    await errorCodeOf(service.refresh('raw', CTX));
    expect(security.record).not.toHaveBeenCalled();
  });

  it('phiên đã thu hồi → SESSION_REVOKED, không cấp AT', async () => {
    const { service } = makeService({
      prisma: { refreshToken: { findFirst: jest.fn().mockResolvedValue({ ...live, revokedAt: new Date() }) } },
    });
    expect(await errorCodeOf(service.refresh('raw', CTX))).toBe(ErrorCode.SESSION_REVOKED);
  });
});
