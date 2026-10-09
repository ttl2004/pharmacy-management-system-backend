import { ErrorCode } from 'src/common/types/error-code';
import { UserService } from './user.service';

/**
 * Repository giả — chỉ cắm đúng những method mà service gọi.
 * `findByIdWithRole` có mặc định vì gần như mọi luật bảo vệ đều tra vai trò của bản ghi đích trước.
 */
function makeService(
  repositoryOverrides: Record<string, jest.Mock> = {},
  sessionOverrides: Record<string, jest.Mock> = {},
) {
  const repository = {
    findRoleIdByCode: jest.fn(),
    findByIdWithRole: jest.fn().mockResolvedValue({ id: 'target', role: { code: 'SALES_STAFF' } }),
    ...repositoryOverrides,
  } as never;
  const prisma = { role: { findFirst: jest.fn() }, branch: { findFirst: jest.fn() } } as never;
  const transactions = { write: jest.fn((work: (tx: unknown) => unknown) => work({})) } as never;
  const sessions = {
    revokeAllByUser: jest.fn().mockResolvedValue(undefined),
    ...sessionOverrides,
  } as never;
  return new UserService(repository, prisma, transactions, sessions);
}

describe('UserService — danh sách người dùng', () => {
  it('không truyền roleCode thì không lọc theo vai trò', async () => {
    const findManyWithPagination = jest.fn().mockResolvedValue({
      hits: [],
      total: 0,
      page: 1,
      totalPages: 0,
      limit: 10,
    });
    const service = makeService({ findManyWithPagination });
    await service.list({ page: 1, limit: 10 });
    expect(findManyWithPagination).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ searchFields: ['phoneNumber', 'fullName', 'email'] }),
    );
  });
});

describe('UserService — tạo người dùng', () => {
  const baseDto = {
    fullName: 'Nguyễn Văn A',
    phoneNumber: '0987654321',
    roleCode: 'SALES_STAFF',
    branchId: '11111111-1111-4111-8111-111111111111',
  };

  it('từ chối khi chỉ có username mà thiếu password', async () => {
    const service = makeService({});
    await expect(service.create({ ...baseDto, username: 'abc' } as never, 'caller-id')).rejects.toMatchObject(
      { errorCode: ErrorCode.HTTP_BAD_REQUEST },
    );
  });

  it('từ chối khi chỉ có password mà thiếu username', async () => {
    const service = makeService({});
    await expect(
      service.create({ ...baseDto, password: 'Abc@12345' } as never, 'caller-id'),
    ).rejects.toMatchObject({ errorCode: ErrorCode.HTTP_BAD_REQUEST });
  });
});

describe('UserService — sửa người dùng', () => {
  it('chặn tự đổi status của chính mình (1605)', async () => {
    const service = makeService({});
    jest.spyOn(service, 'assertNotSuperAdminTarget').mockResolvedValue(undefined);
    await expect(service.update('me-id', { status: 'INACTIVE' } as never, 'me-id')).rejects.toMatchObject({
      errorCode: ErrorCode.SELF_OPERATION_FORBIDDEN,
    });
  });

  it('vẫn cho tự sửa hồ sơ thường', async () => {
    const update = jest.fn().mockResolvedValue({ id: 'me-id', fullName: 'Tên mới' });
    const service = makeService({ update });
    jest.spyOn(service, 'assertNotSuperAdminTarget').mockResolvedValue(undefined);
    await expect(service.update('me-id', { fullName: 'Tên mới' } as never, 'me-id')).resolves.toBeDefined();
    expect(update).toHaveBeenCalled();
  });

  it('SUPER_ADMIN tự sửa chính mình vẫn bị chặn (1604)', async () => {
    // Luật 14 đứng trước luật 15, nên chính chủ cũng không sửa được tài khoản tối cao.
    const service = makeService({
      findByIdWithRole: jest.fn().mockResolvedValue({ id: 'sa-id', role: { code: 'SUPER_ADMIN' } }),
    });
    await expect(service.update('sa-id', { fullName: 'Tên mới' } as never, 'sa-id')).rejects.toMatchObject({
      errorCode: ErrorCode.SUPER_ADMIN_PROTECTED,
    });
  });

  it('gửi branchId null cho vai trò bắt buộc có chi nhánh thì bị từ chối (1602)', async () => {
    const service = makeService({
      findByIdWithRole: jest.fn().mockResolvedValue({ id: 'pm-id', role: { code: 'PHARMACY_MANAGER' } }),
    });
    jest.spyOn(service, 'assertNotSuperAdminTarget').mockResolvedValue(undefined);
    await expect(service.update('pm-id', { branchId: null } as never, 'caller-id')).rejects.toMatchObject({
      errorCode: ErrorCode.INVALID_REFERENCE,
    });
  });

  it('không gửi branchId thì giữ nguyên chi nhánh cũ, không kiểm luật 10', async () => {
    const update = jest.fn().mockResolvedValue({ id: 'pm-id' });
    const service = makeService({
      findByIdWithRole: jest.fn().mockResolvedValue({ id: 'pm-id', role: { code: 'PHARMACY_MANAGER' } }),
      update,
    });
    jest.spyOn(service, 'assertNotSuperAdminTarget').mockResolvedValue(undefined);
    await expect(service.update('pm-id', { fullName: 'Tên mới' } as never, 'caller-id')).resolves.toBeDefined();
    expect(update.mock.calls[0][1]).not.toHaveProperty('branchId');
  });
});
