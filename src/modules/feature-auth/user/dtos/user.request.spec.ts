import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateUserRequest, UpdateUserRequest } from './user.request';

/** Dùng đúng tuỳ chọn mà ValidationPipe toàn cục trong main.ts dùng. */
async function errorsFor(payload: Record<string, unknown>) {
  const dto = plainToInstance(UpdateUserRequest, payload);
  return validate(dto, { whitelist: true, forbidNonWhitelisted: true });
}

describe('UpdateUserRequest', () => {
  it('cho phép body rỗng — PATCH không bắt buộc gửi trường nào', async () => {
    expect(await errorsFor({})).toHaveLength(0);
  });

  it('từ chối status: null tường minh — cột enum là NOT NULL', async () => {
    const errors = await errorsFor({ status: null });
    expect(errors.map((e) => e.property)).toContain('status');
  });

  it('từ chối phoneNumber: null tường minh — SĐT là định danh gốc, không được xoá', async () => {
    const errors = await errorsFor({ phoneNumber: null });
    expect(errors.map((e) => e.property)).toContain('phoneNumber');
  });

  it('vẫn cho phép null với trường được phép xoá', async () => {
    expect(await errorsFor({ email: null, address: null, gender: null, dateOfBirth: null })).toHaveLength(0);
  });

  it('từ chối các trường không sửa được qua route này', async () => {
    // roleCode đổi qua PATCH /permission/users/:id/role; username/password qua /auth.
    // Quảng cáo chúng trên Swagger rồi bỏ qua im lặng là footgun — người gọi tưởng đã đổi được.
    const errors = await errorsFor({
      roleCode: 'ADMIN',
      username: 'abc',
      password: 'Abc@12345',
    });
    expect(errors.map((e) => e.property).sort()).toEqual(['password', 'roleCode', 'username']);
  });
});

describe('CreateUserRequest — mật khẩu tài khoản tạo kèm', () => {
  const base = { phoneNumber: '0912345678', fullName: 'Nhân viên A', roleCode: 'SALES_STAFF', username: 'nva' };
  const passwordErrors = async (password: unknown) => {
    const dto = plainToInstance(CreateUserRequest, { ...base, password });
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    return errors.filter((e) => e.property === 'password');
  };

  it('từ chối mật khẩu dưới 8 ký tự (cùng luật với đổi mật khẩu)', async () => {
    expect(await passwordErrors('1')).toHaveLength(1);
    expect(await passwordErrors('Abc@123')).toHaveLength(1);
  });

  it('từ chối mật khẩu quá 72 ký tự (bcrypt cắt bỏ phần dư)', async () => {
    expect(await passwordErrors('a'.repeat(73))).toHaveLength(1);
  });

  it('chấp nhận mật khẩu 8–72 ký tự', async () => {
    expect(await passwordErrors('Abc@1234')).toHaveLength(0);
    expect(await passwordErrors('a'.repeat(72))).toHaveLength(0);
  });
});
