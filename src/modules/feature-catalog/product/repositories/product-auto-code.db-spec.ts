import { PrismaClient, ProductType } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthRole } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';
import { AuditLogService } from 'src/providers/audit-log/audit-log.service';
import { DB_TEST_SCHEMA, applyMigrationFile, createTestPrisma, resetSchema } from 'src/test-support/db-test';
import { CatalogTransactions } from '../../catalog-transactions';
import { ProductService } from '../product.service';
import { ProductRepository } from './product.repository';

const ACTOR: RequestActor = {
  user: {
    userId: '3f6c1a52-6b1e-4c1a-9a3e-2d5b8f0e7a11',
    sid: 's',
    email: null,
    role: AuthRole.ADMIN,
    branchId: null,
    roleLevel: 80,
  },
  ip: '10.0.0.1',
  userAgent: null,
  requestId: 'req-1',
};

const MIGRATION = 'ma_hang_tu_sinh';
const codeNo = (code: string) => Number(/^SP(\d+)$/.exec(code)?.[1]);
const spCode = (no: number) => `SP${String(no).padStart(4, '0')}`;

/** Mã hàng tự sinh từ `product_code_seq` — trên PostgreSQL thật (sequence + unique `code`). */
describe('ProductService — mã hàng tự sinh SPxxxx (db)', () => {
  let prisma: PrismaClient;
  let service: ProductService;
  let categoryId: string;
  let unitId: string;

  beforeAll(async () => {
    prisma = await createTestPrisma();
    service = new ProductService(
      new ProductRepository(prisma as unknown as PrismaService),
      new CatalogTransactions(prisma as unknown as PrismaService),
      new AuditLogService(),
    );
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // TRUNCATE ... RESTART IDENTITY không đụng sequence độc lập — mỗi test tự đọc số kế tiếp thay vì giả định.
    await resetSchema(prisma);
    const role = await prisma.role.create({ data: { code: 'ADMIN', name: 'Quản trị', level: 90 } });
    await prisma.user.create({ data: { id: ACTOR.user.userId, fullName: 'Admin', roleId: role.id } });
    categoryId = (await prisma.category.create({ data: { name: 'Hàng hoá' } })).id;
    unitId = (await prisma.unit.create({ data: { code: 'HOP', name: 'Hộp' } })).id;
  });

  const create = (code?: string) =>
    service.create(
      {
        ...(code === undefined ? {} : { code }),
        name: 'Khẩu trang',
        type: ProductType.GOODS,
        categoryId,
        baseUnitId: unitId,
        units: [{ unitId, conversionRate: 1, salePrice: 1000, isBaseUnit: true }],
      } as never,
      ACTOR,
    );

  /** Số `nextval` sẽ trả ở lần gọi tới (không tiêu số). */
  const peekNext = async (): Promise<number> => {
    const [row] = await prisma.$queryRaw<{ last: bigint; called: boolean }[]>`
      SELECT last_value AS last, is_called AS called FROM "product_code_seq"`;
    return Number(row.last) + (row.called ? 1 : 0);
  };

  const insertManual = (code: string, isDeleted = false) =>
    prisma.product.create({
      data: { code, name: `Nhập tay ${code}`, categoryId, baseUnitId: unitId, type: ProductType.GOODS, isDeleted },
    });

  it('hai lần tạo không gửi mã → hai mã SP khác nhau, tăng dần', async () => {
    const first = await create();
    const second = await create();

    expect(first?.code).toMatch(/^SP\d{4,}$/);
    expect(second?.code).toMatch(/^SP\d{4,}$/);
    expect(codeNo(second.code)).toBeGreaterThan(codeNo(first.code));
  });

  it('tạo song song không gửi mã → mọi mã đều khác nhau', async () => {
    const created = await Promise.all(Array.from({ length: 5 }, () => create()));
    const codes = created.map((p) => p.code);
    expect(new Set(codes).size).toBe(5);
  });

  it('bỏ qua số đã bị mã nhập tay chiếm (kể cả bản ghi đã xoá mềm)', async () => {
    const next = await peekNext();
    await insertManual(spCode(next));
    await insertManual(spCode(next + 1), true);

    const created = await create();

    expect(created?.code).toBe(spCode(next + 2));
  });

  it('mã nhập tay vẫn dùng như cũ; trùng mã nhập tay báo DUPLICATE_CODE', async () => {
    const created = await create('ABC-01');
    expect(created?.code).toBe('ABC-01');

    await expect(create('ABC-01')).rejects.toMatchObject({ errorCode: ErrorCode.DUPLICATE_CODE });
  });

  it('migration đặt sequence sau số SP lớn nhất (kể cả đã xoá mềm), không sửa dòng nào', async () => {
    await insertManual('SP0500');
    await insertManual('SP0777', true);
    await insertManual('SPX9999');
    await insertManual('TTT001');
    const before = await prisma.product.findMany({ select: { id: true, code: true }, orderBy: { code: 'asc' } });

    applyMigrationFile(DB_TEST_SCHEMA, MIGRATION);

    expect(await prisma.product.findMany({ select: { id: true, code: true }, orderBy: { code: 'asc' } })).toEqual(
      before,
    );
    expect((await create())?.code).toBe('SP0778');
  });

  it('migration trên bảng chưa có mã SP → mã đầu tiên là SP0001', async () => {
    await insertManual('TTT001');

    applyMigrationFile(DB_TEST_SCHEMA, MIGRATION);

    expect((await create())?.code).toBe('SP0001');
    expect((await create())?.code).toBe('SP0002');
  });
});
