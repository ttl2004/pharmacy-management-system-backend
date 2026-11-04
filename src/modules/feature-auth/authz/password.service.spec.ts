import * as bcrypt from 'bcrypt';
import { ErrorCode } from 'src/common/types/error-code';
import { PasswordService } from './password.service';

const CTX = { ip: '2.2.2.2', userAgent: 'UA', requestId: null };
const HASH = bcrypt.hashSync('mat-khau-cu-1', 4);

function make(role: string) {
  const tx = {
    refreshToken: {
      findFirst: jest.fn().mockResolvedValue({ id: 'rt' }),
      updateMany: jest.fn(),
    },
    auth: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  const prisma = { auth: { findFirst: jest.fn().mockResolvedValue({ id: 'a1', password: HASH }) } };
  const transactions = { forUser: jest.fn((_u: string, work: (c: unknown) => unknown) => work(tx)) };
  const security = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new PasswordService(prisma as never, transactions as never, security as never);
  const user = { userId: 'u1', sid: 's1', role: role };
  return { service, tx, security, user };
}

describe('PasswordService.change security events', () => {
  it('đổi mật khẩu sai ghi PASSWORD_CHANGE_FAILED (ngoài tx); nhân viên', async () => {
    const { service, security, user } = make('SALES_STAFF');
    await expect(
      service.change(user as never, { currentPassword: 'sai', newPassword: 'mat-khau-moi-1' }, CTX),
    ).rejects.toMatchObject({ response: { code: ErrorCode.LOGIN_INVALID } });
    expect(security.record).toHaveBeenCalledWith([
      {
        type: 'AUTH.PASSWORD_CHANGE_FAILED',
        actorId: 'u1',
        actorRoleCode: 'SALES_STAFF',
        sessionId: 's1',
        context: CTX,
      },
    ]);
    expect(security.record.mock.calls[0]).toHaveLength(1);
  });

  it('ghi PASSWORD_CHANGE_FAILED hỏng không đổi lỗi trả về (vẫn LOGIN_INVALID)', async () => {
    const { service, security, user } = make('SALES_STAFF');
    security.record.mockRejectedValue(new Error('db down'));
    const logSpy = jest.spyOn(service['logger'], 'error').mockImplementation();
    await expect(
      service.change(user as never, { currentPassword: 'sai', newPassword: 'mat-khau-moi-1' }, CTX),
    ).rejects.toMatchObject({ response: { code: ErrorCode.LOGIN_INVALID } });
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it('đổi đúng ghi PASSWORD_CHANGED trong tx; metadata không chứa mật khẩu', async () => {
    const { service, security, user, tx } = make('SALES_STAFF');
    await service.change(user as never, { currentPassword: 'mat-khau-cu-1', newPassword: 'mat-khau-moi-1' }, CTX);
    const [events, client] = security.record.mock.calls[0] as [unknown[], unknown];
    expect(client).toBe(tx);
    expect(events).toEqual([
      { type: 'AUTH.PASSWORD_CHANGED', actorId: 'u1', actorRoleCode: 'SALES_STAFF', sessionId: 's1', context: CTX },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/mat-khau/);
  });

  it('khách hàng: không ghi cả khi sai lẫn khi đúng', async () => {
    const wrong = make('CUSTOMER');
    await wrong.service
      .change(wrong.user as never, { currentPassword: 'sai', newPassword: 'mat-khau-moi-1' }, CTX)
      .catch(() => undefined);
    const right = make('CUSTOMER');
    await right.service.change(
      right.user as never,
      { currentPassword: 'mat-khau-cu-1', newPassword: 'mat-khau-moi-1' },
      CTX,
    );
    expect(wrong.security.record).not.toHaveBeenCalled();
    expect(right.security.record).not.toHaveBeenCalled();
  });
});
