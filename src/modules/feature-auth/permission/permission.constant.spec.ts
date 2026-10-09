import { AuthRole } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';
import { PERMISSION_CODES } from './permission.constant';
import { DEFAULT_ROLE_GRANTS } from './role.constant';

describe('Danh mục quyền module user', () => {
  it('có đủ 5 mã quyền của module user', () => {
    const userCodes = PERMISSION_CODES.filter((code) => code.startsWith('user:'));
    expect([...userCodes].sort()).toEqual([
      'user:create',
      'user:delete',
      'user:read',
      'user:role:update',
      'user:update',
    ]);
  });

  it('ADMIN được cấp đọc/sửa/xoá người dùng nhưng KHÔNG được tạo', () => {
    const granted = DEFAULT_ROLE_GRANTS[AuthRole.ADMIN] ?? [];
    expect(granted).toContain('user:read');
    expect(granted).toContain('user:update');
    expect(granted).toContain('user:delete');
    expect(granted).not.toContain('user:create');
  });

  it('không vai trò nào được cấp user:create hay user:role:update', () => {
    const all = Object.values(DEFAULT_ROLE_GRANTS).flat();
    expect(all).not.toContain('user:create');
    expect(all).not.toContain('user:role:update');
  });

  it('nhóm mã lỗi 16xx có đủ 6 mã', () => {
    expect(ErrorCode.RECORD_NOT_FOUND).toBe(1600);
    expect(ErrorCode.DUPLICATE_CODE).toBe(1601);
    expect(ErrorCode.INVALID_REFERENCE).toBe(1602);
    expect(ErrorCode.ROLE_NOT_ASSIGNABLE).toBe(1603);
    expect(ErrorCode.SUPER_ADMIN_PROTECTED).toBe(1604);
    expect(ErrorCode.SELF_OPERATION_FORBIDDEN).toBe(1605);
  });
});
