import { Prisma } from '@prisma/client';
import { ErrorCode } from 'src/common/types/error-code';
import { ADMIN_ACTOR, entriesOf, fakePrisma } from 'src/test-support/audit-harness';
import { UnitService } from './unit.service';

const audit = { record: jest.fn() };
beforeEach(() => audit.record.mockClear());

function makeService(repositoryOverrides: Record<string, jest.Mock> = {}) {
  const repository = {
    findOne: jest.fn().mockResolvedValue({ id: 'id' }),
    findManyWithPagination: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    softDelete: jest.fn(),
    countBaseProducts: jest.fn().mockResolvedValue(0),
    countProductUnits: jest.fn().mockResolvedValue(0),
    ...repositoryOverrides,
  } as never;
  return new UnitService(repository, fakePrisma() as never, audit as never);
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

    await service.create({ code: 'VIEN', name: 'Viên' } as never, ADMIN_ACTOR);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'VIEN', name: 'Viên', note: null, createdBy: 'admin-1' }),
      expect.anything(),
    );
  });

  it('trùng code thì báo DUPLICATE_CODE', async () => {
    const service = makeService({ create: jest.fn().mockRejectedValue(duplicateError()) });

    await expect(service.create({ code: 'VIEN', name: 'Viên' } as never, ADMIN_ACTOR)).rejects.toMatchObject({
      errorCode: ErrorCode.DUPLICATE_CODE,
    });
  });
});

describe('UnitService — cập nhật', () => {
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

    await service.update('id', { name: 'Viên nén' } as never, ADMIN_ACTOR);

    expect(payload).toEqual({ name: 'Viên nén', updatedBy: 'admin-1' });
  });

  it('gửi null để xoá note', async () => {
    let payload: Record<string, unknown> | undefined;
    const update = jest.fn().mockImplementation((_filter: unknown, data: Record<string, unknown>) => {
      payload = data;
      return Promise.resolve({ id: 'id' });
    });
    const service = makeService({ findOne: jest.fn().mockResolvedValue({ id: 'id' }), update });

    await service.update('id', { note: null } as never, ADMIN_ACTOR);

    expect(payload).toEqual({ note: null, updatedBy: 'admin-1' });
  });

  it('không tồn tại thì báo RECORD_NOT_FOUND', async () => {
    const service = makeService({ findOne: jest.fn().mockResolvedValue(null) });

    await expect(service.update('id', { name: 'X' } as never, ADMIN_ACTOR)).rejects.toMatchObject({
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

    await expect(service.remove('id', ADMIN_ACTOR)).rejects.toMatchObject({ errorCode: ErrorCode.INVALID_REFERENCE });
    expect(softDelete).not.toHaveBeenCalled();
  });

  it('chỉ xuất hiện trong cấu hình đơn vị bán thì vẫn bị chặn', async () => {
    const softDelete = jest.fn();
    const service = makeService({
      findOne: jest.fn().mockResolvedValue({ id: 'id' }),
      countProductUnits: jest.fn().mockResolvedValue(1),
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

describe('UnitService — nhật ký', () => {
  const created = (d: object) => Promise.resolve({ id: 'unit-1', ...d });

  it('create ghi UNIT.CREATED, branchIds [] (danh mục toàn chuỗi), nhãn và searchTerms', async () => {
    const service = makeService({ create: jest.fn().mockImplementation(created) });

    await service.create({ code: 'VIEN', name: 'Viên' } as never, ADMIN_ACTOR);

    const [tx, actor] = audit.record.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(tx).toBeDefined();
    expect(actor).toMatchObject({ userId: 'admin-1', type: 'USER', ip: '10.0.0.1', requestId: 'req-1' });
    expect(entriesOf(audit)).toMatchObject([
      {
        event: 'UNIT.CREATED',
        entityType: 'units',
        entityId: 'unit-1',
        entityLabel: 'VIEN',
        branchIds: [],
        searchTerms: ['VIEN', 'Viên'],
      },
    ]);
  });

  it('create truyền tx của transaction xuống repository', async () => {
    const create = jest.fn().mockImplementation(created);
    const service = makeService({ create });

    await service.create({ code: 'VIEN', name: 'Viên' } as never, ADMIN_ACTOR);

    expect((create.mock.calls as unknown[][])[0][1]).toBe((audit.record.mock.calls[0] as unknown[])[0]);
  });

  it('update ghi UNIT.UPDATED kèm diff before/after', async () => {
    const service = makeService({
      findOne: jest.fn().mockResolvedValue({ id: 'unit-1', code: 'VIEN', name: 'Tên cũ', note: null }),
      update: jest
        .fn()
        .mockImplementation((_f: unknown, d: object) =>
          Promise.resolve({ ...{ id: 'unit-1', code: 'VIEN', name: 'Tên cũ', note: null }, ...d }),
        ),
    });

    await service.update('unit-1', { name: 'Tên mới' } as never, ADMIN_ACTOR);

    expect(entriesOf(audit)).toMatchObject([
      {
        event: 'UNIT.UPDATED',
        entityId: 'unit-1',
        branchIds: [],
        before: { name: 'Tên cũ' },
        after: { name: 'Tên mới' },
      },
    ]);
  });

  it('update không đổi gì thì không ghi entry', async () => {
    const service = makeService({
      findOne: jest.fn().mockResolvedValue({ id: 'unit-1', code: 'VIEN', name: 'Tên cũ', note: null }),
      update: jest
        .fn()
        .mockImplementation((_f: unknown, d: object) =>
          Promise.resolve({ ...{ id: 'unit-1', code: 'VIEN', name: 'Tên cũ', note: null }, ...d }),
        ),
    });

    await service.update('unit-1', { name: 'Tên cũ' } as never, ADMIN_ACTOR);

    expect(audit.record).not.toHaveBeenCalled();
  });

  it('remove ghi UNIT.DELETED với before', async () => {
    const service = makeService({
      findOne: jest.fn().mockResolvedValue({ id: 'unit-1', code: 'VIEN', name: 'Tên cũ', note: null }),
      softDelete: jest.fn().mockResolvedValue(true),
    });

    await service.remove('unit-1', ADMIN_ACTOR);

    expect(entriesOf(audit)).toMatchObject([
      {
        event: 'UNIT.DELETED',
        entityId: 'unit-1',
        branchIds: [],
        before: { name: 'Tên cũ' },
      },
    ]);
  });
});
