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
    lockNameKey: jest.fn().mockResolvedValue(undefined),
    fillMissingNameKeys: jest.fn().mockResolvedValue(0),
    findByNameKey: jest.fn().mockResolvedValue(null),
    nextAutoCode: jest.fn().mockResolvedValue('NSX0001'),
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
  it('gán createdBy, mặc định ACTIVE, tự sinh mã, nameKey và các trường nullable là null', async () => {
    const create = jest.fn().mockImplementation((data: unknown) => Promise.resolve(data));
    const service = makeService({ create });

    await service.create({ name: 'Dược Hậu Giang' } as never, ADMIN_ACTOR);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Dược Hậu Giang',
        nameKey: 'duoc hau giang',
        code: 'NSX0001',
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

describe('ManufacturerService — chuẩn hoá tên/quốc gia, sinh mã', () => {
  const echoCreate = () => jest.fn().mockImplementation((data: object) => Promise.resolve({ id: 'man-new', ...data }));

  it('create: quốc gia bí danh được đưa về tên chuẩn, có mã thì không tự sinh', async () => {
    const create = echoCreate();
    const nextAutoCode = jest.fn();
    const service = makeService({ create, nextAutoCode });

    await service.create({ name: 'Pfizer Inc.', code: 'PFZ', country: 'USA' } as never, ADMIN_ACTOR);

    expect(nextAutoCode).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'PFZ', country: 'Mỹ', nameKey: 'pfizer' }),
      expect.anything(),
    );
  });

  it('create: khoá theo nameKey và điền khoá còn thiếu TRƯỚC khi kiểm trùng', async () => {
    const order: string[] = [];
    const service = makeService({
      lockNameKey: jest.fn().mockImplementation((_tx: unknown, key: string) => order.push(`lock:${key}`)),
      fillMissingNameKeys: jest.fn().mockImplementation(() => order.push('fill')),
      findByNameKey: jest.fn().mockImplementation(() => {
        order.push('find');
        return Promise.resolve(null);
      }),
      create: echoCreate(),
    });

    await service.create({ name: 'CTCP Dược Hậu Giang' } as never, ADMIN_ACTOR);

    expect(order).toEqual(['lock:duoc hau giang', 'fill', 'find']);
  });

  it('create: tên trùng (sau chuẩn hoá) với hãng có sẵn → DUPLICATE_CODE "Hãng đã tồn tại", không tạo', async () => {
    const create = jest.fn();
    const service = makeService({
      create,
      findByNameKey: jest.fn().mockResolvedValue({ id: 'old', name: 'Dược Hậu Giang', code: 'DHG' }),
    });

    await expect(
      service.create({ name: 'Công ty Cổ phần DƯỢC HẬU GIANG' } as never, ADMIN_ACTOR),
    ).rejects.toMatchObject({ errorCode: ErrorCode.DUPLICATE_CODE, message: 'Hãng đã tồn tại: Dược Hậu Giang (DHG)' });
    expect(create).not.toHaveBeenCalled();
  });

  it('create: tên không có chữ/số → HTTP_BAD_REQUEST', async () => {
    const service = makeService({});

    await expect(service.create({ name: '...' } as never, ADMIN_ACTOR)).rejects.toMatchObject({
      errorCode: ErrorCode.HTTP_BAD_REQUEST,
    });
  });

  it('resolve: có hãng khớp thì trả hãng đó, created=false, không tạo, không ghi nhật ký', async () => {
    const existing = { id: 'old', name: 'Công ty CP Dược phẩm Trung ương I', code: 'TW1', status: 'ACTIVE' };
    const create = jest.fn();
    const findByNameKey = jest.fn().mockResolvedValue(existing);
    const service = makeService({ create, findByNameKey });

    const result = await service.resolve({ name: 'CTCP DƯỢC PHẨM TRUNG ƯƠNG 1', country: 'VN' }, ADMIN_ACTOR);

    expect(result).toEqual({ created: false, manufacturer: existing });
    expect(findByNameKey).toHaveBeenCalledWith(expect.anything(), 'duoc pham trung uong 1');
    expect(create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('resolve: chưa có thì tạo với mã tự sinh, quốc gia chuẩn, ghi MANUFACTURER.CREATED', async () => {
    const create = echoCreate();
    const service = makeService({ create, nextAutoCode: jest.fn().mockResolvedValue('NSX0007') });

    const result = await service.resolve(
      { name: '  Daewoong Pharmaceutical Co., Ltd ', country: 'Korea' },
      ADMIN_ACTOR,
    );

    expect(result.created).toBe(true);
    expect(result.manufacturer).toMatchObject({
      code: 'NSX0007',
      name: 'Daewoong Pharmaceutical Co., Ltd',
      nameKey: 'daewoong pharmaceutical',
      country: 'Hàn Quốc',
      status: RecordStatus.ACTIVE,
    });
    expect(entriesOf(audit)).toMatchObject([{ event: 'MANUFACTURER.CREATED', entityLabel: 'NSX0007' }]);
  });

  it('resolve: không gửi country thì country null', async () => {
    const create = echoCreate();
    const service = makeService({ create });

    await service.resolve({ name: 'Sanofi' }, ADMIN_ACTOR);

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ country: null }), expect.anything());
  });

  it('update: đổi tên sang tên của hãng khác → DUPLICATE_CODE, không ghi', async () => {
    const update = jest.fn();
    const findByNameKey = jest.fn().mockResolvedValue({ id: 'other', name: 'Sanofi', code: null });
    const service = makeService({
      findOne: jest.fn().mockResolvedValue({ id: 'id', name: 'Tên cũ' }),
      findByNameKey,
      update,
    });

    await expect(service.update('id', { name: 'SANOFI S.A.' } as never, ADMIN_ACTOR)).rejects.toMatchObject({
      errorCode: ErrorCode.DUPLICATE_CODE,
      message: 'Hãng đã tồn tại: Sanofi',
    });
    expect(findByNameKey).toHaveBeenCalledWith(expect.anything(), 'sanofi', 'id');
    expect(update).not.toHaveBeenCalled();
  });

  it('update: đổi tên mà khoá không đổi (sửa hoa thường/dấu câu) thì không kiểm trùng, vẫn ghi nameKey', async () => {
    let payload: Record<string, unknown> | undefined;
    const findByNameKey = jest.fn();
    const service = makeService({
      findOne: jest.fn().mockResolvedValue({ id: 'id', name: 'Dược Hậu Giang' }),
      findByNameKey,
      update: jest.fn().mockImplementation((_f: unknown, data: Record<string, unknown>) => {
        payload = data;
        return Promise.resolve({ id: 'id' });
      }),
    });

    await service.update('id', { name: 'DƯỢC HẬU GIANG' } as never, ADMIN_ACTOR);

    expect(findByNameKey).not.toHaveBeenCalled();
    expect(payload).toMatchObject({ name: 'DƯỢC HẬU GIANG', nameKey: 'duoc hau giang' });
  });

  it('update: quốc gia bí danh được đưa về tên chuẩn', async () => {
    let payload: Record<string, unknown> | undefined;
    const service = makeService({
      findOne: jest.fn().mockResolvedValue({ id: 'id', name: 'X' }),
      update: jest.fn().mockImplementation((_f: unknown, data: Record<string, unknown>) => {
        payload = data;
        return Promise.resolve({ id: 'id' });
      }),
    });

    await service.update('id', { country: 'Viet Nam' } as never, ADMIN_ACTOR);

    expect(payload).toEqual({ country: 'Việt Nam', updatedBy: 'admin-1' });
  });

  it('listCountries trả danh sách quốc gia chuẩn, Việt Nam đầu tiên', () => {
    const countries = makeService({}).listCountries();
    expect(countries[0]).toBe('Việt Nam');
    expect(countries).toContain('Ấn Độ');
  });
});
