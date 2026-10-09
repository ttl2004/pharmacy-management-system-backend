import { SEED_BRANCHES } from './catalog.seed';

describe('Dữ liệu mẫu chi nhánh', () => {
  it('có đúng 3 chi nhánh', () => {
    expect(SEED_BRANCHES).toHaveLength(3);
  });

  it('mã chi nhánh không trùng nhau', () => {
    const codes = SEED_BRANCHES.map((branch) => branch.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('mọi trường bắt buộc đều có giá trị, không vượt độ dài cột', () => {
    for (const branch of SEED_BRANCHES) {
      expect(branch.code).toMatch(/^CN\d{3}$/);
      expect(branch.name.length).toBeGreaterThan(0);
      expect(branch.name.length).toBeLessThanOrEqual(200);
      expect(branch.phone.length).toBeLessThanOrEqual(20);
      expect(branch.address.length).toBeGreaterThan(0);
      expect(branch.openingHours.length).toBeLessThanOrEqual(100);
    }
  });
});
