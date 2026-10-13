import { SYSTEM_ACTOR_ID } from 'src/common/constants/app.constant';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { AuthRole } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';
import type { JwtUser } from '../authz/types/authz.types';
import { PERMISSION_CODES } from './permission.constant';
import { PermissionService } from './permission.service';
import { DEFAULT_ROLE_GRANTS } from './role.constant';

const CN1 = '11111111-1111-4111-8111-111111111111';
const CN2 = '22222222-2222-4222-8222-222222222222';

function caller(userId: string, role: AuthRole, branchId: string | null = null): JwtUser {
  return { userId, sid: 'sid', email: null, role, branchId };
}

const SUPER_ADMIN = caller('actor-id', AuthRole.SUPER_ADMIN);
const MANAGER_CN1 = caller('pm-caller', AuthRole.PHARMACY_MANAGER, CN1);

/** Chỉ cắm những dependency mà từng test cần; phần còn lại là object rỗng. */
function makeService(overrides: {
  roles?: Record<string, jest.Mock>;
  permissions?: Record<string, jest.Mock>;
  rolePermissions?: Record<string, jest.Mock>;
  users?: Record<string, jest.Mock>;
  userService?: Record<string, jest.Mock>;
}) {
  const roles = { findOne: jest.fn(), ...overrides.roles } as never;
  const permissions = { ...overrides.permissions } as never;
  const rolePermissions = { ...overrides.rolePermissions } as never;
  const users = { findByIdWithRole: jest.fn(), update: jest.fn(), ...overrides.users } as never;
  const transactions = { write: jest.fn((work: (tx: unknown) => unknown) => work({})) } as never;
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

    await expect(service.assignRole('u1', 'PHARMACY_MANAGER', SUPER_ADMIN)).resolves.toEqual({
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

    await expect(service.assignRole('u1', 'PHARMACY_MANAGER', SUPER_ADMIN)).rejects.toMatchObject({
      errorCode: ErrorCode.INVALID_REFERENCE,
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('người dùng không tồn tại thì báo 1200', async () => {
    const service = makeService({
      roles: { findOne: jest.fn().mockResolvedValue(PHARMACY_MANAGER_ROLE) },
      users: { findByIdWithRole: jest.fn().mockResolvedValue(null) },
    });

    await expect(service.assignRole('u1', 'PHARMACY_MANAGER', SUPER_ADMIN)).rejects.toMatchObject({
      errorCode: ErrorCode.USER_NOT_FOUND,
    });
  });

  it('người gọi bị giới hạn chi nhánh đổi vai trò người ngoài chi nhánh thì nhận 1200, không ghi gì', async () => {
    const update = jest.fn();
    const service = makeService({
      roles: { findOne: jest.fn().mockResolvedValue({ id: 'role-ss', code: 'SALES_STAFF' }) },
      users: { findByIdWithRole: jest.fn().mockResolvedValue({ id: 'u2', branchId: CN2 }), update },
    });

    await expect(service.assignRole('u2', 'SALES_STAFF', MANAGER_CN1)).rejects.toMatchObject({
      errorCode: ErrorCode.USER_NOT_FOUND,
    });
    expect(update).not.toHaveBeenCalled();
  });
});

describe('PermissionService — quyền của chính mình', () => {
  it('SUPER_ADMIN nhận phạm vi ALL và toàn bộ mã quyền', async () => {
    const result = await makeService({}).getMyPermissions(SUPER_ADMIN);

    expect(result).toMatchObject({
      role: AuthRole.SUPER_ADMIN,
      isSuperAdmin: true,
      branchId: null,
      branchScope: 'ALL',
    });
    expect(result.permissions).toEqual([...PERMISSION_CODES]);
  });

  it('nhân viên nhận phạm vi BRANCH kèm chi nhánh của mình', async () => {
    const service = makeService({
      roles: { findOne: jest.fn().mockResolvedValue({ id: 'role-ss', code: 'SALES_STAFF' }) },
      rolePermissions: { findGrantedCodes: jest.fn().mockResolvedValue(['product:read']) },
    });

    await expect(service.getMyPermissions(caller('ss-id', AuthRole.SALES_STAFF, CN2))).resolves.toEqual({
      role: AuthRole.SALES_STAFF,
      isSuperAdmin: false,
      permissions: ['product:read'],
      branchId: CN2,
      branchScope: 'BRANCH',
    });
  });
});

describe('PermissionService — seed quyền mặc định', () => {
  it('cấp theo từng cặp (vai trò, quyền) cho mọi vai trò có trong DEFAULT_ROLE_GRANTS', async () => {
    const catalog = PERMISSION_CODES.map((code) => ({ id: `id:${code}`, code }));
    const grantMissing = jest.fn().mockResolvedValue(0);
    const service = makeService({
      roles: {
        findOne: jest
          .fn()
          .mockImplementation(({ code }: { code: string }) => Promise.resolve({ id: `role:${code}`, code })),
        update: jest.fn().mockResolvedValue({}),
        create: jest.fn(),
      },
      permissions: {
        findOne: jest.fn().mockResolvedValue({ id: 'existing' }),
        update: jest.fn().mockResolvedValue({}),
        create: jest.fn(),
        findAllOrdered: jest.fn().mockResolvedValue(catalog),
      },
      rolePermissions: { grantMissing },
    });

    await service.seedCatalog();

    const entries = Object.entries(DEFAULT_ROLE_GRANTS);
    expect(grantMissing).toHaveBeenCalledTimes(entries.length);
    for (const [roleCode, codes] of entries) {
      expect(grantMissing).toHaveBeenCalledWith(
        expect.anything(),
        `role:${roleCode}`,
        (codes ?? []).map((code) => `id:${code}`),
        SYSTEM_ACTOR_ID,
      );
    }
  });
});
