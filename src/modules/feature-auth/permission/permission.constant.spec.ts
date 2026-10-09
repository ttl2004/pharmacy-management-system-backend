import { AuthRole } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';
import { PERMISSION_CODES } from './permission.constant';
import { DEFAULT_ROLE_GRANTS } from './role.constant';

describe('Danh mục quyền và mã lỗi', () => {
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

  it('có đủ 4 mã quyền của module branch', () => {
    const branchCodes = PERMISSION_CODES.filter((code) => code.startsWith('branch:'));
    expect([...branchCodes].sort()).toEqual(['branch:create', 'branch:delete', 'branch:read', 'branch:update']);
  });

  it('ADMIN được cấp đủ 4 quyền chi nhánh', () => {
    const granted = DEFAULT_ROLE_GRANTS[AuthRole.ADMIN] ?? [];
    expect([...granted]).toEqual(
      expect.arrayContaining(['branch:read', 'branch:create', 'branch:update', 'branch:delete']),
    );
  });

  it('PHARMACY_MANAGER và SALES_STAFF chỉ được đọc chi nhánh', () => {
    for (const role of [AuthRole.PHARMACY_MANAGER, AuthRole.SALES_STAFF]) {
      const granted = DEFAULT_ROLE_GRANTS[role] ?? [];
      expect(granted).toContain('branch:read');
      expect(granted).not.toContain('branch:create');
      expect(granted).not.toContain('branch:update');
      expect(granted).not.toContain('branch:delete');
    }
  });

  it('CUSTOMER không có quyền chi nhánh nào', () => {
    const granted = DEFAULT_ROLE_GRANTS[AuthRole.CUSTOMER] ?? [];
    expect(granted.filter((code) => code.startsWith('branch:'))).toEqual([]);
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
