import { isStaffRole } from './staff-role';

describe('isStaffRole', () => {
  it('CUSTOMER không phải nhân viên', () => expect(isStaffRole('CUSTOMER')).toBe(false));
  it('PHARMACY_MANAGER, KHO_TONG là nhân viên', () => {
    expect(isStaffRole('PHARMACY_MANAGER')).toBe(true);
    expect(isStaffRole('KHO_TONG')).toBe(true);
  });
  it('không rõ vai trò → coi là nhân viên (ghi thừa)', () => {
    expect(isStaffRole(undefined)).toBe(true);
    expect(isStaffRole(null)).toBe(true);
  });
});
