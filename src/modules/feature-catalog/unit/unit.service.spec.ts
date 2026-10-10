import { Prisma } from '@prisma/client';
import { ErrorCode } from 'src/common/types/error-code';
import { UnitService } from './unit.service';

function makeService(repositoryOverrides: Record<string, jest.Mock> = {}) {
  const repository = {
    findOne: jest.fn(),
    findManyWithPagination: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    softDelete: jest.fn(),
    countBaseProducts: jest.fn().mockResolvedValue(0),
    countProductUnits: jest.fn().mockResolvedValue(0),
    ...repositoryOverrides,
  } as never;
  return new UnitService(repository);
}

function duplicateError(target = 'code'): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('duplicate', {
    code: 'P2002',
    clientVersion: '6.19.3',
    meta: { target: [target] },
  });
}

describe('UnitService — danh sách', () => {
  it('truyền đúng phân trang và trường tìm kiếm', async () => {
    const findManyWithPagination = jest
      .fn()
      .mockResolvedValue({ hits: [], total: 0, page: 1, totalPages: 0, limit: 10 });
    const service = makeService({ findManyWithPagination });

    await service.list({ page: 1, limit: 10, search: 'VIEN' });

    expect(findManyWithPagination).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ search: 'VIEN', searchFields: ['code', 'name'] }),
    );
  });
});

describe('UnitService — chi tiết', () => {
  it('không tồn tại thì báo RECORD_NOT_FOUND', async () => {
    const service = makeService({ findOne: jest.fn().mockResolvedValue(null) });

    await expect(service.getDetail('khong-co')).rejects.toMatchObject({ errorCode: ErrorCode.RECORD_NOT_FOUND });
  });
});

describe('UnitService — tạo', () => {
  it('gán createdBy và note mặc định null', async () => {
    const create = jest.fn().mockImplementation((data: unknown) => Promise.resolve(data));
    const service = makeService({ create });

    await service.create({ code: 'VIEN', name: 'Viên' } as never, 'caller-id');

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'VIEN', name: 'Viên', note: null, createdBy: 'caller-id' }),
    );
  });

  it('trùng code thì báo DUPLICATE_CODE', async () => {
    const service = makeService({ create: jest.fn().mockRejectedValue(duplicateError()) });

    await expect(service.create({ code: 'VIEN', name: 'Viên' } as never, 'caller-id')).rejects.toMatchObject({
      errorCode: ErrorCode.DUPLICATE_CODE,
    });
  });
});

describe('UnitService — cập nhật', () => {
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

    await service.update('id', { name: 'Viên nén' } as never, 'caller-id');

    expect(payload).toEqual({ name: 'Viên nén', updatedBy: 'caller-id' });
  });

  it('gửi null để xoá note', async () => {
    let payload: Record<string, unknown> | undefined;
    const update = jest.fn().mockImplementation((_filter: unknown, data: Record<string, unknown>) => {
      payload = data;
      return Promise.resolve({ id: 'id' });
    });
    const service = makeService({ findOne: jest.fn().mockResolvedValue({ id: 'id' }), update });

    await service.update('id', { note: null } as never, 'caller-id');

    expect(payload).toEqual({ note: null, updatedBy: 'caller-id' });
  });

  it('không tồn tại thì báo RECORD_NOT_FOUND', async () => {
    const service = makeService({ findOne: jest.fn().mockResolvedValue(null) });

    await expect(service.update('id', { name: 'X' } as never, 'caller-id')).rejects.toMatchObject({
      errorCode: ErrorCode.RECORD_NOT_FOUND,
    });
  });
});

describe('UnitService — xoá', () => {
  it('đang là đơn vị cơ bản của sản phẩm thì báo INVALID_REFERENCE và không xoá', async () => {
    const softDelete = jest.fn();
    const service = makeService({
      findOne: jest.fn().mockResolvedValue({ id: 'id' }),
      countBaseProducts: jest.fn().mockResolvedValue(2),
      softDelete,
    });

    await expect(service.remove('id')).rejects.toMatchObject({ errorCode: ErrorCode.INVALID_REFERENCE });
    expect(softDelete).not.toHaveBeenCalled();
  });

  it('chỉ xuất hiện trong cấu hình đơn vị bán thì vẫn bị chặn', async () => {
    const softDelete = jest.fn();
    const service = makeService({
      findOne: jest.fn().mockResolvedValue({ id: 'id' }),
      countProductUnits: jest.fn().mockResolvedValue(1),
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
