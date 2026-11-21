import { PrismaClient, ProductType } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';
import { createTestPrisma, resetSchema } from 'src/test-support/db-test';
import { DRUG_INGREDIENTS_SEARCH_FIELD, ProductRepository } from './product.repository';

/** Tìm kiếm danh mục trên PostgreSQL thật (T2): điều kiện ILIKE nằm trong câu phân trang, không kéo id về Node. */
describe('ProductRepository — tìm kiếm (db)', () => {
  let prisma: PrismaClient;
  let repo: ProductRepository;

  beforeAll(async () => {
    prisma = await createTestPrisma();
    repo = new ProductRepository(prisma as unknown as PrismaService);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetSchema(prisma);
    const category = await prisma.category.create({ data: { name: 'Thuốc' } });
    const unit = await prisma.unit.create({ data: { code: 'HOP', name: 'Hộp' } });
    const drug = await prisma.drug.create({
      data: { code: 'D1', name: 'Hapacol', ingredients: 'Paracetamol 500mg', syncedAt: new Date() },
    });
    const base = { categoryId: category.id, baseUnitId: unit.id, type: ProductType.GOODS };
    await prisma.product.createMany({
      data: [
        { ...base, code: 'SP01', name: 'Panadol Extra' },
        { ...base, code: 'SP02', name: 'Hapacol 500', type: ProductType.DRUG, drugId: drug.id },
        { ...base, code: 'SP03', name: 'Vitamin C 100%' },
        { ...base, code: 'SP04', name: 'PANADOL đã xoá', isDeleted: true },
        // 30 dòng cùng khớp "Siro" để kiểm LIMIT/total do PostgreSQL tính.
        ...Array.from({ length: 30 }, (_, i) => ({
          ...base,
          code: `SR${String(i).padStart(2, '0')}`,
          name: `Siro ho ${i}`,
        })),
      ],
    });
  });

  const page = (search: string, searchFields: string[], limit = 10) =>
    repo.findPageWithSummary({}, { page: 1, limit, search, searchFields, sort: 'code:asc' });

  it('không phân biệt hoa/thường, bỏ dòng đã xoá', async () => {
    const res = await page('panadol', ['name', 'code']);
    expect(res.hits.map((h) => h.code)).toEqual(['SP01']);
    expect(res.total).toBe(1);
  });

  it('tìm theo hoạt chất của thuốc liên kết trong cùng câu (OR với cột của hàng hoá)', async () => {
    const res = await page('paracetamol', ['name', DRUG_INGREDIENTS_SEARCH_FIELD]);
    expect(res.hits.map((h) => h.code)).toEqual(['SP02']);
    const byCode = await page('SP01', ['code', DRUG_INGREDIENTS_SEARCH_FIELD]);
    expect(byCode.hits.map((h) => h.code)).toEqual(['SP01']);
  });

  it('% và _ là chữ thường, không phải ký tự đại diện', async () => {
    expect((await page('%', ['name'])).hits.map((h) => h.code)).toEqual(['SP03']);
    expect((await page('_', ['name'])).total).toBe(0);
  });

  it('nhiều dòng khớp: trả đúng trang và tổng', async () => {
    const res = await page('siro', ['name'], 5);
    expect(res.hits).toHaveLength(5);
    expect(res.total).toBe(30);
    expect(res.totalPages).toBe(6);
  });
});
