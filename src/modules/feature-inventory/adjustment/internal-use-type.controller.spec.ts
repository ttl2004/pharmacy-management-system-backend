import { AuthRole } from 'src/common/types/common.enum';
import { REQUIRED_PERMISSIONS } from '../../feature-auth/permission/decorators/require-permissions.decorator';
import { PERMISSION_CODES } from '../../feature-auth/permission/permission.constant';
import { DEFAULT_ROLE_GRANTS } from '../../feature-auth/permission/role.constant';
import { InternalUseTypeController } from './internal-use-type.controller';

const permissionsOf = (method: keyof InternalUseTypeController) =>
  Reflect.getMetadata(REQUIRED_PERMISSIONS, InternalUseTypeController.prototype[method]) as string[];

describe('InternalUseTypeController — quyền (S5)', () => {
  it('POST/PUT/DELETE /internal-use-type yêu cầu internal-use-type:manage; GET vẫn stock-adjustment:read', () => {
    expect(permissionsOf('list')).toEqual(['stock-adjustment:read']);
    for (const method of ['create', 'update', 'remove'] as const) {
      expect(permissionsOf(method)).toEqual(['internal-use-type:manage']);
    }
  });

  it('quyền internal-use-type:manage có trong danh mục; chỉ ADMIN được cấp (SUPER_ADMIN bỏ qua kiểm quyền)', () => {
    expect(PERMISSION_CODES).toContain('internal-use-type:manage');
    for (const [role, granted] of Object.entries(DEFAULT_ROLE_GRANTS)) {
      const has = (granted ?? []).includes('internal-use-type:manage' as never);
      expect([role, has]).toEqual([role, role === (AuthRole.ADMIN as string)]);
    }
  });
});
