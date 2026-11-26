import { Test } from '@nestjs/testing';
import { PrismaClient, RecordStatus } from '@prisma/client';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { PrismaService } from 'src/common/databases/prisma.service';
import { AuthRole } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';
import { AuditLogService } from 'src/providers/audit-log/audit-log.service';
import { backfillManufacturers } from 'src/scripts/backfill-manufacturer';
import {
  applyMigrationFile,
  applyMigrationsUntil,
  buildTestDatabaseUrl,
  createTestPrisma,
  resetSchema,
} from 'src/test-support/db-test';
import { ManufacturerService } from './manufacturer.service';
import { ManufacturerRepository } from './repositories/manufacturer.repository';

/** Tìm-hoặc-tạo hãng thật trên schema `audit_db_test`: nguyên tử khi đồng thời, sinh mã NSX…, điền nameKey cũ. */
describe('hãng sản xuất — resolve nguyên tử, sinh mã (db)', () => {
  let prisma: PrismaClient;
  let service: ManufacturerService;
  let actor: RequestActor;

  beforeAll(async () => {
    prisma = await createTestPrisma();
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: PrismaService, useValue: prisma },
        AuditLogService,
        ManufacturerRepository,
        ManufacturerService,
      ],
    }).compile();
    service = moduleRef.get(ManufacturerService);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetSchema(prisma);
    // Sequence không thuộc bảng nào nên TRUNCATE … RESTART IDENTITY không đặt lại — tự đặt về đầu.
    await prisma.$executeRaw`SELECT setval('"manufacturer_code_seq"', 1, false)`;
    const role = await prisma.role.create({ data: { code: 'ADMIN', name: 'Quản trị', level: 90 } });
    const user = await prisma.user.create({ data: { fullName: 'Người quản lý danh mục', roleId: role.id } });
    actor = {
      user: { userId: user.id, role: AuthRole.ADMIN, branchId: null, email: null, sid: 's1', roleLevel: 90 },
      ip: '10.0.0.1',
      userAgent: 'jest',
      requestId: null,
    } as unknown as RequestActor;
  });

  it('nhiều request đồng thời cùng tên (biến thể) → đúng 1 hãng, mọi request nhận cùng id', async () => {
    const names = [
      'Công ty CP Dược phẩm Trung ương I',
      'CTCP DƯỢC PHẨM TRUNG ƯƠNG 1',
      'Công ty Cổ phần Dược phẩm Trung ương 1',
      'dược phẩm trung ương I',
      'CÔNG TY CỔ PHẦN DƯỢC PHẨM TRUNG ƯƠNG I',
    ];

    const results = await Promise.all(names.map((name) => service.resolve({ name, country: 'VN' }, actor)));

    const rows = await prisma.manufacturer.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ nameKey: 'duoc pham trung uong 1', country: 'Việt Nam', code: 'NSX0001' });
    expect(new Set(results.map((r) => r.manufacturer.id))).toEqual(new Set([rows[0].id]));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const logs = await prisma.auditLog.count({ where: { event: 'MANUFACTURER.CREATED' } });
    expect(logs).toBe(1);
  });

  it('đồng thời khác tên → mỗi tên một hãng, mã tự sinh không trùng', async () => {
    const results = await Promise.all(
      ['Sanofi', 'Pfizer Inc.', 'Bayer AG', 'Abbott', 'Stada'].map((name) => service.resolve({ name }, actor)),
    );

    const codes = results.map((r) => r.manufacturer.code).sort();
    expect(codes).toEqual(['NSX0001', 'NSX0002', 'NSX0003', 'NSX0004', 'NSX0005']);
    expect(results.every((r) => r.created)).toBe(true);
  });

  it('sinh mã bỏ qua mã nhập tay đã chiếm (kể cả hãng đã xoá mềm)', async () => {
    await service.create({ name: 'Hãng nhập tay', code: 'NSX0002' }, actor);
    await prisma.manufacturer.create({ data: { name: 'Hãng đã xoá', code: 'NSX0003', isDeleted: true } });

    const first = await service.resolve({ name: 'Hãng A' }, actor);
    const second = await service.create({ name: 'Hãng B' }, actor);

    expect(first.manufacturer.code).toBe('NSX0001');
    expect(second.code).toBe('NSX0004');
  });

  it('dữ liệu cũ chưa có nameKey vẫn được khớp (tự điền khoá trong transaction)', async () => {
    const legacy = await prisma.manufacturer.create({
      data: { name: 'Công ty Cổ phần Dược Hậu Giang', code: 'DHG', country: 'Việt Nam' },
    });
    expect(legacy.nameKey).toBeNull();

    const result = await service.resolve({ name: 'CTCP DƯỢC HẬU GIANG', country: 'Japan' }, actor);

    expect(result).toMatchObject({ created: false, manufacturer: { id: legacy.id, country: 'Việt Nam' } });
    const reloaded = await prisma.manufacturer.findUniqueOrThrow({ where: { id: legacy.id } });
    expect(reloaded.nameKey).toBe('duoc hau giang');
  });

  it('ưu tiên hãng ACTIVE; bỏ qua hãng đã xoá mềm', async () => {
    await prisma.manufacturer.create({
      data: { name: 'Sanofi', nameKey: 'sanofi', code: 'S-DEL', isDeleted: true, createdAt: new Date('2020-01-01') },
    });
    await prisma.manufacturer.create({
      data: {
        name: 'Sanofi',
        nameKey: 'sanofi',
        code: 'S-OFF',
        status: RecordStatus.INACTIVE,
        createdAt: new Date('2021-01-01'),
      },
    });
    const active = await prisma.manufacturer.create({ data: { name: 'Sanofi S.A.', nameKey: 'sanofi', code: 'S-ON' } });

    const result = await service.resolve({ name: 'SANOFI' }, actor);

    expect(result).toMatchObject({ created: false, manufacturer: { id: active.id } });
  });

  it('chỉ còn hãng xoá mềm thì tạo mới', async () => {
    await prisma.manufacturer.create({ data: { name: 'Sanofi', nameKey: 'sanofi', code: 'S-DEL', isDeleted: true } });

    const result = await service.resolve({ name: 'Sanofi' }, actor);

    expect(result.created).toBe(true);
  });

  it('form tạo trùng tên (biến thể) → DUPLICATE_CODE "Hãng đã tồn tại"; đồng thời chỉ 1 bản ghi', async () => {
    const settled = await Promise.allSettled([
      service.create({ name: 'Công ty TNHH Dược phẩm ABC' }, actor),
      service.create({ name: 'DƯỢC PHẨM ABC CO., LTD' }, actor),
    ]);

    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    const rejected = settled.find((s) => s.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ errorCode: ErrorCode.DUPLICATE_CODE });
    expect((rejected.reason as Error).message).toMatch(/^Hãng đã tồn tại: /);
    expect(await prisma.manufacturer.count()).toBe(1);
  });

  it('script backfill: điền nameKey, chuẩn quốc gia, sinh mã thiếu; chạy lại không đổi gì', async () => {
    await prisma.manufacturer.create({ data: { name: 'Hãng nhập tay', code: 'NSX0001', nameKey: 'sai' } });
    const a = await prisma.manufacturer.create({ data: { name: 'Cty TNHH Abc', country: 'VN' } });
    const b = await prisma.manufacturer.create({ data: { name: 'Pfizer Inc.', country: '  USA ', code: 'PFZ' } });

    const first = await backfillManufacturers(prisma);
    const second = await backfillManufacturers(prisma);

    expect(first).toEqual({ nameKeys: 3, countries: 2, codes: 1 });
    expect(second).toEqual({ nameKeys: 0, countries: 0, codes: 0 });
    expect(await prisma.manufacturer.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({
      nameKey: 'abc',
      country: 'Việt Nam',
      code: 'NSX0002',
    });
    expect(await prisma.manufacturer.findUniqueOrThrow({ where: { id: b.id } })).toMatchObject({
      nameKey: 'pfizer',
      country: 'Mỹ',
      code: 'PFZ',
    });
  });
});

const SCHEMA = 'manufacturer_migration_db';
const MIGRATION = 'chuan_hoa_hang_san_xuat';

/** Migration trên DB "kiểu cũ": sinh mã cho hãng chưa có mã sau mã NSX lớn nhất, chuẩn quốc gia, đặt sequence. */
describe('migration chuan_hoa_hang_san_xuat', () => {
  let admin: PrismaClient;
  let db: PrismaClient;

  beforeAll(async () => {
    admin = await createTestPrisma();
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${SCHEMA}"`);
    await applyMigrationsUntil(admin, SCHEMA, MIGRATION);
    db = new PrismaClient({ datasources: { db: { url: buildTestDatabaseUrl(SCHEMA) } } });
    await db.$connect();
    // Bảng cũ chưa có cột nameKey → chèn bằng SQL thô.
    await db.$executeRaw`
      INSERT INTO manufacturers ("id", "name", "code", "country", "createdAt") VALUES
        (gen_random_uuid(), 'Hãng có mã tay', 'NSX0005', 'Viet Nam', '2026-01-01'),
        (gen_random_uuid(), 'Hãng cũ 1', NULL, 'VN', '2026-01-02'),
        (gen_random_uuid(), 'Hãng cũ 2', NULL, 'USA', '2026-01-03'),
        (gen_random_uuid(), 'Hãng lạ', 'X1', '  Wakanda ', '2026-01-04'),
        (gen_random_uuid(), 'Hãng rỗng', 'X2', '   ', '2026-01-05')`;
  });

  afterAll(async () => {
    await db?.$disconnect();
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await admin.$disconnect();
  });

  it('sinh mã NSX0006, NSX0007 theo thứ tự tạo; sequence tiếp tục từ NSX0008; quốc gia chuẩn', async () => {
    applyMigrationFile(SCHEMA, MIGRATION);

    const rows = await db.$queryRaw<{ name: string; code: string; country: string | null; nameKey: string | null }[]>`
      SELECT "name", "code", "country", "nameKey" FROM manufacturers ORDER BY "createdAt"`;
    expect(rows.map((r) => [r.code, r.country])).toEqual([
      ['NSX0005', 'Việt Nam'],
      ['NSX0006', 'Việt Nam'],
      ['NSX0007', 'Mỹ'],
      ['X1', 'Wakanda'],
      ['X2', null],
    ]);
    expect(rows.every((r) => r.nameKey === null)).toBe(true);
    const [next] = await db.$queryRaw<{ value: bigint }[]>`SELECT nextval('"manufacturer_code_seq"') AS value`;
    expect(next.value).toBe(8n);
  });
});
