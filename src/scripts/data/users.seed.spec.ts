import { SEED_BRANCHES } from './catalog.seed';
import { SEED_USERS } from './users.seed';

describe('Dữ liệu mẫu tài khoản', () => {
  it('có đúng 3 tài khoản, không có SUPER_ADMIN và không có CUSTOMER', () => {
    expect(SEED_USERS).toHaveLength(3);
    const roles = SEED_USERS.map((user) => user.roleCode);
    expect(roles).not.toContain('SUPER_ADMIN');
    expect(roles).not.toContain('CUSTOMER');
  });

  it('username, SĐT và email không trùng nhau', () => {
    expect(new Set(SEED_USERS.map((u) => u.username)).size).toBe(3);
    expect(new Set(SEED_USERS.map((u) => u.phoneNumber)).size).toBe(3);
    expect(new Set(SEED_USERS.map((u) => u.email)).size).toBe(3);
  });

  it('tuân luật 10: ADMIN có branchCode null, hai vai trò nhân viên thì có', () => {
    for (const user of SEED_USERS) {
      if (user.roleCode === 'ADMIN') {
        expect(user.branchCode).toBeNull();
      } else {
        expect(user.branchCode).not.toBeNull();
      }
    }
  });

  it('mọi branchCode đều tồn tại trong SEED_BRANCHES', () => {
    const codes = new Set(SEED_BRANCHES.map((branch) => branch.code));
    for (const user of SEED_USERS) {
      if (user.branchCode) expect(codes.has(user.branchCode)).toBe(true);
    }
  });

  it('mật khẩu dài 8–72 ký tự', () => {
    for (const user of SEED_USERS) {
      expect(user.password.length).toBeGreaterThanOrEqual(8);
      expect(Buffer.byteLength(user.password, 'utf8')).toBeLessThanOrEqual(72);
    }
  });
});
