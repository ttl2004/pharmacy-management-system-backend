import { HttpException } from '@nestjs/common';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { AuthRole } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';
import type { JwtUser } from '../authz/types/authz.types';
import { actorOf, entriesOf } from 'src/test-support/audit-harness';
import { SessionTransactions } from '../authz/session.store';
import { UserService } from './user.service';

const CN1 = '11111111-1111-4111-8111-111111111111';
const CN2 = '22222222-2222-4222-8222-222222222222';

/** Người gọi giả — mặc định ADMIN (phạm vi toàn chuỗi) để các test cũ giữ nguyên ý nghĩa. */
/** Cấp bậc theo seed `roles.level`. */
const LEVEL: Record<AuthRole, number> = {
  [AuthRole.SUPER_ADMIN]: 100,
  [AuthRole.ADMIN]: 80,
  [AuthRole.PHARMACY_MANAGER]: 60,
  [AuthRole.SALES_STAFF]: 40,
  [AuthRole.CUSTOMER]: 20,
};

function caller(userId: string, role: AuthRole = AuthRole.ADMIN, branchId: string | null = null): JwtUser {
  return { userId, sid: 'sid', email: null, role, branchId, roleLevel: LEVEL[role] };
}

const ADMIN = caller('caller-id');
const MANAGER_CN1 = caller('pm-caller', AuthRole.PHARMACY_MANAGER, CN1);

/**
 * Mã nghiệp vụ của lỗi: `ErrorException` mang `errorCode`, còn lỗi phân quyền (`permissionError`) là
 * HttpException mang `code` trong body.
 */
async function codeOf(promise: Promise<unknown>): Promise<number | undefined> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ErrorException) return error.errorCode;
    if (error instanceof HttpException) return (error.getResponse() as { code?: number }).code;
    throw error;
  }
  return undefined;
}

/**
 * Repository giả — chỉ cắm đúng những method mà service gọi.
 * `findByIdWithRole` có mặc định vì gần như mọi luật bảo vệ đều tra vai trò của bản ghi đích trước.
 */
const audit = { record: jest.fn() };
beforeEach(() => audit.record.mockClear());

function makeService(
  repositoryOverrides: Record<string, jest.Mock> = {},
  infra: { prisma?: Record<string, unknown>; tx?: Record<string, unknown> } = {},
) {
  const repository = {
    findRoleIdByCode: jest.fn(),
    findByIdWithRole: jest.fn().mockResolvedValue({ id: 'target', role: { code: 'SALES_STAFF', level: 40 } }),
    ...repositoryOverrides,
  } as never;
  const prisma = {
    role: { findFirst: jest.fn() },
    branch: { findFirst: jest.fn() },
    $transaction: jest.fn((work: (tx: unknown) => unknown) =>
      work({
        $executeRaw: jest.fn(),
        auth: { findFirst: jest.fn().mockResolvedValue({ username: 'nv01' }) },
        refreshToken: { updateMany: jest.fn() },
        ...infra.tx,
      }),
    ),
    ...infra.prisma,
  } as never;
  // Transaction phiên thật (khoá advisory chạy trên `tx` giả) để kiểm cả `revision`.
  const transactions = new SessionTransactions(prisma);
  return new UserService(repository, prisma, transactions, audit as never);
}

const EMPTY_PAGE = { hits: [], total: 0, page: 1, totalPages: 0, limit: 10 };

describe('UserService — danh sách người dùng', () => {
  it('không truyền roleCode thì không lọc theo vai trò', async () => {
    const findManyWithPagination = jest.fn().mockResolvedValue(EMPTY_PAGE);
    const service = makeService({ findManyWithPagination });
    await service.list({ page: 1, limit: 10 }, ADMIN);
    expect(findManyWithPagination).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ searchFields: ['phoneNumber', 'fullName', 'email'] }),
    );
  });

  it('roleCode không tồn tại thì trả danh sách rỗng, không chạm cột uuid', async () => {
    // Cột `users.roleId` là uuid: nhét một chuỗi không phải UUID vào đó sẽ ném lỗi ở tầng CSDL
    // và bộ lọc ngoại lệ biến thành 500 — trái với ý định "bộ lọc không tìm ra thì trả rỗng".
    const findManyWithPagination = jest.fn();
    const service = makeService({
      findRoleIdByCode: jest.fn().mockResolvedValue(null),
      findManyWithPagination,
    });

    const result = await service.list({ roleCode: 'KHONGCO', page: 2, limit: 10 } as never, ADMIN);

    expect(result).toEqual({ hits: [], total: 0, page: 2, totalPages: 0, limit: 10 });
    expect(findManyWithPagination).not.toHaveBeenCalled();
  });
});

describe('UserService — phạm vi chi nhánh', () => {
  it('ADMIN gửi branchId thì lọc đúng chi nhánh đó, không gửi thì thấy toàn chuỗi', async () => {
    const findManyWithPagination = jest.fn().mockResolvedValue(EMPTY_PAGE);
    const service = makeService({ findManyWithPagination });

    await service.list({ page: 1, limit: 10, branchId: CN2 }, ADMIN);
    await service.list({ page: 1, limit: 10 }, ADMIN);

    expect(findManyWithPagination).toHaveBeenNthCalledWith(1, { branchId: CN2 }, expect.anything());
    expect(findManyWithPagination).toHaveBeenNthCalledWith(2, {}, expect.anything());
  });

  it('PHARMACY_MANAGER không gửi branchId thì chỉ thấy chi nhánh của mình', async () => {
    const findManyWithPagination = jest.fn().mockResolvedValue(EMPTY_PAGE);
    const service = makeService({ findManyWithPagination });

    await service.list({ page: 1, limit: 10 }, MANAGER_CN1);

    expect(findManyWithPagination).toHaveBeenCalledWith({ branchId: CN1 }, expect.anything());
  });

  it('PHARMACY_MANAGER gửi đúng chi nhánh của mình vẫn hợp lệ', async () => {
    const findManyWithPagination = jest.fn().mockResolvedValue(EMPTY_PAGE);
    const service = makeService({ findManyWithPagination });

    await service.list({ page: 1, limit: 10, branchId: CN1 }, MANAGER_CN1);

    expect(findManyWithPagination).toHaveBeenCalledWith({ branchId: CN1 }, expect.anything());
  });

  it('PHARMACY_MANAGER lọc chi nhánh khác bị chặn 1506, không truy vấn gì', async () => {
    const findManyWithPagination = jest.fn();
    const service = makeService({ findManyWithPagination });

    expect(await codeOf(service.list({ page: 1, limit: 10, branchId: CN2 }, MANAGER_CN1))).toBe(
      ErrorCode.BRANCH_ACCESS_DENIED,
    );
    expect(findManyWithPagination).not.toHaveBeenCalled();
  });

  it('nhân viên chưa gán chi nhánh bị chặn 1507, không được thấy toàn chuỗi', async () => {
    const findManyWithPagination = jest.fn();
    const service = makeService({ findManyWithPagination });
    const orphan = caller('pm-orphan', AuthRole.PHARMACY_MANAGER, null);

    expect(await codeOf(service.list({ page: 1, limit: 10 }, orphan))).toBe(ErrorCode.BRANCH_NOT_ASSIGNED);
    expect(findManyWithPagination).not.toHaveBeenCalled();
  });

  it('PHARMACY_MANAGER xem chi tiết người ngoài chi nhánh nhận 1200 như không tồn tại', async () => {
    const service = makeService({
      findByIdWithRoleAndBranch: jest
        .fn()
        .mockResolvedValue({ id: 'u2', branchId: CN2, role: { code: 'SALES_STAFF', level: 40 }, branch: null }),
    });

    expect(await codeOf(service.getDetail('u2', MANAGER_CN1))).toBe(ErrorCode.USER_NOT_FOUND);
  });

  it('PHARMACY_MANAGER xem chi tiết người cùng chi nhánh thì thấy', async () => {
    const row = { id: 'u1', branchId: CN1, role: { code: 'SALES_STAFF', level: 40 }, branch: null };
    const service = makeService({ findByIdWithRoleAndBranch: jest.fn().mockResolvedValue(row) });

    await expect(service.getDetail('u1', MANAGER_CN1)).resolves.toBe(row);
  });

  it('sửa người ngoài chi nhánh — kể cả SUPER_ADMIN — nhận 1200 chứ không phải 1604', async () => {
    const update = jest.fn();
    const service = makeService({
      findByIdWithRole: jest
        .fn()
        .mockResolvedValue({ id: 'sa-id', branchId: null, role: { code: 'SUPER_ADMIN', level: 100 } }),
      update,
    });

    expect(await codeOf(service.update('sa-id', { fullName: 'Tên mới' }, actorOf(MANAGER_CN1)))).toBe(
      ErrorCode.USER_NOT_FOUND,
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('chuyển nhân viên sang chi nhánh khác bị chặn 1506', async () => {
    const update = jest.fn();
    const service = makeService({
      findByIdWithRole: jest
        .fn()
        .mockResolvedValue({ id: 'ss-id', branchId: CN1, role: { code: 'SALES_STAFF', level: 40 } }),
      update,
    });

    expect(await codeOf(service.update('ss-id', { branchId: CN2 }, actorOf(MANAGER_CN1)))).toBe(
      ErrorCode.BRANCH_ACCESS_DENIED,
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('xoá người ngoài chi nhánh nhận 1200, không xoá gì', async () => {
    const softDelete = jest.fn();
    const service = makeService({
      findByIdWithRole: jest
        .fn()
        .mockResolvedValue({ id: 'u2', branchId: CN2, role: { code: 'SALES_STAFF', level: 40 } }),
      softDelete,
    });

    expect(await codeOf(service.remove('u2', actorOf(MANAGER_CN1)))).toBe(ErrorCode.USER_NOT_FOUND);
    expect(softDelete).not.toHaveBeenCalled();
  });

  it('tạo người dùng không gửi branchId thì tự gán chi nhánh của người gọi', async () => {
    let created: Record<string, unknown> | undefined;
    const tx = {
      user: {
        create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
          created = data;
          return Promise.resolve({ id: 'new-id', role: { code: 'SALES_STAFF' }, ...data });
        }),
      },
      auth: { create: jest.fn() },
    };
    const prisma = {
      role: { findFirst: jest.fn().mockResolvedValue({ id: 'role-ss', code: 'SALES_STAFF', level: 40 }) },
      branch: { findFirst: jest.fn().mockResolvedValue({ id: CN1 }) },
      // Chống leo thang (1509): vai trò đích không đòi quyền nào nên luôn ⊆ quyền người gọi.
      rolePermission: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = makeService({}, { prisma, tx });

    await service.create(
      { fullName: 'Nhân viên mới', phoneNumber: '0987000001', roleCode: AuthRole.SALES_STAFF },
      actorOf(MANAGER_CN1),
    );

    expect(created).toMatchObject({ branchId: CN1, createdBy: 'pm-caller' });
  });

  it('tạo người dùng ở chi nhánh khác bị chặn 1506 trước khi tra vai trò', async () => {
    const roleLookup = jest.fn();
    const service = makeService({}, { prisma: { role: { findFirst: roleLookup } } });

    expect(
      await codeOf(
        service.create(
          { fullName: 'Nhân viên', phoneNumber: '0987000002', roleCode: AuthRole.SALES_STAFF, branchId: CN2 },
          actorOf(MANAGER_CN1),
        ),
      ),
    ).toBe(ErrorCode.BRANCH_ACCESS_DENIED);
    expect(roleLookup).not.toHaveBeenCalled();
  });
});

describe('UserService — tạo người dùng', () => {
  const baseDto = {
    fullName: 'Nguyễn Văn A',
    phoneNumber: '0987654321',
    roleCode: 'SALES_STAFF',
    branchId: CN1,
  };

  it('từ chối khi chỉ có username mà thiếu password', async () => {
    const service = makeService({});
    await expect(service.create({ ...baseDto, username: 'abc' } as never, actorOf(ADMIN))).rejects.toMatchObject({
      errorCode: ErrorCode.HTTP_BAD_REQUEST,
    });
  });

  it('từ chối khi chỉ có password mà thiếu username', async () => {
    const service = makeService({});
    await expect(service.create({ ...baseDto, password: 'Abc@12345' } as never, actorOf(ADMIN))).rejects.toMatchObject({
      errorCode: ErrorCode.HTTP_BAD_REQUEST,
    });
  });
});

describe('UserService — sửa người dùng', () => {
  it('chặn tự đổi status của chính mình (1605)', async () => {
    const service = makeService({});
    jest.spyOn(service, 'assertNotSuperAdminTarget').mockResolvedValue(undefined);
    await expect(
      service.update('me-id', { status: 'INACTIVE' } as never, actorOf(caller('me-id'))),
    ).rejects.toMatchObject({
      errorCode: ErrorCode.SELF_OPERATION_FORBIDDEN,
    });
  });

  it('vẫn cho tự sửa hồ sơ thường', async () => {
    const update = jest.fn().mockResolvedValue({ id: 'me-id', fullName: 'Tên mới' });
    const service = makeService({ update });
    jest.spyOn(service, 'assertNotSuperAdminTarget').mockResolvedValue(undefined);
    await expect(service.update('me-id', { fullName: 'Tên mới' }, actorOf(caller('me-id')))).resolves.toBeDefined();
    expect(update).toHaveBeenCalled();
  });

  it('SUPER_ADMIN tự sửa chính mình vẫn bị chặn (1604)', async () => {
    // Luật 14 đứng trước luật 15, nên chính chủ cũng không sửa được tài khoản tối cao.
    const service = makeService({
      findByIdWithRole: jest.fn().mockResolvedValue({ id: 'sa-id', role: { code: 'SUPER_ADMIN', level: 100 } }),
    });
    await expect(
      service.update('sa-id', { fullName: 'Tên mới' }, actorOf(caller('sa-id', AuthRole.SUPER_ADMIN))),
    ).rejects.toMatchObject({ errorCode: ErrorCode.SUPER_ADMIN_PROTECTED });
  });

  it('gửi branchId null cho vai trò bắt buộc có chi nhánh thì bị từ chối (1602)', async () => {
    const service = makeService({
      findByIdWithRole: jest.fn().mockResolvedValue({ id: 'pm-id', role: { code: 'PHARMACY_MANAGER', level: 60 } }),
    });
    jest.spyOn(service, 'assertNotSuperAdminTarget').mockResolvedValue(undefined);
    await expect(service.update('pm-id', { branchId: null }, actorOf(ADMIN))).rejects.toMatchObject({
      errorCode: ErrorCode.INVALID_REFERENCE,
    });
  });

  it('không gửi branchId thì giữ nguyên chi nhánh cũ, không kiểm luật 10', async () => {
    // Bắt tham số qua mockImplementation thay vì đọc `mock.calls` — `calls` là `any[][]` nên
    // truy cập vào nó vi phạm no-unsafe-member-access.
    let payload: Record<string, unknown> | undefined;
    const update = jest.fn().mockImplementation((_filter: unknown, data: Record<string, unknown>) => {
      payload = data;
      return Promise.resolve({ id: 'pm-id' });
    });
    const service = makeService({
      findByIdWithRole: jest.fn().mockResolvedValue({ id: 'pm-id', role: { code: 'PHARMACY_MANAGER', level: 60 } }),
      update,
    });
    jest.spyOn(service, 'assertNotSuperAdminTarget').mockResolvedValue(undefined);

    await expect(service.update('pm-id', { fullName: 'Tên mới' }, actorOf(ADMIN))).resolves.toBeDefined();
    expect(payload).toBeDefined();
    expect(payload).not.toHaveProperty('branchId');
  });
});

describe('UserService — xoá người dùng', () => {
  it('chặn tự xoá chính mình (1605)', async () => {
    const service = makeService({});
    jest.spyOn(service, 'assertNotSuperAdminTarget').mockResolvedValue(undefined);
    await expect(service.remove('me-id', actorOf(caller('me-id')))).rejects.toMatchObject({
      errorCode: ErrorCode.SELF_OPERATION_FORBIDDEN,
    });
  });

  it('xoá thành công thì thu hồi mọi refresh token của người đó trong cùng tx và tăng revision', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 2 });
    const tx = { refreshToken: { updateMany } };
    const softDelete = jest.fn().mockResolvedValue(true);
    const service = makeService({ softDelete }, { tx });
    jest.spyOn(service, 'assertNotSuperAdminTarget').mockResolvedValue(undefined);
    const transactions = (service as unknown as { transactions: SessionTransactions }).transactions;
    const before = transactions.revision;

    await expect(service.remove('other-id', actorOf(caller('me-id')))).resolves.toEqual({ success: true });

    expect(updateMany).toHaveBeenCalledWith({
      where: { userId: 'other-id', revokedAt: null },
      data: { revokedAt: expect.any(Date) as Date },
    });
    expect((softDelete.mock.calls as unknown[][])[0][1]).toMatchObject({ refreshToken: { updateMany } });
    expect(transactions.revision).toBeGreaterThan(before);
  });
});

describe('UserService — khoá/ngừng tài khoản thu hồi phiên (báo cáo bảo mật #7)', () => {
  function setup(currentStatus: string) {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const tx = { refreshToken: { updateMany } };
    const update = jest.fn().mockResolvedValue({ id: 'u1' });
    const service = makeService(
      {
        findByIdWithRole: jest.fn().mockResolvedValue({
          id: 'u1',
          status: currentStatus,
          role: { code: 'SALES_STAFF', level: 40 },
        }),
        update,
      },
      { tx },
    );
    const transactions = (service as unknown as { transactions: SessionTransactions }).transactions;
    return { service, updateMany, update, tx, transactions };
  }

  it.each(['LOCKED', 'INACTIVE'])(
    'đổi status ACTIVE→%s thu hồi refresh token trong cùng tx và tăng revision',
    async (to) => {
      const { service, updateMany, update, transactions } = setup('ACTIVE');
      const before = transactions.revision;

      await service.update('u1', { status: to } as never, actorOf(ADMIN));

      expect(updateMany).toHaveBeenCalledWith({
        where: { userId: 'u1', revokedAt: null },
        data: { revokedAt: expect.any(Date) as Date },
      });
      // Cập nhật user và thu hồi token chạy trên CÙNG một tx.
      expect((update.mock.calls as unknown[][])[0][3]).toMatchObject({ refreshToken: { updateMany } });
      expect(transactions.revision).toBeGreaterThan(before);
    },
  );

  it('chỉ sửa hồ sơ (không đổi status) thì không thu hồi phiên', async () => {
    const { service, updateMany } = setup('ACTIVE');

    await service.update('u1', { fullName: 'Tên mới' }, actorOf(ADMIN));

    expect(updateMany).not.toHaveBeenCalled();
  });

  it('mở khoá LOCKED→ACTIVE không thu hồi phiên', async () => {
    const { service, updateMany } = setup('LOCKED');

    await service.update('u1', { status: 'ACTIVE' } as never, actorOf(ADMIN));

    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe('UserService — rào cấp bậc', () => {
  const OTHER_ADMIN = { id: 'admin-2', branchId: null, role: { code: 'ADMIN', level: 80 } };

  it('ADMIN không sửa được ADMIN khác (1508)', async () => {
    const update = jest.fn();
    const service = makeService({ findByIdWithRole: jest.fn().mockResolvedValue(OTHER_ADMIN), update });

    expect(await codeOf(service.update('admin-2', { fullName: 'Tên mới' }, actorOf(ADMIN)))).toBe(
      ErrorCode.ROLE_LEVEL_FORBIDDEN,
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('ADMIN không xoá được ADMIN khác (1508)', async () => {
    const softDelete = jest.fn();
    const service = makeService({ findByIdWithRole: jest.fn().mockResolvedValue(OTHER_ADMIN), softDelete });

    expect(await codeOf(service.remove('admin-2', actorOf(ADMIN)))).toBe(ErrorCode.ROLE_LEVEL_FORBIDDEN);
    expect(softDelete).not.toHaveBeenCalled();
  });

  it('tự sửa hồ sơ của chính mình vẫn được dù cùng cấp', async () => {
    const update = jest.fn().mockResolvedValue({ id: 'caller-id' });
    const service = makeService({
      findByIdWithRole: jest
        .fn()
        .mockResolvedValue({ id: 'caller-id', branchId: null, role: { code: 'ADMIN', level: 80 } }),
      update,
    });

    await expect(service.update('caller-id', { fullName: 'Tên mới' }, actorOf(ADMIN))).resolves.toBeDefined();
    expect(update).toHaveBeenCalled();
  });

  it('không tạo được người có vai trò cùng cấp (1508), trước cả luật chi nhánh', async () => {
    const branchLookup = jest.fn();
    const prisma = {
      role: { findFirst: jest.fn().mockResolvedValue({ id: 'role-pm', code: 'PHARMACY_MANAGER', level: 60 }) },
      branch: { findFirst: branchLookup },
    };
    const service = makeService({}, { prisma });

    expect(
      await codeOf(
        service.create(
          { fullName: 'Quản lý', phoneNumber: '0987000003', roleCode: AuthRole.PHARMACY_MANAGER },
          actorOf(MANAGER_CN1),
        ),
      ),
    ).toBe(ErrorCode.ROLE_LEVEL_FORBIDDEN);
    expect(branchLookup).not.toHaveBeenCalled();
  });
});

describe('UserService — nhật ký (D16: danh sách trắng, che PII)', () => {
  const CURRENT = {
    id: 'u1',
    fullName: 'Nguyễn Văn A',
    status: 'ACTIVE',
    branchId: CN1,
    email: 'an.nguyen@x.vn',
    phoneNumber: '0987654321',
    password: 'KHONG-DUOC-GHI',
    role: { code: 'SALES_STAFF', level: 40 },
  };

  function updateSetup() {
    const update = jest
      .fn()
      .mockImplementation((_f: unknown, data: object) => Promise.resolve({ ...CURRENT, ...data }));
    const service = makeService({ findByIdWithRole: jest.fn().mockResolvedValue(CURRENT), update });
    return { service };
  }

  it('USER.CREATED: email bị che, SĐT bị che, không có password/hash', async () => {
    const created = {
      id: 'new-1',
      fullName: 'Nguyễn Văn A',
      status: 'ACTIVE',
      branchId: CN1,
      email: 'an.nguyen@x.vn',
      phoneNumber: '0987654321',
      role: { code: 'SALES_STAFF' },
    };
    const tx = {
      user: { create: jest.fn().mockResolvedValue(created) },
      auth: { create: jest.fn() },
    };
    const prisma = {
      role: { findFirst: jest.fn().mockResolvedValue({ id: 'role-ss', code: 'SALES_STAFF', level: 40 }) },
      branch: { findFirst: jest.fn().mockResolvedValue({ id: CN1 }) },
      rolePermission: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = makeService({}, { prisma, tx });

    await service.create(
      {
        fullName: 'Nguyễn Văn A',
        phoneNumber: '0987654321',
        email: 'an.nguyen@x.vn',
        roleCode: 'SALES_STAFF',
        branchId: CN1,
        username: 'nv01',
        password: 'Matkhau@123',
      } as never,
      actorOf(ADMIN),
    );

    const entries = entriesOf(audit);
    expect(entries).toEqual([
      {
        event: 'USER.CREATED',
        entityType: 'users',
        entityId: 'new-1',
        entityLabel: 'nv01',
        branchIds: [CN1],
        searchTerms: ['Nguyễn Văn A', 'nv01'],
        after: {
          fullName: 'Nguyễn Văn A',
          status: 'ACTIVE',
          branchId: CN1,
          roleCode: 'SALES_STAFF',
          email: 'a***@x.vn',
          phoneNumber: '******4321',
        },
        metadata: { hasCredentials: true },
      },
    ]);
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toMatch(/Matkhau|password|hash|0987654321|an\.nguyen/i);
    // username chỉ là entityLabel, không nằm trong before/after.
    expect(JSON.stringify([entries[0].before, entries[0].after])).not.toContain('nv01');
  });

  it('USER.CREATED của ADMIN (không chi nhánh) có branchIds [], không có metadata khi không tạo tài khoản', async () => {
    const created = {
      id: 'new-2',
      fullName: 'Quản trị',
      status: 'ACTIVE',
      branchId: null,
      email: null,
      phoneNumber: '0987654322',
      role: { code: 'ADMIN' },
    };
    const tx = { user: { create: jest.fn().mockResolvedValue(created) }, auth: { create: jest.fn() } };
    const prisma = {
      role: { findFirst: jest.fn().mockResolvedValue({ id: 'role-ad', code: 'ADMIN', level: 80 }) },
      branch: { findFirst: jest.fn() },
      rolePermission: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = makeService({}, { prisma, tx });

    await service.create(
      { fullName: 'Quản trị', phoneNumber: '0987654322', roleCode: 'ADMIN' } as never,
      actorOf(caller('sa', AuthRole.SUPER_ADMIN)),
    );

    expect(entriesOf(audit)[0]).toMatchObject({ event: 'USER.CREATED', branchIds: [], entityLabel: 'Quản trị' });
    expect(entriesOf(audit)[0]).not.toHaveProperty('metadata');
  });

  it('update đổi status ghi USER.STATUS_CHANGED, không ghi USER.UPDATED nếu chỉ đổi status', async () => {
    const { service } = updateSetup();

    await service.update('u1', { status: 'LOCKED', reason: 'Nghỉ việc' } as never, actorOf(ADMIN));

    expect(entriesOf(audit)).toEqual([
      {
        event: 'USER.STATUS_CHANGED',
        entityType: 'users',
        entityId: 'u1',
        entityLabel: 'nv01',
        branchIds: [CN1],
        searchTerms: ['Nguyễn Văn A', 'nv01'],
        before: { status: 'ACTIVE' },
        after: { status: 'LOCKED' },
        reason: 'Nghỉ việc',
      },
    ]);
  });

  it('update đổi cả status và hồ sơ thì ghi hai entry trong MỘT lần record', async () => {
    const { service } = updateSetup();

    await service.update('u1', { status: 'INACTIVE', fullName: 'Tên mới' } as never, actorOf(ADMIN));

    expect(entriesOf(audit).map((e) => e.event)).toEqual(['USER.STATUS_CHANGED', 'USER.UPDATED']);
    expect(entriesOf(audit)[1]).toMatchObject({ before: { fullName: 'Nguyễn Văn A' }, after: { fullName: 'Tên mới' } });
  });

  it('update đổi email/SĐT thì che cả before lẫn after, không lộ giá trị thật', async () => {
    const { service } = updateSetup();

    await service.update('u1', { email: 'b.tran@y.vn', phoneNumber: '0911111111' } as never, actorOf(ADMIN));

    const [entry] = entriesOf(audit);
    expect(entry).toMatchObject({
      event: 'USER.UPDATED',
      before: { email: 'a***@x.vn', phoneNumber: '******4321' },
      after: { email: 'b***@y.vn', phoneNumber: '******1111' },
    });
    expect(JSON.stringify(entry)).not.toMatch(/KHONG-DUOC-GHI|0911111111|b\.tran/);
  });

  it('update không đổi trường nào trong danh sách trắng thì không ghi entry', async () => {
    const { service } = updateSetup();

    await service.update('u1', { fullName: 'Nguyễn Văn A', address: 'Địa chỉ mới' } as never, actorOf(ADMIN));

    expect(audit.record).not.toHaveBeenCalled();
  });

  it('remove ghi USER.DELETED với snapshot che PII và reason tuỳ chọn', async () => {
    const service = makeService({
      findByIdWithRole: jest.fn().mockResolvedValue(CURRENT),
      softDelete: jest.fn().mockResolvedValue(true),
    });
    jest.spyOn(service, 'assertNotSuperAdminTarget').mockResolvedValue(undefined);

    await service.remove('u1', actorOf(ADMIN), 'Nghỉ việc');

    expect(entriesOf(audit)).toEqual([
      expect.objectContaining({
        event: 'USER.DELETED',
        entityLabel: 'nv01',
        branchIds: [CN1],
        reason: 'Nghỉ việc',
        before: {
          fullName: 'Nguyễn Văn A',
          status: 'ACTIVE',
          branchId: CN1,
          roleCode: 'SALES_STAFF',
          email: 'a***@x.vn',
          phoneNumber: '******4321',
        },
      }),
    ]);
  });
});

describe('UserService — update đọc lại trong tx (race)', () => {
  const row = (status: string) => ({
    id: 'u1',
    fullName: 'Nguyễn Văn A',
    status,
    branchId: CN1,
    email: null,
    phoneNumber: '0987654321',
    role: { code: 'SALES_STAFF', level: 40 },
  });

  function setup(preTx: string, inTx: string) {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const service = makeService(
      {
        findByIdWithRole: jest.fn().mockResolvedValueOnce(row(preTx)).mockResolvedValueOnce(row(inTx)),
        update: jest.fn().mockResolvedValue({ id: 'u1', branchId: CN1 }),
      },
      { tx: { refreshToken: { updateMany } } },
    );
    jest.spyOn(service, 'assertNotSuperAdminTarget').mockResolvedValue(undefined);
    return { service, updateMany };
  }

  it('đọc cũ ACTIVE, trong tx đã LOCKED, yêu cầu ACTIVE → vẫn ghi STATUS_CHANGED LOCKED→ACTIVE', async () => {
    const { service } = setup('ACTIVE', 'LOCKED');

    await service.update('u1', { status: 'ACTIVE' } as never, actorOf(ADMIN));

    expect(entriesOf(audit)[0]).toMatchObject({
      event: 'USER.STATUS_CHANGED',
      before: { status: 'LOCKED' },
      after: { status: 'ACTIVE' },
    });
  });

  it('đọc cũ LOCKED nhưng trong tx đã ACTIVE, yêu cầu LOCKED → vẫn thu hồi refresh token', async () => {
    const { service, updateMany } = setup('LOCKED', 'ACTIVE');

    await service.update('u1', { status: 'LOCKED' } as never, actorOf(ADMIN));

    expect(updateMany).toHaveBeenCalledWith({
      where: { userId: 'u1', revokedAt: null },
      data: { revokedAt: expect.any(Date) as Date },
    });
    expect(entriesOf(audit)[0]).toMatchObject({ before: { status: 'ACTIVE' }, after: { status: 'LOCKED' } });
  });
});
