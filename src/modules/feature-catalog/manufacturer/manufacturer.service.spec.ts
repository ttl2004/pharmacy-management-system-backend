import { Prisma, RecordStatus } from '@prisma/client';
import { ErrorCode } from 'src/common/types/error-code';
import { ManufacturerService } from './manufacturer.service';

function makeService(repositoryOverrides: Record<string, jest.Mock> = {}) {
  const repository = {
    findOne: jest.fn(),
    findManyWithPagination: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    softDelete: jest.fn(),
    countProducts: jest.fn().mockResolvedValue(0),
    ...repositoryOverrides,
  } as never;
  return new ManufacturerService(repository);
}

function duplicateError(target = 'code'): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('duplicate', {
    code: 'P2002',
    clientVersion: '6.19.3',
    meta: { target: [target] },
  });
}

describe('ManufacturerService — danh sách', () => {
  it('truyền đúng filter trạng thái, phân trang và trường tìm kiếm', async () => {
    const findManyWithPagination = jest
      .fn()
      .mockResolvedValue({ hits: [], total: 0, page: 1, totalPages: 0, limit: 10 });
    const service = makeService({ findManyWithPagination });

    await service.list({ page: 1, limit: 10, status: RecordStatus.ACTIVE, search: 'DHG' });

    expect(findManyWithPagination).toHaveBeenCalledWith(
      { status: RecordStatus.ACTIVE },
      expect.objectContaining({ search: 'DHG', searchFields: ['code', 'name', 'country'] }),
    );
  });
});

describe('ManufacturerService — chi tiết', () => {
  it('không tồn tại thì báo RECORD_NOT_FOUND', async () => {
    const service = makeService({ findOne: jest.fn().mockResolvedValue(null) });

    await expect(service.getDetail('khong-co')).rejects.toMatchObject({ errorCode: ErrorCode.RECORD_NOT_FOUND });
  });
});

describe('ManufacturerService — tạo', () => {
  it('gán createdBy, mặc định ACTIVE và các trường nullable là null', async () => {
    const create = jest.fn().mockImplementation((data: unknown) => Promise.resolve(data));
    const service = makeService({ create });

    await service.create({ name: 'Dược Hậu Giang' } as never, 'caller-id');

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Dược Hậu Giang',
        code: null,
        country: null,
        address: null,
        note: null,
        status: RecordStatus.ACTIVE,
        createdBy: 'caller-id',
      }),
    );
  });

  it('trùng code thì báo DUPLICATE_CODE', async () => {
    const service = makeService({ create: jest.fn().mockRejectedValue(duplicateError()) });

    await expect(service.create({ name: 'X', code: 'DHG' } as never, 'caller-id')).rejects.toMatchObject({
      errorCode: ErrorCode.DUPLICATE_CODE,
    });
  });
});

describe('ManufacturerService — cập nhật', () => {
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
    const service = makeService({ findOne: jest.fn().mockResolvedValue({ id: 'id' }), update });

    await service.update('id', { country: 'Việt Nam' } as never, 'caller-id');

    expect(payload).toEqual({ country: 'Việt Nam', updatedBy: 'caller-id' });
  });

  it('gửi null để xoá country/address/note', async () => {
    let payload: Record<string, unknown> | undefined;
    const update = jest.fn().mockImplementation((_filter: unknown, data: Record<string, unknown>) => {
      payload = data;
      return Promise.resolve({ id: 'id' });
    });
    const service = makeService({ findOne: jest.fn().mockResolvedValue({ id: 'id' }), update });

    await service.update('id', { country: null, address: null, note: null } as never, 'caller-id');

    expect(payload).toEqual({ country: null, address: null, note: null, updatedBy: 'caller-id' });
  });

  it('không tồn tại thì báo RECORD_NOT_FOUND', async () => {
    const service = makeService({ findOne: jest.fn().mockResolvedValue(null) });

    await expect(service.update('id', { name: 'X' } as never, 'caller-id')).rejects.toMatchObject({
      errorCode: ErrorCode.RECORD_NOT_FOUND,
    });
  });

  it('trùng code thì báo DUPLICATE_CODE', async () => {
    const service = makeService({
      findOne: jest.fn().mockResolvedValue({ id: 'id' }),
      update: jest.fn().mockRejectedValue(duplicateError()),
    });

    await expect(service.update('id', { code: 'DHG' } as never, 'caller-id')).rejects.toMatchObject({
      errorCode: ErrorCode.DUPLICATE_CODE,
    });
  });
});

describe('ManufacturerService — xoá', () => {
  it('còn sản phẩm tham chiếu thì báo INVALID_REFERENCE và không xoá', async () => {
    const softDelete = jest.fn();
    const service = makeService({
      findOne: jest.fn().mockResolvedValue({ id: 'id' }),
      countProducts: jest.fn().mockResolvedValue(1),
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
