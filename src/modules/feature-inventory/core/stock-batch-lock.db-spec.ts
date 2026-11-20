import { PrismaClient, ProductType } from '@prisma/client';
import { addDaysToDateOnly, parseDateOnly, todayInVietnam } from 'src/common/utils/date-only.util';
import { createTestPrisma, resetSchema } from 'src/test-support/db-test';
import { StockBatchRepository } from './stock-batch.repository';

/** B1: `lockSellable` khoá hợp lô bán được + lô chỉ định trong MỘT câu lệnh (SQL chạy được trên DB thật). */
describe('StockBatchRepository.lockSellable alsoBatchIds (db)', () => {
  let prisma: PrismaClient;
  const repo = new StockBatchRepository();

  beforeAll(async () => {
    prisma = await createTestPrisma();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetSchema(prisma);
  });

  it('trả cả lô đã hết chỗ giữ (lô đơn đang giữ) lẫn lô bán được, theo thứ tự id; không có sản phẩm thì chỉ lô chỉ định', async () => {
    const branch = await prisma.branch.create({
      data: { code: 'CN01', name: 'CN', phone: '0900000000', address: 'HN' },
    });
    const unit = await prisma.unit.create({ data: { code: 'HOP', name: 'Hộp' } });
    const category = await prisma.category.create({ data: { name: 'Thuốc' } });
    const product = await prisma.product.create({
      data: { code: 'SP01', name: 'SP', type: ProductType.GOODS, categoryId: category.id, baseUnitId: unit.id },
    });
    const today = todayInVietnam();
    const expiryDate = parseDateOnly(addDaysToDateOnly(today, 300));
    const mk = (batchNumber: string, quantityOnHand: number, reservedQuantity: number) =>
      prisma.stockBatch.create({
        data: {
          branchId: branch.id,
          productId: product.id,
          batchNumber,
          expiryDate,
          quantityOnHand,
          reservedQuantity,
          importPrice: 1,
        },
      });
    const free = await mk('B2', 10, 0);
    const fullyReserved = await mk('B5', 10, 10);

    const sellableOnly = await prisma.$transaction((tx) => repo.lockSellable(tx, branch.id, [product.id], today));
    expect(sellableOnly.map((b) => b.id)).toEqual([free.id]);

    const union = await prisma.$transaction((tx) =>
      repo.lockSellable(tx, branch.id, [product.id], today, [fullyReserved.id]),
    );
    expect(union.map((b) => b.id).sort()).toEqual([free.id, fullyReserved.id].sort());
    expect(union.map((b) => b.id)).toEqual([...union.map((b) => b.id)].sort());

    const onlyExtra = await prisma.$transaction((tx) =>
      repo.lockSellable(tx, branch.id, [], today, [fullyReserved.id]),
    );
    expect(onlyExtra.map((b) => b.id)).toEqual([fullyReserved.id]);
  });
});
