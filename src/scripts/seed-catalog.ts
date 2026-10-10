import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Prisma, RecordStatus } from '@prisma/client';
import { SYSTEM_ACTOR_ID } from 'src/common/constants/app.constant';
import { PrismaService } from 'src/common/databases/prisma.service';
import { SessionTransactions } from 'src/modules/feature-auth/authz/session.store';
import { AppModule } from '../app.module';
import { SEED_BRANCHES, SEED_CATEGORIES, SEED_MANUFACTURERS, SEED_PRODUCTS, SEED_UNITS } from './data/catalog.seed';
import type { SeedProductUnit } from './data/catalog.seed';

type IdByCode = Map<string, string>;

/**
 * Tìm theo `code` chứ không dùng `upsert`: cột `code` là UNIQUE nhưng bản ghi đã xoá mềm vẫn giữ giá
 * trị đó, nên upsert sẽ đâm vào ràng buộc thay vì phục hồi bản ghi cũ.
 */
async function upsertDictionary<T extends { code: string }, TRecord extends { id: string }>(
  items: readonly T[],
  handlers: {
    find: (code: string) => Promise<TRecord | null>;
    create: (item: T) => Promise<TRecord>;
    update: (id: string, item: T) => Promise<TRecord>;
  },
  label: string,
  logger: Logger,
): Promise<IdByCode> {
  const idByCode: IdByCode = new Map();

  for (const item of items) {
    const existing = await handlers.find(item.code);
    const record = existing ? await handlers.update(existing.id, item) : await handlers.create(item);
    idByCode.set(item.code, record.id);
    logger.log(`${existing ? 'Cập nhật' : 'Tạo'} ${label} ${item.code}`);
  }

  return idByCode;
}

async function seedBranches(prisma: PrismaService, logger: Logger): Promise<void> {
  await upsertDictionary(
    SEED_BRANCHES,
    {
      find: (code) => prisma.branch.findFirst({ where: { code } }),
      create: (branch) => prisma.branch.create({ data: { ...branch } }),
      update: (id, branch) =>
        prisma.branch.update({ where: { id }, data: { ...branch, isDeleted: false, updatedAt: new Date() } }),
    },
    'chi nhánh',
    logger,
  );
}

async function seedCategories(prisma: PrismaService, logger: Logger): Promise<IdByCode> {
  return upsertDictionary(
    SEED_CATEGORIES,
    {
      find: (code) => prisma.category.findFirst({ where: { code } }),
      create: (category) => prisma.category.create({ data: { ...category, createdBy: SYSTEM_ACTOR_ID } }),
      update: (id, category) =>
        prisma.category.update({
          where: { id },
          data: { ...category, isDeleted: false, updatedBy: SYSTEM_ACTOR_ID, updatedAt: new Date() },
        }),
    },
    'nhóm sản phẩm',
    logger,
  );
}

async function seedManufacturers(prisma: PrismaService, logger: Logger): Promise<IdByCode> {
  return upsertDictionary(
    SEED_MANUFACTURERS,
    {
      find: (code) => prisma.manufacturer.findFirst({ where: { code } }),
      create: (manufacturer) => prisma.manufacturer.create({ data: { ...manufacturer, createdBy: SYSTEM_ACTOR_ID } }),
      update: (id, manufacturer) =>
        prisma.manufacturer.update({
          where: { id },
          data: { ...manufacturer, isDeleted: false, updatedBy: SYSTEM_ACTOR_ID, updatedAt: new Date() },
        }),
    },
    'hãng sản xuất',
    logger,
  );
}

async function seedUnits(prisma: PrismaService, logger: Logger): Promise<IdByCode> {
  return upsertDictionary(
    SEED_UNITS,
    {
      find: (code) => prisma.unit.findFirst({ where: { code } }),
      create: (unit) => prisma.unit.create({ data: { ...unit, createdBy: SYSTEM_ACTOR_ID } }),
      update: (id, unit) =>
        prisma.unit.update({
          where: { id },
          data: { ...unit, isDeleted: false, updatedBy: SYSTEM_ACTOR_ID, updatedAt: new Date() },
        }),
    },
    'đơn vị tính',
    logger,
  );
}

/** Hoà giải cấu hình đơn vị bán theo đúng ngữ nghĩa replace-all của `ProductService.update`. */
async function reconcileUnits(
  client: Prisma.TransactionClient,
  productId: string,
  units: readonly SeedProductUnit[],
  unitIds: IdByCode,
  logger: Logger,
): Promise<void> {
  const existingRows = await client.productUnit.findMany({
    where: { productId },
    select: { id: true, unitId: true, isDeleted: true },
  });
  const existingByUnitId = new Map(existingRows.map((row) => [row.unitId, row]));
  const wantedUnitIds = new Set<string>();

  for (const unit of units) {
    const unitId = unitIds.get(unit.unitCode);
    if (!unitId) throw new Error(`Đơn vị ${unit.unitCode} chưa được seed`);

    wantedUnitIds.add(unitId);
    const data = {
      conversionRate: unit.conversionRate,
      salePrice: unit.salePrice,
      barcode: unit.barcode,
      isBaseUnit: unit.isBaseUnit,
      status: RecordStatus.ACTIVE,
      isDeleted: false,
    };

    const existing = existingByUnitId.get(unitId);
    if (existing) {
      await client.productUnit.update({
        where: { id: existing.id },
        data: { ...data, updatedBy: SYSTEM_ACTOR_ID, updatedAt: new Date() },
      });
    } else {
      await client.productUnit.create({ data: { ...data, productId, unitId, createdBy: SYSTEM_ACTOR_ID } });
    }
  }

  const removedIds = existingRows
    .filter((row) => !row.isDeleted && !wantedUnitIds.has(row.unitId))
    .map((row) => row.id);

  if (removedIds.length) {
    await client.productUnit.updateMany({
      where: { id: { in: removedIds } },
      data: { isDeleted: true, updatedBy: SYSTEM_ACTOR_ID, updatedAt: new Date() },
    });
    logger.log(`Xoá mềm ${removedIds.length} đơn vị bán không còn trong dữ liệu seed`);
  }
}

async function seedProducts(
  prisma: PrismaService,
  transactions: SessionTransactions,
  references: { categories: IdByCode; manufacturers: IdByCode; units: IdByCode },
  logger: Logger,
): Promise<void> {
  for (const product of SEED_PRODUCTS) {
    const categoryId = references.categories.get(product.categoryCode);
    const baseUnitId = references.units.get(product.baseUnitCode);
    if (!categoryId || !baseUnitId) throw new Error(`Thiếu tham chiếu cho sản phẩm ${product.code}`);

    const manufacturerId = product.manufacturerCode
      ? (references.manufacturers.get(product.manufacturerCode) ?? null)
      : null;

    const data = {
      code: product.code,
      barcode: product.barcode ?? null,
      name: product.name,
      categoryId,
      manufacturerId,
      baseUnitId,
      activeIngredient: product.activeIngredient ?? null,
      strength: product.strength ?? null,
      dosageForm: product.dosageForm ?? null,
      packagingSpec: product.packagingSpec ?? null,
      requiresPrescription: product.requiresPrescription,
      minStockLevel: product.minStockLevel ?? 0,
      status: RecordStatus.ACTIVE,
    };

    // Sản phẩm và cấu hình đơn vị bán của nó là một khối: lỗi giữa chừng không được để lại sản phẩm
    // thiếu đơn vị. Đi qua `SessionTransactions` cho cùng kỷ luật với `ProductService`.
    const existed = await transactions.write(async (tx) => {
      const existing = await tx.product.findFirst({ where: { code: product.code } });
      const saved = existing
        ? await tx.product.update({
            where: { id: existing.id },
            data: { ...data, isDeleted: false, updatedBy: SYSTEM_ACTOR_ID, updatedAt: new Date() },
          })
        : await tx.product.create({ data: { ...data, createdBy: SYSTEM_ACTOR_ID } });

      await reconcileUnits(tx, saved.id, product.units, references.units, logger);
      return Boolean(existing);
    });

    logger.log(`${existed ? 'Cập nhật' : 'Tạo'} sản phẩm ${product.code}`);
  }
}

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const logger = new Logger('SeedCatalogScript');

  try {
    const prisma = app.get(PrismaService);
    const transactions = app.get(SessionTransactions);

    await seedBranches(prisma, logger);
    const categories = await seedCategories(prisma, logger);
    const manufacturers = await seedManufacturers(prisma, logger);
    const units = await seedUnits(prisma, logger);
    await seedProducts(prisma, transactions, { categories, manufacturers, units }, logger);

    logger.log('Catalog seed completed');
  } catch (error) {
    logger.error('Catalog seed failed', error);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

void bootstrap();
