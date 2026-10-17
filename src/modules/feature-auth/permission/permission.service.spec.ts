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

/** Cấp bậc theo seed `roles.level`. */
const LEVEL: Record<AuthRole, number> = {
  [AuthRole.SUPER_ADMIN]: 100,
  [AuthRole.ADMIN]: 80,
  [AuthRole.PHARMACY_MANAGER]: 60,
  [AuthRole.SALES_STAFF]: 40,
  [AuthRole.CUSTOMER]: 20,
};

function caller(userId: string, role: AuthRole, branchId: string | null = null): JwtUser {
  return { userId, sid: 'sid', email: null, role, branchId, roleLevel: LEVEL[role] };
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
  const prisma = {
    $transaction: jest.fn((work: (tx: unknown) => unknown) => work({ $executeRaw: jest.fn() })),
  } as never;
  const userService = { assertBranchRule: jest.fn().mockResolvedValue(undefined), ...overrides.userService } as never;
  return new PermissionService(roles, permissions, rolePermissions, users, prisma, userService);
}

const PHARMACY_MANAGER_ROLE = { id: 'role-pm', code: 'PHARMACY_MANAGER', level: 60 };
const SALES_STAFF_TARGET = { id: 'u1', branchId: null, role: { code: 'SALES_STAFF', level: 40 } };

describe('PermissionService — đổi vai trò', () => {
  it('áp luật 10 chi nhánh với chi nhánh hiện tại của người bị đổi', async () => {
    const assertBranchRule = jest.fn().mockResolvedValue(undefined);
    const service = makeService({
      roles: { findOne: jest.fn().mockResolvedValue(PHARMACY_MANAGER_ROLE) },
      users: {
        findByIdWithRole: jest.fn().mockResolvedValue(SALES_STAFF_TARGET),
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
      users: { findByIdWithRole: jest.fn().mockResolvedValue(SALES_STAFF_TARGET), update },
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
      roles: { findOne: jest.fn().mockResolvedValue({ id: 'role-ss', code: 'SALES_STAFF', level: 40 }) },
      users: {
        findByIdWithRole: jest
          .fn()
          .mockResolvedValue({ id: 'u2', branchId: CN2, role: { code: 'SALES_STAFF', level: 40 } }),
        update,
      },
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

describe('PermissionService — rào cấp bậc', () => {
  const ADMIN = caller('admin-1', AuthRole.ADMIN);
  const ADMIN_ROLE = { id: 'role-admin', code: 'ADMIN', level: 80 };
  const SUPER_ADMIN_ROLE = { id: 'role-sa', code: 'SUPER_ADMIN', level: 100 };

  it('không đổi được vai trò của tài khoản SUPER_ADMIN (1604), kể cả SUPER_ADMIN gọi', async () => {
    const update = jest.fn();
    const service = makeService({
      roles: { findOne: jest.fn().mockResolvedValue(PHARMACY_MANAGER_ROLE) },
      users: {
        findByIdWithRole: jest.fn().mockResolvedValue({ id: 'sa-2', branchId: null, role: SUPER_ADMIN_ROLE }),
        update,
      },
    });

    await expect(service.assignRole('sa-2', 'PHARMACY_MANAGER', SUPER_ADMIN)).rejects.toMatchObject({
      errorCode: ErrorCode.SUPER_ADMIN_PROTECTED,
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('không gán được vai trò SUPER_ADMIN qua API (1603)', async () => {
    const service = makeService({
      roles: { findOne: jest.fn().mockResolvedValue(SUPER_ADMIN_ROLE) },
      users: { findByIdWithRole: jest.fn().mockResolvedValue(SALES_STAFF_TARGET) },
    });

    await expect(service.assignRole('u1', 'SUPER_ADMIN', SUPER_ADMIN)).rejects.toMatchObject({
      errorCode: ErrorCode.ROLE_NOT_ASSIGNABLE,
    });
  });

  it('ADMIN không nâng người khác lên ADMIN (1508)', async () => {
    const update = jest.fn();
    const service = makeService({
      roles: { findOne: jest.fn().mockResolvedValue(ADMIN_ROLE) },
      users: { findByIdWithRole: jest.fn().mockResolvedValue(SALES_STAFF_TARGET), update },
    });

    await expect(service.assignRole('u1', 'ADMIN', ADMIN)).rejects.toMatchObject({
      response: { code: ErrorCode.ROLE_LEVEL_FORBIDDEN },
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('ADMIN không hạ được người đang giữ vai trò ADMIN (1508)', async () => {
    const update = jest.fn();
    const service = makeService({
      roles: { findOne: jest.fn().mockResolvedValue({ id: 'role-ss', code: 'SALES_STAFF', level: 40 }) },
      users: {
        findByIdWithRole: jest.fn().mockResolvedValue({ id: 'admin-2', branchId: null, role: ADMIN_ROLE }),
        update,
      },
    });

    await expect(service.assignRole('admin-2', 'SALES_STAFF', ADMIN)).rejects.toMatchObject({
      response: { code: ErrorCode.ROLE_LEVEL_FORBIDDEN },
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('ADMIN không sửa được ma trận quyền của chính vai trò ADMIN (1508)', async () => {
    const service = makeService({ roles: { findOne: jest.fn().mockResolvedValue(ADMIN_ROLE) } });

    await expect(service.replaceRolePermissions('ADMIN', ['branch:read'], ADMIN)).rejects.toMatchObject({
      response: { code: ErrorCode.ROLE_LEVEL_FORBIDDEN },
    });
  });

  it('chỉ cấp thêm được quyền chính mình đang có (1509)', async () => {
    const replaceForRole = jest.fn();
    const service = makeService({
      roles: {
        findOne: jest
          .fn()
          .mockImplementation(({ code }: { code: string }) =>
            Promise.resolve(code === 'ADMIN' ? ADMIN_ROLE : PHARMACY_MANAGER_ROLE),
          ),
      },
      permissions: {
        findAllOrdered: jest.fn().mockResolvedValue(PERMISSION_CODES.map((code) => ({ id: `id:${code}`, code }))),
      },
      rolePermissions: {
        // vai trò đích đang có product:read; người gọi (ADMIN) chỉ có user:read
        findGrantedCodes: jest
          .fn()
          .mockImplementation((roleId: string) =>
            Promise.resolve(roleId === 'role-pm' ? ['product:read'] : ['user:read']),
          ),
        replaceForRole,
      },
    });

    await expect(
      service.replaceRolePermissions('PHARMACY_MANAGER', ['product:read', 'branch:delete'], ADMIN),
    ).rejects.toMatchObject({ response: { code: ErrorCode.PERMISSION_NOT_GRANTABLE } });
    expect(replaceForRole).not.toHaveBeenCalled();

    await expect(
      service.replaceRolePermissions('PHARMACY_MANAGER', ['product:read', 'user:read'], ADMIN),
    ).resolves.toMatchObject({ permissionCodes: ['product:read', 'user:read'] });
    expect(replaceForRole).toHaveBeenCalledTimes(1);
    // Người ghi nhận là người gọi, không phải id hệ thống hay giá trị rỗng.
    expect(replaceForRole).toHaveBeenCalledWith(expect.anything(), 'role-pm', expect.any(Array), 'admin-1');
  });
});

describe('PermissionService — cache quyền theo vai trò', () => {
  function makeCachedService(granted: { current: string[] }) {
    const findOne = jest
      .fn()
      .mockImplementation(({ code }: { code: string }) => Promise.resolve({ ...PHARMACY_MANAGER_ROLE, code }));
    const findGrantedCodes = jest.fn().mockImplementation(() => Promise.resolve([...granted.current]));
    const service = makeService({
      roles: { findOne },
      permissions: {
        findAllOrdered: jest.fn().mockResolvedValue(PERMISSION_CODES.map((code) => ({ id: `id:${code}`, code }))),
      },
      rolePermissions: { findGrantedCodes, replaceForRole: jest.fn().mockResolvedValue(undefined) },
    });
    return { service, findGrantedCodes };
  }

  it('đọc DB một lần cho nhiều request cùng vai trò', async () => {
    const { service, findGrantedCodes } = makeCachedService({ current: ['product:read'] });

    await service.getGrantedCodes('SALES_STAFF');
    await expect(service.getGrantedCodes('SALES_STAFF')).resolves.toEqual(new Set(['product:read']));

    expect(findGrantedCodes).toHaveBeenCalledTimes(1);
  });

  it('caller sửa Set nhận được cũng không làm bẩn cache', async () => {
    const { service } = makeCachedService({ current: ['product:read'] });

    (await service.getGrantedCodes('SALES_STAFF')).add('branch:delete');

    await expect(service.getGrantedCodes('SALES_STAFF')).resolves.toEqual(new Set(['product:read']));
  });

  it('sửa ma trận xong thì lần đọc sau thấy quyền mới, không đợi hết TTL', async () => {
    const granted = { current: ['product:read'] };
    const { service } = makeCachedService(granted);
    await service.getGrantedCodes('PHARMACY_MANAGER');

    granted.current = ['product:read', 'user:read'];
    await service.replaceRolePermissions('PHARMACY_MANAGER', ['product:read', 'user:read'], SUPER_ADMIN);

    await expect(service.getGrantedCodes('PHARMACY_MANAGER')).resolves.toEqual(new Set(['product:read', 'user:read']));
  });

  it('hết TTL thì đọc lại DB — phòng khi ma trận bị sửa từ tiến trình khác (script seed)', async () => {
    jest.useFakeTimers();
    try {
      const { service, findGrantedCodes } = makeCachedService({ current: ['product:read'] });
      await service.getGrantedCodes('SALES_STAFF');

      jest.advanceTimersByTime(31_000);
      await service.getGrantedCodes('SALES_STAFF');

      expect(findGrantedCodes).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });
});
