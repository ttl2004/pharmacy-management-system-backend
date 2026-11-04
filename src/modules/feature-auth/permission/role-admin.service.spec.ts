import { AuthRole } from 'src/common/types/common.enum';
import { actorOf, entriesOf } from 'src/test-support/audit-harness';
import type { JwtUser } from '../authz/types/authz.types';
import { RoleAdminService } from './role-admin.service';

const ADMIN: JwtUser = {
  userId: 'admin-1',
  sid: 's',
  email: null,
  role: AuthRole.ADMIN,
  branchId: null,
  roleLevel: 80,
};
const audit = { record: jest.fn() };
beforeEach(() => audit.record.mockClear());

function makeService(tx: Record<string, unknown>, prismaExtra: Record<string, unknown> = {}) {
  const prisma = {
    $transaction: jest.fn((work: (t: unknown) => unknown) => work(tx)),
    role: { findUnique: jest.fn().mockResolvedValue(null) },
    user: { count: jest.fn().mockResolvedValue(0) },
    ...prismaExtra,
  };
  const permissionService = {
    resolvePermissionIds: jest.fn().mockResolvedValue(['p1', 'p2']),
    clearGrantCache: jest.fn(),
    requireRole: jest
      .fn()
      .mockResolvedValue({ id: 'role-1', code: 'THU_KHO', name: 'Thủ kho', level: 50, isSystem: false }),
  };
  return new RoleAdminService({} as never, {} as never, prisma as never, permissionService as never, audit as never);
}

describe('RoleAdminService — nhật ký', () => {
  it('createRole ghi ROLE.CREATED (branchIds [], nhãn = mã vai trò, quyền được cấp trong metadata)', async () => {
    const tx = {
      role: {
        create: jest.fn().mockResolvedValue({
          id: 'role-1',
          code: 'THU_KHO',
          name: 'Thủ kho',
          description: null,
          level: 50,
          isSystem: false,
          createdAt: new Date(),
        }),
      },
      rolePermission: { createMany: jest.fn() },
    };
    const service = makeService(tx);

    await service.createRole(
      { name: 'Thủ kho', level: 50, permissionCodes: ['user:read', 'product:read'] },
      actorOf(ADMIN),
    );

    expect(entriesOf(audit)).toEqual([
      {
        event: 'ROLE.CREATED',
        entityType: 'roles',
        entityId: 'role-1',
        entityLabel: 'THU_KHO',
        branchIds: [],
        searchTerms: ['THU_KHO', 'Thủ kho'],
        after: { code: 'THU_KHO', name: 'Thủ kho', description: null, level: 50 },
        metadata: { permissionCodes: ['product:read', 'user:read'] },
      },
    ]);
  });

  it('deleteRole ghi ROLE.DELETED với reason tuỳ chọn, mã gốc (không phải mã _DEL_)', async () => {
    const tx = { rolePermission: { deleteMany: jest.fn() }, role: { update: jest.fn() } };
    const service = makeService(tx);

    await service.deleteRole('THU_KHO', actorOf(ADMIN), 'Không còn dùng');

    expect(entriesOf(audit)).toEqual([
      {
        event: 'ROLE.DELETED',
        entityType: 'roles',
        entityId: 'role-1',
        entityLabel: 'THU_KHO',
        branchIds: [],
        searchTerms: ['THU_KHO', 'Thủ kho'],
        before: { code: 'THU_KHO', name: 'Thủ kho', level: 50 },
        reason: 'Không còn dùng',
      },
    ]);
  });

  it('deleteRole không có reason vẫn ghi', async () => {
    const tx = { rolePermission: { deleteMany: jest.fn() }, role: { update: jest.fn() } };
    const service = makeService(tx);

    await service.deleteRole('THU_KHO', actorOf(ADMIN));

    expect(entriesOf(audit)[0]).toMatchObject({ event: 'ROLE.DELETED', reason: null });
  });
});
