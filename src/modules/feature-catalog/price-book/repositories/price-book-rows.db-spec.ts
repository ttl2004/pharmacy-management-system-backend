import { PrismaClient, ProductType } from '@prisma/client';
import type { PrismaService } from 'src/common/databases/prisma.service';
import { createTestPrisma, resetSchema } from 'src/test-support/db-test';
import type { PriceRowsFilter } from '../price-book-rows-filter';
import { PriceBookRowsRepository } from './price-book-rows.repository';

/** D1 trên DB thật: không tính được giá vốn / giá nhập cuối thì SQL trả NULL, không phải 0. */
describe('PriceBookRowsRepository — giá vốn / giá nhập cuối chưa biết (db)', () => {
  let prisma: PrismaClient;
  let repo: PriceBookRowsRepository;

  beforeAll(async () => {
    prisma = await createTestPrisma();
    repo = new PriceBookRowsRepository(prisma as unknown as PrismaService);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetSchema(prisma);
  });

  const filter = (branchId?: string): PriceRowsFilter => ({ codes: [], categoryIds: [], stock: 'all', branchId });

  async function seed() {
    const branch = await prisma.branch.create({
      data: { code: 'CN01', name: 'CN01', phone: '0900000001', address: 'HN' },
    });
    const unit = await prisma.unit.create({ data: { code: 'HOP', name: 'Hộp' } });
    const category = await prisma.category.create({ data: { name: 'Thuốc' } });
    const supplier = await prisma.supplier.create({ data: { code: 'NCC01', name: 'NCC', phone: '0900000002' } });
    const mk = async (code: string) => {
      const product = await prisma.product.create({
        data: { code, name: code, type: ProductType.GOODS, categoryId: category.id, baseUnitId: unit.id },
      });
      const pu = await prisma.productUnit.create({
        data: { productId: product.id, unitId: unit.id, conversionRate: 1, salePrice: 30000, isBaseUnit: true },
      });
      return { product, pu };
    };
    const withStock = await mk('PANADOL');
    const noStock = await mk('SIRO');

    const receipt = await prisma.goodsReceipt.create({
      data: {
        code: 'PN01',
        branchId: branch.id,
        supplierId: supplier.id,
        status: 'CONFIRMED',
        confirmedAt: new Date('2026-10-01T00:00:00Z'),
      },
    });
    await prisma.goodsReceiptItem.create({
      data: {
        receiptId: receipt.id,
        productId: withStock.product.id,
        productUnitId: withStock.pu.id,
        quantity: 50,
        conversionRate: 1,
        baseQuantity: 50,
        importPrice: 21000,
        unitDiscount: 1000,
        totalPrice: 1_000_000n,
        batchNumber: 'L1',
        expiryDate: new Date('2028-01-01'),
      },
    });
    await prisma.stockBatch.create({
      data: {
        branchId: branch.id,
        productId: withStock.product.id,
        batchNumber: 'L1',
        expiryDate: new Date('2028-01-01'),
        quantityOnHand: 50,
        importPrice: 20000,
      },
    });
    return { branch, withStock, noStock };
  }

  it('có lô + phiếu nhập: giá vốn 20.000, giá nhập cuối (21.000 - 1.000) = 20.000; không lô/phiếu: NULL', async () => {
    const { branch } = await seed();
    const rows = await repo.findAll(filter(branch.id));
    const by = new Map(rows.map((r) => [r.code, r]));
    expect(by.get('PANADOL')).toMatchObject({ avgCost: 20000, lastPurchaseCost: 20000 });
    expect(by.get('SIRO')).toMatchObject({ avgCost: null, lastPurchaseCost: null });
  });

  it('lô hết hàng (còn 0) thì giá vốn NULL, không phải 0', async () => {
    const { branch, withStock } = await seed();
    await prisma.stockBatch.updateMany({ where: { productId: withStock.product.id }, data: { quantityOnHand: 0 } });
    const rows = await repo.findAll(filter(branch.id));
    expect(rows.find((r) => r.code === 'PANADOL')?.avgCost).toBeNull();
  });

  it('không chọn chi nhánh: mọi dòng NULL cả hai giá', async () => {
    await seed();
    const rows = await repo.findAll(filter());
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r).toMatchObject({ avgCost: null, lastPurchaseCost: null });
  });
});
