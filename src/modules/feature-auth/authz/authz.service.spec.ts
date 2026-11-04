import { UserStatus } from '@prisma/client';
import { SYSTEM_ACTOR_ID } from 'src/common/constants/app.constant';
import { ErrorCode } from 'src/common/types/error-code';
import * as bcrypt from 'bcrypt';
import { AuthzService } from './authz.service';
import { authError } from './auth.error';
import { LoginFailureMonitor } from './login-failure.monitor';

function makeService(prisma: { user: Record<string, jest.Mock>; role: Record<string, jest.Mock> }) {
  return new AuthzService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

describe('AuthzService.seedSystemActor', () => {
  it('tạo dòng users đúng id SYSTEM_ACTOR_ID, INACTIVE, vai trò SUPER_ADMIN', async () => {
    const create = jest.fn().mockResolvedValue({});
    const service = makeService({
      user: { findUnique: jest.fn().mockResolvedValue(null), create },
      role: { findFirst: jest.fn().mockResolvedValue({ id: 'role-sa' }) },
    });

    await service.seedSystemActor();

    const [{ data }] = create.mock.calls[0] as [{ data: Record<string, unknown> }];
    expect(data).toMatchObject({ id: SYSTEM_ACTOR_ID, roleId: 'role-sa', status: UserStatus.INACTIVE });
  });

  it('chạy lại khi đã có thì không tạo thêm', async () => {
    const create = jest.fn();
    const service = makeService({
      user: { findUnique: jest.fn().mockResolvedValue({ id: SYSTEM_ACTOR_ID }), create },
      role: { findFirst: jest.fn() },
    });

    await service.seedSystemActor();

    expect(create).not.toHaveBeenCalled();
  });

  it('chưa seed vai trò thì báo lỗi rõ ràng, không tạo gì', async () => {
    const create = jest.fn();
    const service = makeService({
      user: { findUnique: jest.fn().mockResolvedValue(null), create },
      role: { findFirst: jest.fn().mockResolvedValue(null) },
    });

    await expect(service.seedSystemActor()).rejects.toMatchObject({ errorCode: ErrorCode.ROLE_NOT_FOUND });
    expect(create).not.toHaveBeenCalled();
  });
});

describe('AuthzService security events', () => {
  const CTX = { ip: '9.9.9.9', userAgent: 'UA', requestId: null };
  const HASH = bcrypt.hashSync('dung-mat-khau', 4);
  const authzOf = (roleCode: string, over: Record<string, unknown> = {}) => ({
    id: 'a1',
    userId: 'u1',
    password: HASH,
    user: { id: 'u1', isDeleted: false, status: UserStatus.ACTIVE, role: { code: roleCode }, ...over },
  });

  function make(found: unknown, tokenLogin: jest.Mock = jest.fn().mockResolvedValue({ accessToken: 'a' })) {
    const security = { record: jest.fn().mockResolvedValue(undefined) };
    const sessions = { revokeAllByUser: jest.fn().mockResolvedValue(undefined) };
    const repo = { findByUsernameWithUser: jest.fn().mockResolvedValue(found) };
    const monitor = new LoginFailureMonitor();
    const detector = { check: jest.fn().mockResolvedValue(false) };
    const service = new AuthzService(
      repo as never,
      {} as never,
      { login: tokenLogin } as never,
      {} as never,
      {} as never,
      sessions as never,
      security as never,
      monitor,
      detector as never,
    );
    return { service, security, sessions, detector };
  }
  const fail = (p: Promise<unknown>) =>
    p.then(
      () => undefined,
      (e: { getResponse?: () => { code?: number } }) => e,
    );

  it('nhân viên sai mật khẩu ghi LOGIN_FAILED với actorId; khách hàng sai mật khẩu KHÔNG ghi', async () => {
    const staff = make(authzOf('SALES_STAFF'));
    await fail(staff.service.login({ username: 'u', password: 'sai' }, CTX));
    expect(staff.security.record).toHaveBeenCalledWith([
      { type: 'AUTH.LOGIN_FAILED', actorId: 'u1', actorRoleCode: 'SALES_STAFF', context: CTX },
    ]);
    const customer = make(authzOf('CUSTOMER'));
    await fail(customer.service.login({ username: 'u', password: 'sai' }, CTX));
    expect(customer.security.record).not.toHaveBeenCalled();
  });

  it('nhân viên không ACTIVE ghi LOGIN_FAILED; lỗi trả về vẫn là LOGIN_INVALID', async () => {
    const { service, security } = make(authzOf('SALES_STAFF', { status: UserStatus.LOCKED }));
    const err = await fail(service.login({ username: 'u', password: 'dung-mat-khau' }, CTX));
    expect(err?.getResponse?.().code).toBe(ErrorCode.LOGIN_INVALID);
    expect(security.record).toHaveBeenCalledTimes(1);
  });

  it('LOGIN_INVALID từ TokenService sau bcrypt đúng → LOGIN_FAILED', async () => {
    const tokenLogin = jest.fn().mockRejectedValue(authError(ErrorCode.LOGIN_INVALID));
    const { service, security } = make(authzOf('SALES_STAFF'), tokenLogin);
    const err = await fail(service.login({ username: 'u', password: 'dung-mat-khau' }, CTX));
    expect(err?.getResponse?.().code).toBe(ErrorCode.LOGIN_INVALID);
    expect(security.record).toHaveBeenCalledWith([
      expect.objectContaining({ type: 'AUTH.LOGIN_FAILED', actorId: 'u1' }),
    ]);
  });

  it('username không tồn tại: không ghi LOGIN_FAILED; lần thứ 20 cùng IP ghi LOGIN_FAILED_BURST actorId null', async () => {
    const { service, security, detector } = make(null);
    for (let i = 1; i <= 19; i++) {
      const err = await fail(service.login({ username: `ghost${i}`, password: 'x' }, CTX));
      expect(err?.getResponse?.().code).toBe(ErrorCode.LOGIN_INVALID);
    }
    expect(security.record).not.toHaveBeenCalled();
    await fail(service.login({ username: 'ghost20', password: 'x' }, CTX));
    expect(security.record).toHaveBeenCalledTimes(1);
    const [events] = security.record.mock.calls[0] as [Record<string, unknown>[]];
    expect(events).toEqual([
      expect.objectContaining({
        type: 'AUTH.LOGIN_FAILED_BURST',
        actorId: null,
        metadata: { count: 20, windowStart: expect.any(String) as string },
      }),
    ]);
    expect(JSON.stringify(events)).not.toMatch(/ghost/);
    expect(detector.check).not.toHaveBeenCalled();
    await fail(service.login({ username: 'ghost21', password: 'x' }, CTX));
    expect(security.record).toHaveBeenCalledTimes(1);
  });

  it('nhân viên sai mật khẩu: detector.check chạy sau khi ghi LOGIN_FAILED, trước khi throw', async () => {
    const { service, security, detector } = make(authzOf('SALES_STAFF'));
    await fail(service.login({ username: 'u', password: 'sai' }, CTX));
    expect(detector.check).toHaveBeenCalledWith('u1', 'SALES_STAFF', CTX);
    expect(security.record.mock.invocationCallOrder[0]).toBeLessThan(detector.check.mock.invocationCallOrder[0]);
  });

  it('khách hàng sai mật khẩu: không đụng detector', async () => {
    const { service, detector } = make(authzOf('CUSTOMER'));
    await fail(service.login({ username: 'u', password: 'sai' }, CTX));
    expect(detector.check).not.toHaveBeenCalled();
  });

  it('không có khoá: sau 11 lần sai, mật khẩu đúng vẫn đăng nhập được', async () => {
    const { service } = make(authzOf('SALES_STAFF'));
    for (let i = 0; i < 11; i++) await fail(service.login({ username: 'u', password: 'sai' }, CTX));
    await expect(service.login({ username: 'u', password: 'dung-mat-khau' }, CTX)).resolves.toEqual({
      accessToken: 'a',
    });
  });

  it('logout-all ghi LOGOUT_ALL cho nhân viên, không ghi cho khách hàng', async () => {
    const staff = make(null);
    await staff.service.logoutAll({ userId: 'u1', role: 'SALES_STAFF', sid: 's' } as never, CTX);
    expect(staff.sessions.revokeAllByUser).toHaveBeenCalledWith('u1');
    expect(staff.security.record).toHaveBeenCalledWith([
      { type: 'AUTH.LOGOUT_ALL', actorId: 'u1', actorRoleCode: 'SALES_STAFF', sessionId: 's', context: CTX },
    ]);
    const customer = make(null);
    await customer.service.logoutAll({ userId: 'u2', role: 'CUSTOMER', sid: 's' } as never, CTX);
    expect(customer.security.record).not.toHaveBeenCalled();
  });

  it('logout đơn lẻ KHÔNG ghi', async () => {
    const tokens = { logout: jest.fn() };
    const security = { record: jest.fn() };
    const service = new AuthzService(
      {} as never,
      {} as never,
      tokens as never,
      {} as never,
      {} as never,
      {} as never,
      security as never,
      {} as never,
      {} as never,
    );
    await service.logout('s', undefined);
    expect(security.record).not.toHaveBeenCalled();
  });
});
