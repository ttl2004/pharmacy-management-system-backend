import { Prisma, RecordStatus } from '@prisma/client';
import { ErrorCode } from 'src/common/types/error-code';
import type { JwtUser } from 'src/modules/feature-auth/authz/types/authz.types';
import { AuthRole } from 'src/common/types/common.enum';
import { ADMIN_ACTOR, entriesOf, fakePrisma } from 'src/test-support/audit-harness';
import { BranchService } from './branch.service';

const admin = {
  userId: 'caller-id',
  sid: 'sid',
  email: null,
  role: AuthRole.ADMIN,
  branchId: null,
  roleLevel: 80,
} as unknown as JwtUser;

const audit = { record: jest.fn() };
beforeEach(() => audit.record.mockClear());

function makeService(repositoryOverrides: Record<string, jest.Mock> = {}) {
  const repository = {
    findOne: jest.fn().mockResolvedValue({ id: 'id' }),
    findManyWithPagination: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    softDelete: jest.fn(),
    countReferencingUsers: jest.fn().mockResolvedValue(0),
    hasOpenInventory: jest.fn().mockResolvedValue(false),
    ...repositoryOverrides,
  } as never;
  return new BranchService(repository, fakePrisma() as never, audit as never);
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

    await service.list({ page: 2, limit: 5, status: RecordStatus.INACTIVE, search: 'CN' }, admin);

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

    await service.list({ page: 1, limit: 10 }, admin);

    expect(findManyWithPagination).toHaveBeenCalledWith({}, expect.anything());
  });
});

describe('BranchService — chi tiết', () => {
  it('không tồn tại thì báo RECORD_NOT_FOUND', async () => {
    const service = makeService({ findOne: jest.fn().mockResolvedValue(null) });

    await expect(service.getDetail('khong-co', admin)).rejects.toMatchObject({
      errorCode: ErrorCode.RECORD_NOT_FOUND,
    });
  });
});

describe('BranchService — tạo', () => {
  it('gán createdBy và mặc định trạng thái ACTIVE', async () => {
    const create = jest.fn().mockImplementation((data: unknown) => Promise.resolve(data));
    const service = makeService({ create });

    await service.create(
      { code: 'CN004', name: 'Quận 7', phone: '0900000004', address: 'Quận 7' } as never,
      ADMIN_ACTOR,
    );

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'CN004',
        status: RecordStatus.ACTIVE,
        createdBy: 'admin-1',
      }),
      expect.anything(),
    );
  });

  it('trùng code thì báo DUPLICATE_CODE', async () => {
    const service = makeService({ create: jest.fn().mockRejectedValue(duplicateError()) });

    await expect(
      service.create({ code: 'CN001', name: 'X', phone: '0900000001', address: 'Y' } as never, ADMIN_ACTOR),
    ).rejects.toMatchObject({ errorCode: ErrorCode.DUPLICATE_CODE });
  });
});

describe('BranchService — cập nhật', () => {
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
    const service = makeService({ update });

    await service.update('id', { phone: '0900000099' } as never, ADMIN_ACTOR);

    expect(payload).toEqual({ phone: '0900000099', updatedBy: 'admin-1' });
  });

  it('gửi null để xoá email và giờ mở cửa', async () => {
    let payload: Record<string, unknown> | undefined;
    const update = jest.fn().mockImplementation((_filter: unknown, data: Record<string, unknown>) => {
      payload = data;
      return Promise.resolve({ id: 'id' });
    });
    const service = makeService({ update });

    await service.update('id', { email: null, openingHours: null } as never, ADMIN_ACTOR);

    expect(payload).toEqual({ email: null, openingHours: null, updatedBy: 'admin-1' });
  });

  it('không tồn tại thì báo RECORD_NOT_FOUND', async () => {
    const service = makeService({ update: jest.fn().mockResolvedValue(null) });

    await expect(service.update('id', { name: 'X' } as never, ADMIN_ACTOR)).rejects.toMatchObject({
      errorCode: ErrorCode.RECORD_NOT_FOUND,
    });
  });

  it('trùng code thì báo DUPLICATE_CODE', async () => {
    const service = makeService({ update: jest.fn().mockRejectedValue(duplicateError()) });

    await expect(service.update('id', { code: 'CN001' } as never, ADMIN_ACTOR)).rejects.toMatchObject({
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

    await expect(service.remove('id', ADMIN_ACTOR)).rejects.toMatchObject({ errorCode: ErrorCode.INVALID_REFERENCE });
    expect(softDelete).not.toHaveBeenCalled();
  });

  it('còn hàng trong kho hoặc chứng từ kho đang mở thì báo INVALID_REFERENCE và không xoá', async () => {
    const softDelete = jest.fn();
    const service = makeService({
      findOne: jest.fn().mockResolvedValue({ id: 'id' }),
      hasOpenInventory: jest.fn().mockResolvedValue(true),
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

describe('BranchService — nhật ký', () => {
  const BRANCH = {
    id: 'br-1',
    code: 'CN001',
    name: 'Trung tâm',
    phone: '0900000001',
    email: null,
    address: 'Q1',
    openingHours: null,
    status: RecordStatus.ACTIVE,
  };
  const updateEcho = jest.fn().mockImplementation((_f: unknown, d: object) => Promise.resolve({ ...BRANCH, ...d }));

  it('create ghi BRANCH.CREATED, branchIds [id chi nhánh], SĐT bị che', async () => {
    const create = jest.fn().mockImplementation((d: object) => Promise.resolve({ ...BRANCH, ...d }));
    const service = makeService({ create });

    await service.create(
      { code: 'CN001', name: 'Trung tâm', phone: '0900000001', address: 'Q1' } as never,
      ADMIN_ACTOR,
    );

    expect(entriesOf(audit)).toMatchObject([
      {
        event: 'BRANCH.CREATED',
        entityType: 'branches',
        entityId: 'br-1',
        entityLabel: 'CN001',
        branchIds: ['br-1'],
        searchTerms: ['CN001', 'Trung tâm'],
        after: { phone: '******0001', name: 'Trung tâm' },
      },
    ]);
  });

  it('update ghi BRANCH.UPDATED với diff, SĐT bị che ở cả before lẫn after', async () => {
    const service = makeService({ findOne: jest.fn().mockResolvedValue(BRANCH), update: updateEcho });

    await service.update('br-1', { phone: '0900000099', name: 'Mới' } as never, ADMIN_ACTOR);

    expect(entriesOf(audit)).toMatchObject([
      {
        event: 'BRANCH.UPDATED',
        branchIds: ['br-1'],
        before: { name: 'Trung tâm', phone: '******0001' },
        after: { name: 'Mới', phone: '******0099' },
      },
    ]);
  });

  it('update đổi status vẫn ghi BRANCH.UPDATED (không có event STATUS_CHANGED riêng cho chi nhánh)', async () => {
    const service = makeService({ findOne: jest.fn().mockResolvedValue(BRANCH), update: updateEcho });

    await service.update('br-1', { status: RecordStatus.INACTIVE } as never, ADMIN_ACTOR);

    expect(entriesOf(audit)[0]).toMatchObject({ event: 'BRANCH.UPDATED', after: { status: 'INACTIVE' } });
  });

  it('update không đổi gì thì không ghi entry', async () => {
    const service = makeService({ findOne: jest.fn().mockResolvedValue(BRANCH), update: updateEcho });

    await service.update('br-1', { name: 'Trung tâm' } as never, ADMIN_ACTOR);

    expect(audit.record).not.toHaveBeenCalled();
  });

  it('remove ghi BRANCH.DELETED kèm reason tuỳ chọn', async () => {
    const service = makeService({
      findOne: jest.fn().mockResolvedValue(BRANCH),
      softDelete: jest.fn().mockResolvedValue(true),
    });

    await service.remove('br-1', ADMIN_ACTOR, 'Đóng cửa hàng');

    expect(entriesOf(audit)).toMatchObject([
      {
        event: 'BRANCH.DELETED',
        branchIds: ['br-1'],
        reason: 'Đóng cửa hàng',
        before: { code: 'CN001' },
      },
    ]);
  });

  it('remove không có reason vẫn ghi', async () => {
    const service = makeService({
      findOne: jest.fn().mockResolvedValue(BRANCH),
      softDelete: jest.fn().mockResolvedValue(true),
    });

    await service.remove('br-1', ADMIN_ACTOR);

    expect(entriesOf(audit)[0]).toMatchObject({ event: 'BRANCH.DELETED', reason: null });
  });
});
