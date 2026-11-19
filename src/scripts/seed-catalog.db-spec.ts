import { Logger } from '@nestjs/common';
import { PrismaClient, RecordStatus } from '@prisma/client';
import { CatalogTransactions } from 'src/modules/feature-catalog/catalog-transactions';
import { createTestPrisma, resetSchema } from 'src/test-support/db-test';
import { SEED_BRANCHES, SEED_PRODUCTS } from './data/catalog.seed';
import { runCatalogSeed, seedBlockedReason } from './seed-catalog';

describe('seed:catalog chạy lại không ghi đè (db)', () => {
  let prisma: PrismaClient;
  const logger = new Logger('SeedCatalogSpec');

  const run = () => runCatalogSeed(prisma as never, new CatalogTransactions(prisma as never), logger);

  beforeAll(async () => {
    prisma = await createTestPrisma();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetSchema(prisma);
    // Thuốc mà sản phẩm seed ghép tới (bình thường có sau khi đồng bộ từ CSDL Dược).
    for (const product of SEED_PRODUCTS.filter((p) => p.drugCode)) {
      await prisma.drug.create({
        data: {
          code: product.drugCode!,
          name: product.name,
          isPrescription: product.requiresPrescription,
          syncedAt: new Date(),
        },
      });
    }
  });

  it('chạy lần đầu tạo đủ dữ liệu', async () => {
    await run();
    expect(await prisma.product.count()).toBe(SEED_PRODUCTS.length);
    expect(await prisma.branch.count()).toBe(SEED_BRANCHES.length);
  });

  it('chạy lần hai giữ nguyên giá, trạng thái, xoá mềm đã sửa tay', async () => {
    await run();
    const [first, second] = SEED_PRODUCTS;
    const unit = await prisma.productUnit.findFirstOrThrow({
      where: { product: { code: first.code }, isBaseUnit: true },
    });
    await prisma.productUnit.update({ where: { id: unit.id }, data: { salePrice: 987654 } });
    await prisma.product.update({ where: { code: first.code }, data: { status: RecordStatus.INACTIVE } });
    await prisma.product.update({ where: { code: second.code }, data: { isDeleted: true } });
    await prisma.branch.updateMany({ where: { code: SEED_BRANCHES[0].code }, data: { isDeleted: true } });

    await run();

    expect((await prisma.productUnit.findUniqueOrThrow({ where: { id: unit.id } })).salePrice).toBe(987654);
    expect((await prisma.product.findUniqueOrThrow({ where: { code: first.code } })).status).toBe(
      RecordStatus.INACTIVE,
    );
    expect((await prisma.product.findUniqueOrThrow({ where: { code: second.code } })).isDeleted).toBe(true);
    expect((await prisma.branch.findFirstOrThrow({ where: { code: SEED_BRANCHES[0].code } })).isDeleted).toBe(true);
    expect(await prisma.product.count()).toBe(SEED_PRODUCTS.length);
  });
});

describe('seedBlockedReason', () => {
  it('production bị chặn trừ khi có ALLOW_SEED_IN_PRODUCTION=true', () => {
    expect(seedBlockedReason({ NODE_ENV: 'production' })).toMatch(/ALLOW_SEED_IN_PRODUCTION/);
    expect(seedBlockedReason({ NODE_ENV: 'production', ALLOW_SEED_IN_PRODUCTION: 'true' })).toBeNull();
    expect(seedBlockedReason({ NODE_ENV: 'development' })).toBeNull();
    expect(seedBlockedReason({})).toMatch(/NODE_ENV/); // thiếu NODE_ENV = production như app
  });
});
