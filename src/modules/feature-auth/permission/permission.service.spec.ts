import { ErrorException } from 'src/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';
import { PermissionService } from './permission.service';

/** Chỉ cắm những method mà `assignRole` gọi. */
function makeService(overrides: {
  roles?: Record<string, jest.Mock>;
  users?: Record<string, jest.Mock>;
  userService?: Record<string, jest.Mock>;
}) {
  const roles = { findOne: jest.fn(), ...overrides.roles } as never;
  const permissions = {} as never;
  const rolePermissions = {} as never;
  const users = { findByIdWithRole: jest.fn(), update: jest.fn(), ...overrides.users } as never;
  const transactions = {} as never;
  const userService = { assertBranchRule: jest.fn().mockResolvedValue(undefined), ...overrides.userService } as never;
  return new PermissionService(roles, permissions, rolePermissions, users, transactions, userService);
}

const PHARMACY_MANAGER_ROLE = { id: 'role-pm', code: 'PHARMACY_MANAGER' };

describe('PermissionService — đổi vai trò', () => {
  it('áp luật 10 chi nhánh với chi nhánh hiện tại của người bị đổi', async () => {
    const assertBranchRule = jest.fn().mockResolvedValue(undefined);
    const service = makeService({
      roles: { findOne: jest.fn().mockResolvedValue(PHARMACY_MANAGER_ROLE) },
      users: {
        findByIdWithRole: jest.fn().mockResolvedValue({ id: 'u1', branchId: null }),
        update: jest.fn().mockResolvedValue({ id: 'u1' }),
      },
      userService: { assertBranchRule },
    });

    await expect(service.assignRole('u1', 'PHARMACY_MANAGER', 'actor-id')).resolves.toEqual({
      userId: 'u1',
      roleCode: 'PHARMACY_MANAGER',
    });
    expect(assertBranchRule).toHaveBeenCalledWith('PHARMACY_MANAGER', null);
  });

  it('không ghi gì khi luật 10 không thoả', async () => {
    const update = jest.fn();
    const service = makeService({
      roles: { findOne: jest.fn().mockResolvedValue(PHARMACY_MANAGER_ROLE) },
      users: { findByIdWithRole: jest.fn().mockResolvedValue({ id: 'u1', branchId: null }), update },
      userService: {
        assertBranchRule: jest
          .fn()
          .mockRejectedValue(new ErrorException({ code: ErrorCode.INVALID_REFERENCE, message: 'thiếu chi nhánh' })),
      },
    });

    await expect(service.assignRole('u1', 'PHARMACY_MANAGER', 'actor-id')).rejects.toMatchObject({
      errorCode: ErrorCode.INVALID_REFERENCE,
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('người dùng không tồn tại thì báo 1200', async () => {
    const service = makeService({
      roles: { findOne: jest.fn().mockResolvedValue(PHARMACY_MANAGER_ROLE) },
      users: { findByIdWithRole: jest.fn().mockResolvedValue(null) },
    });

    await expect(service.assignRole('u1', 'PHARMACY_MANAGER', 'actor-id')).rejects.toMatchObject({
      errorCode: ErrorCode.USER_NOT_FOUND,
    });
  });
});
