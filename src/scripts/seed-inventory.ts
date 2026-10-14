import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ReceiptStatus, RecordStatus } from '@prisma/client';
import { SYSTEM_ACTOR_ID } from 'src/common/constants/app.constant';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { PrismaService } from 'src/common/databases/prisma.service';
import { AuthRole } from 'src/common/types/common.enum';
import { addDaysToDateOnly, todayInVietnam } from 'src/common/utils/date-only.util';
import type { GoodsReceiptItemRequest } from 'src/modules/feature-inventory/goods-receipt/dtos/goods-receipt.request';
import { GoodsReceiptService } from 'src/modules/feature-inventory/goods-receipt/goods-receipt.service';
import { AppModule } from '../app.module';
import {
  openingStockAction,
  SEED_OPENING_STOCK,
  SEED_RECEIPT_NOTE,
  SEED_SUPPLIERS,
  SeedStockLine,
} from './data/inventory.seed';

/*
 * seed:inventory — nhà cung cấp mẫu + tồn đầu kỳ cho các chi nhánh. Tồn tạo QUA `GoodsReceiptService` (lập rồi xác
 * nhận phiếu nhập) chứ không chèn thẳng `stock_batches` — sổ kho, giá vốn và nhật ký mẫu vì thế nhất quán như dữ liệu
 * thật. Chạy lại an toàn (xem `openingStockAction`). Cần chạy sau `seed:permissions` và `seed:catalog`.
 */

/** Chạy nghiệp vụ với quyền toàn chuỗi; id là tác nhân hệ thống do `seed:permissions` tạo. */
const SYSTEM_ACTOR: RequestActor = {
  user: {
    userId: SYSTEM_ACTOR_ID,
    sid: 'seed',
    email: null,
    role: AuthRole.SUPER_ADMIN,
    branchId: null,
    roleLevel: 100,
  },
  ip: null,
};

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const logger = new Logger('SeedInventoryScript');

  try {
    const prisma = app.get(PrismaService);
    await seedSuppliers(prisma, logger);
    await seedOpeningStock(prisma, app.get(GoodsReceiptService), logger);
    logger.log('Inventory seed completed');
  } catch (error) {
    logger.error('Inventory seed failed', error);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

/** Nhà cung cấp mẫu — đã có (theo mã) thì bỏ qua. */
async function seedSuppliers(prisma: PrismaService, logger: Logger): Promise<void> {
  for (const supplier of SEED_SUPPLIERS) {
    const existing = await prisma.supplier.findFirst({ where: { code: supplier.code }, select: { id: true } });
    if (existing) continue;
    await prisma.supplier.create({ data: { ...supplier, status: RecordStatus.ACTIVE, createdBy: SYSTEM_ACTOR_ID } });
    logger.log(`Đã tạo nhà cung cấp ${supplier.code}`);
  }
}

/** Tồn đầu kỳ mỗi chi nhánh = một phiếu nhập lập rồi xác nhận. */
async function seedOpeningStock(prisma: PrismaService, receipts: GoodsReceiptService, logger: Logger): Promise<void> {
  const today = todayInVietnam();
  for (const stock of SEED_OPENING_STOCK) {
    const branch = await prisma.branch.findFirst({ where: { code: stock.branchCode, isDeleted: false } });
    if (!branch) throw new Error(`Chưa có chi nhánh ${stock.branchCode}. Chạy "npm run seed:catalog" trước.`);

    const seeded = await prisma.goodsReceipt.findFirst({
      where: { branchId: branch.id, note: SEED_RECEIPT_NOTE, status: { not: ReceiptStatus.CANCELLED } },
      select: { id: true, status: true },
    });
    const action = openingStockAction(seeded);
    if (action === 'skip') {
      logger.log(`Chi nhánh ${stock.branchCode} đã có tồn đầu kỳ, bỏ qua`);
      continue;
    }
    if (action === 'confirm' && seeded) {
      const confirmed = await receipts.confirm(seeded.id, SYSTEM_ACTOR);
      logger.log(`Xác nhận nốt phiếu tồn đầu kỳ ${stock.branchCode} còn dở từ lần chạy trước: ${confirmed.code}`);
      continue;
    }

    const supplier = await prisma.supplier.findFirstOrThrow({ where: { code: stock.supplierCode } });
    const items = await toReceiptItems(prisma, stock.lines, today);
    const draft = await receipts.create(
      { branchId: branch.id, supplierId: supplier.id, note: SEED_RECEIPT_NOTE, items },
      SYSTEM_ACTOR,
    );
    const confirmed = await receipts.confirm(draft.id, SYSTEM_ACTOR);
    logger.log(`Đã nhập tồn đầu kỳ ${stock.branchCode}: phiếu ${confirmed.code}, ${items.length} dòng`);
  }
}

/** Đổi dòng seed (mã sản phẩm + mã đơn vị) sang dòng phiếu nhập; hạn dùng tính từ hôm nay theo giờ VN. */
async function toReceiptItems(
  prisma: PrismaService,
  lines: readonly SeedStockLine[],
  today: string,
): Promise<GoodsReceiptItemRequest[]> {
  const items: GoodsReceiptItemRequest[] = [];
  for (const line of lines) {
    const unit = await prisma.productUnit.findFirst({
      where: { isDeleted: false, product: { code: line.productCode, isDeleted: false }, unit: { code: line.unitCode } },
      select: { id: true, productId: true },
    });
    if (!unit) {
      throw new Error(`Không tìm thấy ${line.productCode}/${line.unitCode}. Chạy "npm run seed:catalog" trước.`);
    }
    items.push({
      productId: unit.productId,
      productUnitId: unit.id,
      quantity: line.quantity,
      importPrice: line.importPrice,
      batchNumber: line.batchNumber,
      expiryDate: addDaysToDateOnly(today, line.expiresInDays),
    });
  }
  return items;
}

void bootstrap();
