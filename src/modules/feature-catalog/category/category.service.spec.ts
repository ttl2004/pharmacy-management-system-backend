import { Prisma, RecordStatus } from '@prisma/client';
import { ErrorCode } from 'src/common/types/error-code';
import { CategoryService } from './category.service';

function makeService(repositoryOverrides: Record<string, jest.Mock> = {}) {
  const repository = {
    findOne: jest.fn(),
    findManyWithPagination: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    softDelete: jest.fn(),
    countChildren: jest.fn().mockResolvedValue(0),
    countProducts: jest.fn().mockResolvedValue(0),
    isInSubtreeOf: jest.fn().mockResolvedValue(false),
    ...repositoryOverrides,
  } as never;
  return new CategoryService(repository);
}

function duplicateError(target = 'code'): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('duplicate', {
    code: 'P2002',
    clientVersion: '6.19.3',
    meta: { target: [target] },
  });
}

describe('CategoryService — danh sách', () => {
  it('truyền đúng filter cha/trạng thái, phân trang và trường tìm kiếm', async () => {
    const findManyWithPagination = jest
      .fn()
      .mockResolvedValue({ hits: [], total: 0, page: 1, totalPages: 0, limit: 10 });
    const service = makeService({ findManyWithPagination });

    await service.list({ page: 1, limit: 10, parentId: 'parent-id', status: RecordStatus.ACTIVE, search: 'THUOC' });

    expect(findManyWithPagination).toHaveBeenCalledWith(
      { parentId: 'parent-id', status: RecordStatus.ACTIVE },
      expect.objectContaining({ search: 'THUOC', searchFields: ['code', 'name'] }),
    );
  });

  it('không gửi bộ lọc thì không lọc gì', async () => {
    const findManyWithPagination = jest
      .fn()
      .mockResolvedValue({ hits: [], total: 0, page: 1, totalPages: 0, limit: 10 });
    const service = makeService({ findManyWithPagination });

    await service.list({ page: 1, limit: 10 });

    expect(findManyWithPagination).toHaveBeenCalledWith({}, expect.anything());
  });
});

describe('CategoryService — chi tiết', () => {
  it('không tồn tại thì báo RECORD_NOT_FOUND', async () => {
    const service = makeService({ findOne: jest.fn().mockResolvedValue(null) });

    await expect(service.getDetail('khong-co')).rejects.toMatchObject({ errorCode: ErrorCode.RECORD_NOT_FOUND });
  });

  it('trả kèm quan hệ cha', async () => {
    const detail = { id: 'id', parent: { id: 'parent-id' } };
    const findOne = jest.fn().mockResolvedValue(detail);
    const service = makeService({ findOne });

    await expect(service.getDetail('id')).resolves.toEqual(detail);
    expect(findOne).toHaveBeenCalledWith({ id: 'id' }, { relations: { parent: true } });
  });
});

describe('CategoryService — tạo', () => {
  it('gán createdBy, mặc định ACTIVE và sortOrder 0', async () => {
    const create = jest.fn().mockImplementation((data: unknown) => Promise.resolve(data));
    const service = makeService({ create });

    await service.create({ name: 'Thuốc kê đơn' } as never, 'caller-id');

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Thuốc kê đơn',
        code: null,
        parentId: null,
        sortOrder: 0,
        status: RecordStatus.ACTIVE,
        createdBy: 'caller-id',
      }),
    );
  });

  it('cha không tồn tại hoặc đã ngừng hoạt động thì báo INVALID_REFERENCE', async () => {
    const service = makeService({ findOne: jest.fn().mockResolvedValue(null) });

    await expect(service.create({ name: 'Con', parentId: 'parent-id' } as never, 'caller-id')).rejects.toMatchObject({
      errorCode: ErrorCode.INVALID_REFERENCE,
    });
  });

  it('cha hợp lệ thì tạo thành công', async () => {
    const create = jest.fn().mockImplementation((data: unknown) => Promise.resolve(data));
    const service = makeService({ findOne: jest.fn().mockResolvedValue({ id: 'parent-id' }), create });

    await service.create({ name: 'Con', parentId: 'parent-id' } as never, 'caller-id');

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ parentId: 'parent-id' }));
  });

  it('trùng code thì báo DUPLICATE_CODE', async () => {
    const service = makeService({ create: jest.fn().mockRejectedValue(duplicateError()) });

    await expect(service.create({ name: 'X', code: 'OTC' } as never, 'caller-id')).rejects.toMatchObject({
      errorCode: ErrorCode.DUPLICATE_CODE,
    });
  });
});

describe('CategoryService — cập nhật', () => {
  it('body rỗng thì báo HTTP_BAD_REQUEST', async () => {
    const service = makeService({});

    await expect(service.update('id', {}, 'caller-id')).rejects.toMatchObject({
      errorCode: ErrorCode.HTTP_BAD_REQUEST,
    });
  });

  it('không tồn tại thì báo RECORD_NOT_FOUND', async () => {
    const service = makeService({ findOne: jest.fn().mockResolvedValue(null) });

    await expect(service.update('id', { name: 'X' } as never, 'caller-id')).rejects.toMatchObject({
      errorCode: ErrorCode.RECORD_NOT_FOUND,
    });
  });

  it('chỉ ghi trường client thực sự gửi và gán updatedBy', async () => {
    let payload: Record<string, unknown> | undefined;
    const update = jest.fn().mockImplementation((_filter: unknown, data: Record<string, unknown>) => {
      payload = data;
      return Promise.resolve({ id: 'id' });
    });
    const service = makeService({ findOne: jest.fn().mockResolvedValue({ id: 'id' }), update });

    await service.update('id', { name: 'Tên mới' } as never, 'caller-id');

    expect(payload).toEqual({ name: 'Tên mới', updatedBy: 'caller-id' });
  });

  it('gửi parentId null để đưa về nhóm gốc', async () => {
    let payload: Record<string, unknown> | undefined;
    const update = jest.fn().mockImplementation((_filter: unknown, data: Record<string, unknown>) => {
      payload = data;
      return Promise.resolve({ id: 'id' });
    });
    const service = makeService({ findOne: jest.fn().mockResolvedValue({ id: 'id' }), update });

    await service.update('id', { parentId: null } as never, 'caller-id');

    expect(payload).toEqual({ parentId: null, updatedBy: 'caller-id' });
  });

  it('tự trỏ cha vào chính nó thì báo HTTP_BAD_REQUEST', async () => {
    const service = makeService({ findOne: jest.fn().mockResolvedValue({ id: 'id' }) });

    await expect(service.update('id', { parentId: 'id' } as never, 'caller-id')).rejects.toMatchObject({
      errorCode: ErrorCode.HTTP_BAD_REQUEST,
    });
  });

  it('chuyển vào nhánh con của chính nó thì báo HTTP_BAD_REQUEST', async () => {
    const service = makeService({
      findOne: jest.fn().mockResolvedValue({ id: 'id' }),
      isInSubtreeOf: jest.fn().mockResolvedValue(true),
    });

    await expect(service.update('id', { parentId: 'chau-id' } as never, 'caller-id')).rejects.toMatchObject({
      errorCode: ErrorCode.HTTP_BAD_REQUEST,
    });
  });

  it('cha mới không hợp lệ thì báo INVALID_REFERENCE', async () => {
    const findOne = jest.fn().mockResolvedValueOnce({ id: 'id' }).mockResolvedValueOnce(null);
    const service = makeService({ findOne });

    await expect(service.update('id', { parentId: 'parent-id' } as never, 'caller-id')).rejects.toMatchObject({
      errorCode: ErrorCode.INVALID_REFERENCE,
    });
  });

  it('trùng code thì báo DUPLICATE_CODE', async () => {
    const service = makeService({
      findOne: jest.fn().mockResolvedValue({ id: 'id' }),
      update: jest.fn().mockRejectedValue(duplicateError()),
    });

    await expect(service.update('id', { code: 'OTC' } as never, 'caller-id')).rejects.toMatchObject({
      errorCode: ErrorCode.DUPLICATE_CODE,
    });
  });
});

describe('CategoryService — xoá', () => {
  it('còn nhóm con thì báo INVALID_REFERENCE và không xoá', async () => {
    const softDelete = jest.fn();
    const service = makeService({
      findOne: jest.fn().mockResolvedValue({ id: 'id' }),
      countChildren: jest.fn().mockResolvedValue(1),
      softDelete,
    });

    await expect(service.remove('id')).rejects.toMatchObject({ errorCode: ErrorCode.INVALID_REFERENCE });
    expect(softDelete).not.toHaveBeenCalled();
  });

  it('còn sản phẩm tham chiếu thì báo INVALID_REFERENCE và không xoá', async () => {
    const softDelete = jest.fn();
    const service = makeService({
      findOne: jest.fn().mockResolvedValue({ id: 'id' }),
      countProducts: jest.fn().mockResolvedValue(3),
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
