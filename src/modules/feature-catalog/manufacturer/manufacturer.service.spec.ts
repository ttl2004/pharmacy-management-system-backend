import { Prisma, RecordStatus } from '@prisma/client';
import { ErrorCode } from 'src/common/types/error-code';
import { ADMIN_ACTOR, entriesOf, fakePrisma } from 'src/test-support/audit-harness';
import { ManufacturerService } from './manufacturer.service';

const audit = { record: jest.fn() };
beforeEach(() => audit.record.mockClear());

function makeService(repositoryOverrides: Record<string, jest.Mock> = {}) {
  const repository = {
    findOne: jest.fn().mockResolvedValue({ id: 'id' }),
    findManyWithPagination: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    softDelete: jest.fn(),
    countProducts: jest.fn().mockResolvedValue(0),
    ...repositoryOverrides,
  } as never;
  return new ManufacturerService(repository, fakePrisma() as never, audit as never);
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

    await service.create({ name: 'Dược Hậu Giang' } as never, ADMIN_ACTOR);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Dược Hậu Giang',
        code: null,
        country: null,
        address: null,
        note: null,
        status: RecordStatus.ACTIVE,
        createdBy: 'admin-1',
      }),
      expect.anything(),
    );
  });

  it('trùng code thì báo DUPLICATE_CODE', async () => {
    const service = makeService({ create: jest.fn().mockRejectedValue(duplicateError()) });

    await expect(service.create({ name: 'X', code: 'DHG' } as never, ADMIN_ACTOR)).rejects.toMatchObject({
      errorCode: ErrorCode.DUPLICATE_CODE,
    });
  });
});

describe('ManufacturerService — cập nhật', () => {
  it('body rỗng thì báo HTTP_BAD_REQUEST', async () => {
    const service = makeService({});

    await expect(service.update('id', {}, ADMIN_ACTOR)).rejects.toMatchObject({
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

    await service.update('id', { country: 'Việt Nam' } as never, ADMIN_ACTOR);

    expect(payload).toEqual({ country: 'Việt Nam', updatedBy: 'admin-1' });
  });

  it('gửi null để xoá country/address/note', async () => {
    let payload: Record<string, unknown> | undefined;
    const update = jest.fn().mockImplementation((_filter: unknown, data: Record<string, unknown>) => {
      payload = data;
      return Promise.resolve({ id: 'id' });
    });
    const service = makeService({ findOne: jest.fn().mockResolvedValue({ id: 'id' }), update });

    await service.update('id', { country: null, address: null, note: null } as never, ADMIN_ACTOR);

    expect(payload).toEqual({ country: null, address: null, note: null, updatedBy: 'admin-1' });
  });

  it('không tồn tại thì báo RECORD_NOT_FOUND', async () => {
    const service = makeService({ findOne: jest.fn().mockResolvedValue(null) });

    await expect(service.update('id', { name: 'X' } as never, ADMIN_ACTOR)).rejects.toMatchObject({
      errorCode: ErrorCode.RECORD_NOT_FOUND,
    });
  });

  it('trùng code thì báo DUPLICATE_CODE', async () => {
    const service = makeService({
      findOne: jest.fn().mockResolvedValue({ id: 'id' }),
      update: jest.fn().mockRejectedValue(duplicateError()),
    });

    await expect(service.update('id', { code: 'DHG' } as never, ADMIN_ACTOR)).rejects.toMatchObject({
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

    await expect(service.remove('id', ADMIN_ACTOR)).rejects.toMatchObject({ errorCode: ErrorCode.INVALID_REFERENCE });
    expect(softDelete).not.toHaveBeenCalled();
  });

  it('không tồn tại thì báo RECORD_NOT_FOUND', async () => {
    const service = makeService({ findOne: jest.fn().mockResolvedValue(null) });

    await expect(service.remove('id', ADMIN_ACTOR)).rejects.toMatchObject({ errorCode: ErrorCode.RECORD_NOT_FOUND });
  });

  it('hợp lệ thì xoá mềm và trả success', async () => {
    const softDelete = jest.fn().mockResolvedValue(true);
    const service = makeService({ findOne: jest.fn().mockResolvedValue({ id: 'id' }), softDelete });

    await expect(service.remove('id', ADMIN_ACTOR)).resolves.toEqual({ success: true });
    expect(softDelete).toHaveBeenCalledWith({ id: 'id' }, expect.anything());
  });
});

describe('ManufacturerService — nhật ký', () => {
  const created = (d: object) => Promise.resolve({ id: 'man-1', ...d });

  it('create ghi MANUFACTURER.CREATED, branchIds [] (danh mục toàn chuỗi), nhãn và searchTerms', async () => {
    const service = makeService({ create: jest.fn().mockImplementation(created) });

    await service.create({ code: 'DHG', name: 'Dược Hậu Giang' } as never, ADMIN_ACTOR);

    const [tx, actor] = audit.record.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(tx).toBeDefined();
    expect(actor).toMatchObject({ userId: 'admin-1', type: 'USER', ip: '10.0.0.1', requestId: 'req-1' });
    expect(entriesOf(audit)).toMatchObject([
      {
        event: 'MANUFACTURER.CREATED',
        entityType: 'manufacturers',
        entityId: 'man-1',
        entityLabel: 'DHG',
        branchIds: [],
        searchTerms: ['DHG', 'Dược Hậu Giang'],
      },
    ]);
  });

  it('create truyền tx của transaction xuống repository', async () => {
    const create = jest.fn().mockImplementation(created);
    const service = makeService({ create });

    await service.create({ code: 'DHG', name: 'Dược Hậu Giang' } as never, ADMIN_ACTOR);

    expect((create.mock.calls as unknown[][])[0][1]).toBe((audit.record.mock.calls[0] as unknown[])[0]);
  });

  it('update ghi MANUFACTURER.UPDATED kèm diff before/after', async () => {
    const service = makeService({
      findOne: jest.fn().mockResolvedValue({
        id: 'man-1',
        code: 'DHG',
        name: 'Tên cũ',
        country: null,
        address: null,
        note: null,
        status: 'ACTIVE',
      }),
      update: jest.fn().mockImplementation((_f: unknown, d: object) =>
        Promise.resolve({
          ...{ id: 'man-1', code: 'DHG', name: 'Tên cũ', country: null, address: null, note: null, status: 'ACTIVE' },
          ...d,
        }),
      ),
    });

    await service.update('man-1', { name: 'Tên mới' } as never, ADMIN_ACTOR);

    expect(entriesOf(audit)).toMatchObject([
      {
        event: 'MANUFACTURER.UPDATED',
        entityId: 'man-1',
        branchIds: [],
        before: { name: 'Tên cũ' },
        after: { name: 'Tên mới' },
      },
    ]);
  });

  it('update không đổi gì thì không ghi entry', async () => {
    const service = makeService({
      findOne: jest.fn().mockResolvedValue({
        id: 'man-1',
        code: 'DHG',
        name: 'Tên cũ',
        country: null,
        address: null,
        note: null,
        status: 'ACTIVE',
      }),
      update: jest.fn().mockImplementation((_f: unknown, d: object) =>
        Promise.resolve({
          ...{ id: 'man-1', code: 'DHG', name: 'Tên cũ', country: null, address: null, note: null, status: 'ACTIVE' },
          ...d,
        }),
      ),
    });

    await service.update('man-1', { name: 'Tên cũ' } as never, ADMIN_ACTOR);

    expect(audit.record).not.toHaveBeenCalled();
  });

  it('update đổi status ghi MANUFACTURER.STATUS_CHANGED', async () => {
    const service = makeService({
      findOne: jest.fn().mockResolvedValue({
        id: 'man-1',
        code: 'DHG',
        name: 'Tên cũ',
        country: null,
        address: null,
        note: null,
        status: 'ACTIVE',
      }),
      update: jest.fn().mockImplementation((_f: unknown, d: object) =>
        Promise.resolve({
          ...{ id: 'man-1', code: 'DHG', name: 'Tên cũ', country: null, address: null, note: null, status: 'ACTIVE' },
          ...d,
        }),
      ),
    });

    await service.update('man-1', { status: RecordStatus.INACTIVE } as never, ADMIN_ACTOR);

    expect(entriesOf(audit)).toMatchObject([
      {
        event: 'MANUFACTURER.STATUS_CHANGED',
        before: { status: 'ACTIVE' },
        after: { status: 'INACTIVE' },
      },
    ]);
  });

  it('remove ghi MANUFACTURER.DELETED với before', async () => {
    const service = makeService({
      findOne: jest.fn().mockResolvedValue({
        id: 'man-1',
        code: 'DHG',
        name: 'Tên cũ',
        country: null,
        address: null,
        note: null,
        status: 'ACTIVE',
      }),
      softDelete: jest.fn().mockResolvedValue(true),
    });

    await service.remove('man-1', ADMIN_ACTOR);

    expect(entriesOf(audit)).toMatchObject([
      {
        event: 'MANUFACTURER.DELETED',
        entityId: 'man-1',
        branchIds: [],
        before: { name: 'Tên cũ' },
      },
    ]);
  });
});
