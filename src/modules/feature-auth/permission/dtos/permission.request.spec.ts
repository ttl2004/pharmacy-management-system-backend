import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AssignRoleRequest, ReplaceRolePermissionsRequest } from './permission.request';

async function errorsOf<T extends object>(cls: new () => T, plain: object): Promise<string[]> {
  const errors = await validate(plainToInstance(cls, plain));
  return errors.map((e) => e.property);
}

describe('permission.request — reason bắt buộc (D9)', () => {
  it('assignRole thiếu reason → lỗi validate', async () => {
    expect(await errorsOf(AssignRoleRequest, { roleCode: 'SALES_STAFF' })).toContain('reason');
  });

  it('assignRole reason rỗng hoặc dài quá 500 ký tự → lỗi validate', async () => {
    expect(await errorsOf(AssignRoleRequest, { roleCode: 'X', reason: '' })).toContain('reason');
    expect(await errorsOf(AssignRoleRequest, { roleCode: 'X', reason: 'a'.repeat(501) })).toContain('reason');
  });

  it('assignRole đủ reason → hợp lệ', async () => {
    expect(await errorsOf(AssignRoleRequest, { roleCode: 'X', reason: 'Thăng chức' })).toEqual([]);
  });

  it('replaceRolePermissions thiếu reason → lỗi validate', async () => {
    expect(await errorsOf(ReplaceRolePermissionsRequest, { permissionCodes: [] })).toContain('reason');
  });

  it('replaceRolePermissions đủ reason → hợp lệ', async () => {
    expect(await errorsOf(ReplaceRolePermissionsRequest, { permissionCodes: [], reason: 'Thu hẹp quyền' })).toEqual([]);
  });
});
