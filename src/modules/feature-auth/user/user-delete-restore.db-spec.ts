import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';
import { AuthRole } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';
import { createTestPrisma, resetSchema } from 'src/test-support/db-test';
import { AuditLogService } from 'src/providers/audit-log/audit-log.service';
import { SecurityEventService } from 'src/providers/security-event/security-event.service';
import { SessionTransactions } from '../authz/session.store';
import { UserRepository } from './repositories/user.repository';
import { UserService } from './user.service';

/** Xoá nhân viên nhả SĐT/email/username (A9) rồi khôi phục — chạy trên schema `audit_db_test`. */
describe('xoá và khôi phục người dùng (db)', () => {
  let prisma: PrismaClient;
  let service: UserService;
  let roleId: string;
  let branchId: string;
  let adminId: string;

  const actor = () =>
    ({
      user: { userId: adminId, sid: 's', email: null, role: AuthRole.ADMIN, branchId: null, roleLevel: 80 },
      ip: null,
      userAgent: null,
      requestId: null,
    }) as never;

  beforeAll(async () => {
    prisma = await createTestPrisma();
    service = new UserService(
      new UserRepository(prisma as never),
      prisma as never,
      new SessionTransactions(prisma as never),
      new AuditLogService(),
      new SecurityEventService(prisma as never),
    );
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetSchema(prisma);
    const admin = await prisma.role.create({ data: { code: 'ADMIN', name: 'Quản trị', level: 80 } });
    roleId = (await prisma.role.create({ data: { code: 'SALES_STAFF', name: 'Bán hàng', level: 40 } })).id;
    branchId = (
      await prisma.branch.create({ data: { code: 'CN01', name: 'CN 1', phone: '0900000001', address: 'HN' } })
    ).id;
    adminId = (await prisma.user.create({ data: { fullName: 'Admin', roleId: admin.id } })).id;
  });

  const newStaff = async (username = 'nv01', phone = '0911111111', email = 'nv01@x.vn') => {
    const user = await prisma.user.create({
      data: { fullName: 'NV', phoneNumber: phone, email, roleId, branchId },
    });
    await prisma.auth.create({ data: { username, password: 'hash', userId: user.id } });
    return user.id;
  };

  it('xoá nhả SĐT/email/username: tạo người mới trùng cả ba thành công, nhật ký giữ giá trị gốc', async () => {
    const oldId = await newStaff();
    await service.remove(oldId, actor(), 'Nghỉ việc');

    const gone = await prisma.user.findUniqueOrThrow({ where: { id: oldId } });
    expect(gone).toMatchObject({ isDeleted: true, phoneNumber: null, email: null });
    const auth = await prisma.auth.findUniqueOrThrow({ where: { userId: oldId } });
    expect(auth.username).toMatch(/^nv01_DEL_[0-9a-z]{6}$/);

    const newId = await newStaff(); // cùng username/SĐT/email
    expect(newId).not.toBe(oldId);

    const log = await prisma.auditLog.findFirstOrThrow({ where: { event: 'USER.DELETED', entityId: oldId } });
    expect(log.entityLabel).toBe('nv01');
  });

  it('khôi phục khi username còn trống: lấy lại username gốc, INACTIVE, SĐT từ body; ghi USER.RESTORED', async () => {
    const oldId = await newStaff();
    await service.remove(oldId, actor());

    const restored = await service.restore(oldId, { phoneNumber: '0922222222' }, actor());
    expect(restored.auth).toEqual({ username: 'nv01' });

    const user = await prisma.user.findUniqueOrThrow({ where: { id: oldId } });
    expect(user).toMatchObject({ isDeleted: false, status: 'INACTIVE', phoneNumber: '0922222222', email: null });
    expect((await prisma.auth.findUniqueOrThrow({ where: { userId: oldId } })).username).toBe('nv01');
    expect(await prisma.auditLog.count({ where: { event: 'USER.RESTORED', entityId: oldId } })).toBe(1);
    // đã khôi phục rồi thì khôi phục lần nữa → 1701
    await expect(service.restore(oldId, {}, actor())).rejects.toMatchObject({
      errorCode: ErrorCode.INVALID_DOCUMENT_STATE,
    });
  });

  it('khôi phục khi username đã bị người khác lấy → 1601 và người cũ vẫn ở trạng thái đã xoá', async () => {
    const oldId = await newStaff();
    await service.remove(oldId, actor());
    await newStaff('nv01', '0933333333', 'khac@x.vn');

    await expect(service.restore(oldId, {}, actor())).rejects.toMatchObject({ errorCode: ErrorCode.DUPLICATE_CODE });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: oldId } });
    expect(user.isDeleted).toBe(true); // transaction đã rollback
    expect(await prisma.auditLog.count({ where: { event: 'USER.RESTORED' } })).toBe(0);
  });

  it('khôi phục với SĐT đã bị người khác dùng → 1601', async () => {
    const oldId = await newStaff();
    await service.remove(oldId, actor());
    await newStaff('nv02', '0944444444', 'nv02@x.vn');
    await expect(service.restore(oldId, { phoneNumber: '0944444444' }, actor())).rejects.toMatchObject({
      errorCode: ErrorCode.DUPLICATE_CODE,
    });
  });

  it('danh sách đã xoá chỉ có người đã xoá, username là bản gốc; danh sách thường không có', async () => {
    const oldId = await newStaff();
    await newStaff('nv02', '0955555555', 'nv02@x.vn');
    await service.remove(oldId, actor());
    const { user: caller } = actor() as unknown as { user: never };
    const deleted = await service.listDeleted({ page: 1, limit: 10 } as never, caller);
    expect(deleted.hits.map((u) => u.id)).toEqual([oldId]);
    expect(deleted.hits[0].auth).toEqual({ username: 'nv01' });
    const live = await service.list({ page: 1, limit: 10 } as never, caller);
    expect(live.hits.map((u) => u.id)).not.toContain(oldId);
  });
  it('migration dữ liệu: nhân viên xoá mềm từ trước được nhả SĐT/email/username, khôi phục lấy lại username gốc', async () => {
    const oldId = await newStaff();
    await prisma.user.update({ where: { id: oldId }, data: { isDeleted: true } }); // xoá kiểu cũ: giữ nguyên giá trị
    const sql = readFileSync(
      join(__dirname, '../../../../prisma/migrations/20261119090000_nha_gia_tri_duy_nhat_khi_xoa/migration.sql'),
      'utf8',
    );
    for (const statement of sql.split(';').filter((part) => part.replace(/--.*$/gm, '').trim())) {
      await prisma.$executeRawUnsafe(statement);
    }

    expect(await prisma.user.findUniqueOrThrow({ where: { id: oldId } })).toMatchObject({
      phoneNumber: null,
      email: null,
    });
    expect((await prisma.auth.findUniqueOrThrow({ where: { userId: oldId } })).username).toMatch(
      /^nv01_DEL_[0-9a-z]{6}$/,
    );
    await expect(newStaff()).resolves.toBeDefined(); // trùng cả ba giá trị cũ

    // Chạy lại migration không đổi username đã có hậu tố.
    for (const statement of sql.split(';').filter((part) => part.replace(/--.*$/gm, '').trim())) {
      await prisma.$executeRawUnsafe(statement);
    }
    expect((await prisma.auth.findUniqueOrThrow({ where: { userId: oldId } })).username).toMatch(
      /^nv01_DEL_[0-9a-z]{6}$/,
    );
  });
});
