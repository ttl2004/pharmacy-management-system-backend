import { validateEnv } from './env.validation';

const base = {
  DATABASE_URL: 'postgresql://u:p@h:5432/db',
  JWT_ACCESS_SECRET: 'x'.repeat(32),
};

describe('validateEnv', () => {
  it('biến optional để trống trong .env.example không làm chết ứng dụng', () => {
    // `dotenv` nạp dòng `SUPER_ADMIN_GENDER=` thành chuỗi rỗng, mà `.optional()` chỉ bỏ qua
    // `undefined` — nên nếu không chuẩn hoá, người dựng máy mới theo README sẽ không khởi động được.
    expect(() =>
      validateEnv({ ...base, SUPER_ADMIN_GENDER: '', SUPER_ADMIN_DATE_OF_BIRTH: '' }),
    ).not.toThrow();
  });

  it('giá trị rỗng được coi như không khai báo, không phải chuỗi rỗng', () => {
    const env = validateEnv({ ...base, SUPER_ADMIN_GENDER: '', SUPER_ADMIN_DATE_OF_BIRTH: '' });
    expect(env.SUPER_ADMIN_GENDER).toBeUndefined();
    expect(env.SUPER_ADMIN_DATE_OF_BIRTH).toBeUndefined();
  });

  it('giá trị sai vẫn bị từ chối', () => {
    expect(() => validateEnv({ ...base, SUPER_ADMIN_GENDER: 'male' })).toThrow(/SUPER_ADMIN_GENDER/);
  });

  it('biến bắt buộc để trống vẫn bị từ chối', () => {
    expect(() => validateEnv({ ...base, DATABASE_URL: '' })).toThrow(/DATABASE_URL/);
  });

  it('ô có giá trị mặc định nhận mặc định khi để trống', () => {
    const env = validateEnv({ ...base, SUPER_ADMIN_FULL_NAME: '' });
    expect(env.SUPER_ADMIN_FULL_NAME).toBe('Super Admin');
  });
});
