import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaClient, ProductType } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';
import { createTestPrisma, resetSchema } from 'src/test-support/db-test';
import { DrugRepository } from './drug.repository';

const ACTOR_ID = '3f6c1a52-6b1e-4c1a-9a3e-2d5b8f0e7a11';

/** D3: cờ kiểm soát hàng hoá theo `controlType` của thuốc — đồng bộ và migration dữ liệu, trên PostgreSQL thật. */
describe('Cờ kiểm soát theo danh mục thuốc (db)', () => {
  let prisma: PrismaClient;
  let repository: DrugRepository;
  let categoryId: string;
  let unitId: string;
  let controlledDrugId: string;
  let blankDrugId: string;
  let plainDrugId: string;

  beforeAll(async () => {
    prisma = await createTestPrisma();
    repository = new DrugRepository(prisma as unknown as PrismaService);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetSchema(prisma);
    const role = await prisma.role.create({ data: { code: 'ADMIN', name: 'Quản trị', level: 90 } });
    await prisma.user.create({ data: { id: ACTOR_ID, fullName: 'Admin', roleId: role.id } });
    categoryId = (await prisma.category.create({ data: { name: 'Thuốc' } })).id;
    unitId = (await prisma.unit.create({ data: { code: 'HOP', name: 'Hộp' } })).id;
    controlledDrugId = (
      await prisma.drug.create({ data: { code: 'D1', name: 'A', syncedAt: new Date(), controlType: 'Gây nghiện' } })
    ).id;
    blankDrugId = (
      await prisma.drug.create({ data: { code: 'D2', name: 'B', syncedAt: new Date(), controlType: '   ' } })
    ).id;
    plainDrugId = (await prisma.drug.create({ data: { code: 'D3', name: 'C', syncedAt: new Date() } })).id;
  });

  const product = (code: string, drugId: string | null, extra: { isDeleted?: boolean; isControlled?: boolean } = {}) =>
    prisma.product.create({
      data: {
        code,
        name: code,
        categoryId,
        baseUnitId: unitId,
        type: drugId ? ProductType.DRUG : ProductType.GOODS,
        drugId,
        ...extra,
      },
    });
  const flagOf = async (id: string) => (await prisma.product.findUniqueOrThrow({ where: { id } })).isControlled;

  it('sync chỉ bật cờ cho hàng chưa xoá của thuốc có controlType; không tắt, không đụng thuốc khác', async () => {
    const live = await product('P1', controlledDrugId);
    const deleted = await product('P2', controlledDrugId, { isDeleted: true });
    const already = await product('P3', controlledDrugId, { isControlled: true });
    const blank = await product('P4', blankDrugId);
    const plain = await product('P5', plainDrugId);
    const manual = await product('P6', plainDrugId, { isControlled: true });
    const noDrug = await product('P7', null);

    const changed = await prisma.$transaction((tx) => repository.syncProductControlled(tx, new Date(), ACTOR_ID));

    expect(changed.map((row) => row.code)).toEqual(['P1']);
    expect(await flagOf(live.id)).toBe(true);
    expect(await flagOf(deleted.id)).toBe(false);
    expect(await flagOf(already.id)).toBe(true);
    expect(await flagOf(blank.id)).toBe(false);
    expect(await flagOf(plain.id)).toBe(false);
    expect(await flagOf(manual.id)).toBe(true);
    expect(await flagOf(noDrug.id)).toBe(false);
  });

  it('sync không tự tắt cờ khi controlType về rỗng', async () => {
    const p = await product('P1', controlledDrugId, { isControlled: true });
    await prisma.drug.update({ where: { id: controlledDrugId }, data: { controlType: null } });

    await prisma.$transaction((tx) => repository.syncProductControlled(tx, new Date(), ACTOR_ID));

    expect(await flagOf(p.id)).toBe(true);
  });

  it('migration dữ liệu chỉ bật cờ đúng hàng, chạy lại không đổi gì thêm', async () => {
    const live = await product('P1', controlledDrugId);
    const deleted = await product('P2', controlledDrugId, { isDeleted: true });
    const blank = await product('P3', blankDrugId);
    const manual = await product('P4', plainDrugId, { isControlled: true });
    const sql = readFileSync(
      join(__dirname, '../../../../../prisma/migrations/20261120110000_kiem_soat_theo_danh_muc_thuoc/migration.sql'),
      'utf8',
    );
    const run = async () => {
      for (const statement of sql.split(';').filter((part) => part.replace(/--.*$/gm, '').trim())) {
        await prisma.$executeRawUnsafe(statement);
      }
    };

    await run();
    await run();

    expect(await flagOf(live.id)).toBe(true);
    expect(await flagOf(deleted.id)).toBe(false);
    expect(await flagOf(blank.id)).toBe(false);
    expect(await flagOf(manual.id)).toBe(true);
  });
});
