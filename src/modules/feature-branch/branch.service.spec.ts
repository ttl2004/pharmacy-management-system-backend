import { Prisma, RecordStatus } from '@prisma/client';
import { ErrorCode } from 'src/common/types/error-code';
import { BranchService } from './branch.service';

function makeService(repositoryOverrides: Record<string, jest.Mock> = {}) {
  const repository = {
    findOne: jest.fn(),
    findManyWithPagination: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    softDelete: jest.fn(),
    countReferencingUsers: jest.fn().mockResolvedValue(0),
    ...repositoryOverrides,
  } as never;
  return new BranchService(repository);
}

function duplicateError(target = 'code'): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('duplicate', {
    code: 'P2002',
    clientVersion: '6.19.3',
    meta: { target: [target] },
  });
}

describe('BranchService — danh sách', () => {
  it('truyền đúng filter trạng thái, phân trang và ba trường tìm kiếm', async () => {
    const findManyWithPagination = jest.fn().mockResolvedValue({
      hits: [],
      total: 0,
      page: 2,
      totalPages: 0,
      limit: 5,
    });
    const service = makeService({ findManyWithPagination });

    await service.list({ page: 2, limit: 5, status: RecordStatus.INACTIVE, search: 'CN' });

    expect(findManyWithPagination).toHaveBeenCalledWith(
      { status: RecordStatus.INACTIVE },
      expect.objectContaining({
        page: 2,
        limit: 5,
        search: 'CN',
        searchFields: ['code', 'name', 'phone'],
      }),
    );
  });

  it('không gửi trạng thái thì không lọc theo trạng thái', async () => {
    const findManyWithPagination = jest.fn().mockResolvedValue({
      hits: [],
      total: 0,
      page: 1,
      totalPages: 0,
      limit: 10,
    });
    const service = makeService({ findManyWithPagination });

    await service.list({ page: 1, limit: 10 });

    expect(findManyWithPagination).toHaveBeenCalledWith({}, expect.anything());
  });
});

describe('BranchService — chi tiết', () => {
  it('không tồn tại thì báo RECORD_NOT_FOUND', async () => {
    const service = makeService({ findOne: jest.fn().mockResolvedValue(null) });

    await expect(service.getDetail('khong-co')).rejects.toMatchObject({
      errorCode: ErrorCode.RECORD_NOT_FOUND,
    });
  });
});

describe('BranchService — tạo', () => {
  it('gán createdBy và mặc định trạng thái ACTIVE', async () => {
    const create = jest.fn().mockImplementation((data: unknown) => Promise.resolve(data));
    const service = makeService({ create });

    await service.create({ code: 'CN004', name: 'Quận 7', phone: '0900000004', address: 'Quận 7' } as never, 'caller-id');

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'CN004',
        status: RecordStatus.ACTIVE,
        createdBy: 'caller-id',
      }),
    );
  });

  it('trùng code thì báo DUPLICATE_CODE', async () => {
    const service = makeService({ create: jest.fn().mockRejectedValue(duplicateError()) });

    await expect(
      service.create({ code: 'CN001', name: 'X', phone: '0900000001', address: 'Y' } as never, 'caller-id'),
    ).rejects.toMatchObject({ errorCode: ErrorCode.DUPLICATE_CODE });
  });
});

describe('BranchService — cập nhật', () => {
  it('body rỗng thì báo HTTP_BAD_REQUEST', async () => {
    const service = makeService({});

    await expect(service.update('id', {}, 'caller-id')).rejects.toMatchObject({
      errorCode: ErrorCode.HTTP_BAD_REQUEST,
    });
  });

  it('chỉ ghi trường client thực sự gửi và gán updatedBy', async () => {
    let payload: Record<string, unknown> | undefined;
    const update = jest.fn().mockImplementation((_filter: unknown, data: Record<string, unknown>) => {
      payload = data;
      return Promise.resolve({ id: 'id' });
    });
    const service = makeService({ update });

    await service.update('id', { phone: '0900000099' } as never, 'caller-id');

    expect(payload).toEqual({ phone: '0900000099', updatedBy: 'caller-id' });
  });

  it('gửi null để xoá email và giờ mở cửa', async () => {
    let payload: Record<string, unknown> | undefined;
    const update = jest.fn().mockImplementation((_filter: unknown, data: Record<string, unknown>) => {
      payload = data;
      return Promise.resolve({ id: 'id' });
    });
    const service = makeService({ update });

    await service.update('id', { email: null, openingHours: null } as never, 'caller-id');

    expect(payload).toEqual({ email: null, openingHours: null, updatedBy: 'caller-id' });
  });

  it('không tồn tại thì báo RECORD_NOT_FOUND', async () => {
    const service = makeService({ update: jest.fn().mockResolvedValue(null) });

    await expect(service.update('id', { name: 'X' } as never, 'caller-id')).rejects.toMatchObject({
      errorCode: ErrorCode.RECORD_NOT_FOUND,
    });
  });

  it('trùng code thì báo DUPLICATE_CODE', async () => {
    const service = makeService({ update: jest.fn().mockRejectedValue(duplicateError()) });

    await expect(service.update('id', { code: 'CN001' } as never, 'caller-id')).rejects.toMatchObject({
      errorCode: ErrorCode.DUPLICATE_CODE,
    });
  });
});

describe('BranchService — xoá', () => {
  it('còn người dùng tham chiếu thì báo INVALID_REFERENCE và không xoá', async () => {
    const softDelete = jest.fn();
    const service = makeService({
      findOne: jest.fn().mockResolvedValue({ id: 'id' }),
      countReferencingUsers: jest.fn().mockResolvedValue(2),
      softDelete,
    });

    await expect(service.remove('id')).rejects.toMatchObject({ errorCode: ErrorCode.INVALID_REFERENCE });
    expect(softDelete).not.toHaveBeenCalled();
  });

  it('không tồn tại thì báo RECORD_NOT_FOUND', async () => {
    const service = makeService({ findOne: jest.fn().mockResolvedValue(null) });

    await expect(service.remove('id')).rejects.toMatchObject({ errorCode: ErrorCode.RECORD_NOT_FOUND });
  });

  it('hợp lệ thì xoá mềm và trả success', async () => {
    const softDelete = jest.fn().mockResolvedValue(true);
    const service = makeService({ findOne: jest.fn().mockResolvedValue({ id: 'id' }), softDelete });

    await expect(service.remove('id')).resolves.toEqual({ success: true });
    expect(softDelete).toHaveBeenCalledWith({ id: 'id' });
  });
});
