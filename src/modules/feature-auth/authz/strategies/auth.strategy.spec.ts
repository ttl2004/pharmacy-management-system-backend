import { UserStatus } from '@prisma/client';
import { AuthzStrategy } from './auth.strategy';

const CN1 = '11111111-1111-4111-8111-111111111111';
const payload = { sub: 'user-1', role: 'SALES_STAFF', sid: 'sid-1', jti: 'jti-1', iat: 1, exp: 2 };

/** Strategy có phiên luôn còn hiệu lực, và bản ghi `users` đọc ra là `user`. */
function makeStrategy(user: unknown) {
  const config = { secret: 'x'.repeat(32) } as never;
  const users = { findByIdWithRole: jest.fn().mockResolvedValue(user) } as never;
  const sessions = { isActive: jest.fn().mockResolvedValue(true) } as never;
  return new AuthzStrategy(config, users, sessions);
}

describe('AuthzStrategy.validate — chi nhánh của người gọi', () => {
  it('lấy branchId từ bản ghi users chứ không từ token', async () => {
    const strategy = makeStrategy({
      id: 'user-1',
      email: null,
      status: UserStatus.ACTIVE,
      branchId: CN1,
      role: { code: 'SALES_STAFF', level: 40 },
    });

    await expect(strategy.validate(payload as never)).resolves.toEqual({
      userId: 'user-1',
      sid: 'sid-1',
      email: null,
      role: 'SALES_STAFF',
      branchId: CN1,
      roleLevel: 40,
    });
  });

  it('vai trò không gắn chi nhánh nhận branchId null', async () => {
    const strategy = makeStrategy({
      id: 'user-1',
      email: 'admin@pos-ndm.local',
      status: UserStatus.ACTIVE,
      branchId: null,
      role: { code: 'ADMIN', level: 80 },
    });

    await expect(strategy.validate(payload as never)).resolves.toMatchObject({
      role: 'ADMIN',
      branchId: null,
      roleLevel: 80,
    });
  });
});
