import { Logger } from '@nestjs/common';
import { BatchStatus, PriceBookPolicy, RecordStatus } from '@prisma/client';
import { SYSTEM_ACTOR_ID } from 'src/common/constants/app.constant';
import { PrismaService } from 'src/common/databases/prisma.service';
import { computeFormulaPrice } from 'src/modules/feature-catalog/price-book/price-book-formula';

const WHOLESALE_NAME = 'Giá sỉ';
const PROMO_NAME = 'Khuyến mãi tháng 10';
const WHOLESALE_UNIT_COUNT = 10;
const PROMO_UNIT_COUNT = 5;

/** Đơn vị gốc của các sản phẩm đầu tiên (theo mã) — nền cho giá mẫu của hai bảng. */
async function firstBaseUnits(prisma: PrismaService, take: number) {
  return prisma.productUnit.findMany({
    where: { isBaseUnit: true, isDeleted: false, status: RecordStatus.ACTIVE, product: { isDeleted: false, status: RecordStatus.ACTIVE } },
    select: { id: true, productId: true, salePrice: true },
    orderBy: { product: { code: 'asc' } },
    take,
  });
}

/** Giá vốn bình quân gia quyền các lô còn hàng của sản phẩm (mọi chi nhánh); chưa có lô → null. */
async function averageCostOf(prisma: PrismaService, productId: string): Promise<number | null> {
  const batches = await prisma.stockBatch.findMany({
    where: { productId, status: BatchStatus.AVAILABLE, quantityOnHand: { gt: 0 }, isDeleted: false },
    select: { importPrice: true, quantityOnHand: true },
  });
  const quantity = batches.reduce((sum, b) => sum + b.quantityOnHand, 0);
  if (!quantity) return null;
  return Math.round(batches.reduce((sum, b) => sum + b.importPrice * b.quantityOnHand, 0) / quantity);
}

/**
 * Tạo hai bảng giá mẫu, idempotent theo tên: bảng đã có thì bỏ qua (không ghi đè giá người dùng đã sửa).
 * Chạy sau khi đã seed chi nhánh + sản phẩm.
 */
export async function seedPriceBooks(prisma: PrismaService, logger: Logger): Promise<void> {
  const existing = await prisma.priceBook.findMany({
    where: { name: { in: [WHOLESALE_NAME, PROMO_NAME] } },
    select: { name: true },
  });
  const existingNames = new Set(existing.map((book) => book.name));

  if (!existingNames.has(WHOLESALE_NAME)) {
    const units = await firstBaseUnits(prisma, WHOLESALE_UNIT_COUNT);
    const items: { productUnitId: string; price: number }[] = [];
    for (const unit of units) {
      const base = (await averageCostOf(prisma, unit.productId)) ?? unit.salePrice;
      items.push({ productUnitId: unit.id, price: computeFormulaPrice(base, { op: '+', amount: 10, unit: '%' }) });
    }
    await prisma.priceBook.create({
      data: {
        name: WHOLESALE_NAME,
        startAt: new Date('2026-01-01T00:00:00+07:00'),
        endAt: new Date('2036-12-31T23:59:00+07:00'),
        status: RecordStatus.ACTIVE,
        outOfBookPolicy: PriceBookPolicy.BLOCK,
        formulaBase: 'avgCost',
        formulaOp: '+',
        formulaAmount: 10,
        formulaUnit: '%',
        createdBy: SYSTEM_ACTOR_ID,
        items: { create: items },
      },
    });
    logger.log(`Tạo bảng giá ${WHOLESALE_NAME} (${items.length} dòng giá)`);
  }

  if (!existingNames.has(PROMO_NAME)) {
    const branch = await prisma.branch.findFirst({
      where: { isDeleted: false },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    const units = await firstBaseUnits(prisma, PROMO_UNIT_COUNT);
    await prisma.priceBook.create({
      data: {
        name: PROMO_NAME,
        startAt: new Date('2026-10-01T00:00:00+07:00'),
        endAt: new Date('2026-10-31T23:59:00+07:00'),
        status: RecordStatus.ACTIVE,
        outOfBookPolicy: PriceBookPolicy.WARN,
        createdBy: SYSTEM_ACTOR_ID,
        branches: branch ? { create: [{ branchId: branch.id }] } : undefined,
        items: { create: units.map((unit) => ({ productUnitId: unit.id, price: Math.round(unit.salePrice * 0.92) })) },
      },
    });
    logger.log(`Tạo bảng giá ${PROMO_NAME} (${units.length} dòng giá)`);
  }
}
