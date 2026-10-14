import { ErrorCode } from 'src/common/types/error-code';
import { TokenService } from './token.service';

const AUTH = { id: 'auth-1', userId: 'u1', password: 'hash' };
const USER = { id: 'u1', role: { code: 'SALES_STAFF' } };

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
  const jwt = { signAsync: jest.fn().mockResolvedValue('access-token') };
  const service = new TokenService(
    prisma as never,
    transactions as never,
    sessions as never,
    jwt as never,
    { refreshTtl: 3600 } as never,
  );
  return { service, tx, transactions, sessions, prisma };
}

const errorCodeOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: { getResponse?: () => { code?: number } }) => error.getResponse?.().code,
  );

describe('TokenService.login', () => {
  it('khoá theo người dùng; thu hồi mọi phiên cũ rồi cấp phiên mới trong cùng transaction (đăng nhập một máy)', async () => {
    const { service, tx, transactions } = makeService();

    const pair = await service.login(AUTH as never, {});

    expect(transactions.forUser).toHaveBeenCalledWith('u1', expect.any(Function));
    expect(tx.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'u1', revokedAt: null } }),
    );
    expect(tx.refreshToken.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      tx.refreshToken.create.mock.invocationCallOrder[0],
    );
    expect(pair.accessToken).toBe('access-token');
  });

  it('mật khẩu vừa bị đổi trong lúc so bcrypt → LOGIN_INVALID, không cấp phiên', async () => {
    const { service, tx } = makeService({
      tx: { auth: { findFirst: jest.fn().mockResolvedValue({ ...AUTH, password: 'hash-moi' }) } },
    });
    expect(await errorCodeOf(service.login(AUTH as never, {}))).toBe(ErrorCode.LOGIN_INVALID);
    expect(tx.refreshToken.create).not.toHaveBeenCalled();
  });
});

describe('TokenService.refresh', () => {
  const live = { id: 'rt1', sid: 's1', userId: 'u1', revokedAt: null, expiresAt: new Date(Date.now() + 60_000) };

  it('không mở transaction phiên (không khoá) — chỉ đọc phiên và ghi lần sử dụng', async () => {
    const { service, transactions, prisma } = makeService({
      prisma: { refreshToken: { findFirst: jest.fn().mockResolvedValue(live), updateMany: jest.fn() } },
    });
    await expect(service.refresh('raw')).resolves.toEqual({ accessToken: 'access-token' });
    expect(transactions.forUser).not.toHaveBeenCalled();
    expect((prisma.refreshToken as { updateMany: jest.Mock }).updateMany).toHaveBeenCalled();
  });

  it('người dùng không còn hoạt động → thu hồi phiên rồi báo SESSION_REVOKED', async () => {
    const { service, sessions } = makeService({
      prisma: {
        refreshToken: { findFirst: jest.fn().mockResolvedValue(live), updateMany: jest.fn() },
        user: { findFirst: jest.fn().mockResolvedValue(null) },
      },
    });
    expect(await errorCodeOf(service.refresh('raw'))).toBe(ErrorCode.SESSION_REVOKED);
    expect(sessions.revoke).toHaveBeenCalledWith('s1');
  });

  it('phiên đã thu hồi → SESSION_REVOKED, không cấp AT', async () => {
    const { service } = makeService({
      prisma: { refreshToken: { findFirst: jest.fn().mockResolvedValue({ ...live, revokedAt: new Date() }) } },
    });
    expect(await errorCodeOf(service.refresh('raw'))).toBe(ErrorCode.SESSION_REVOKED);
  });
});
