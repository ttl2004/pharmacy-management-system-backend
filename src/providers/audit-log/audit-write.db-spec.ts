import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import { PrismaClient, ProductType } from '@prisma/client';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthRole } from 'src/common/types/common.enum';
import { addDaysToDateOnly, todayInVietnam } from 'src/common/utils/date-only.util';
import { PrismaService } from 'src/common/databases/prisma.service';
import { DocumentCodeService } from 'src/modules/feature-inventory/core/document-code.service';
import { InventoryEvents } from 'src/modules/feature-inventory/core/inventory-events';
import { InventoryTransactions } from 'src/modules/feature-inventory/core/inventory-transactions';
import { StockBatchRepository } from 'src/modules/feature-inventory/core/stock-batch.repository';
import { StockIntakeService } from 'src/modules/feature-inventory/core/stock-intake.service';
import { StockLedgerRepository } from 'src/modules/feature-inventory/core/stock-ledger.repository';
import { StockLedgerService } from 'src/modules/feature-inventory/core/stock-ledger.service';
import { GoodsReceiptDraftBuilder } from 'src/modules/feature-inventory/goods-receipt/goods-receipt-draft.builder';
import { GoodsReceiptLocker } from 'src/modules/feature-inventory/goods-receipt/goods-receipt-locker';
import { GoodsReceiptService } from 'src/modules/feature-inventory/goods-receipt/goods-receipt.service';
import { GoodsReceiptRepository } from 'src/modules/feature-inventory/goods-receipt/repositories/goods-receipt.repository';
import { SupplierDebtRepository } from 'src/modules/feature-inventory/supplier-debt/repositories/supplier-debt.repository';
import { SupplierPaymentRepository } from 'src/modules/feature-inventory/supplier-debt/repositories/supplier-payment.repository';
import { SupplierPaymentWriter } from 'src/modules/feature-inventory/supplier-debt/supplier-payment.writer';
import { createTestPrisma, resetSchema } from 'src/test-support/db-test';
import { AuditLogService } from './audit-log.service';
import type { AuditEntry } from './audit-log.types';

/**
 * Ghi nhật ký THẬT qua service nghiệp vụ trên schema `audit_db_test` (không bao giờ `public`): Nest testing module tối
 * thiểu, `PrismaService` thay bằng client trỏ schema test — cùng câu lệnh, trigger, CHECK như production.
 */
describe('audit ghi thật (db)', () => {
  let prisma: PrismaClient;
  let receipts: GoodsReceiptService;
  let audit: AuditLogService;

  beforeAll(async () => {
    prisma = await createTestPrisma();
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: PrismaService, useValue: prisma },
        AuditLogService,
        InventoryTransactions,
        InventoryEvents,
        DocumentCodeService,
        StockLedgerRepository,
        StockLedgerService,
        StockBatchRepository,
        StockIntakeService,
        SupplierDebtRepository,
        SupplierPaymentRepository,
        SupplierPaymentWriter,
        GoodsReceiptRepository,
        GoodsReceiptLocker,
        GoodsReceiptDraftBuilder,
        GoodsReceiptService,
      ],
    }).compile();
    receipts = moduleRef.get(GoodsReceiptService);
    audit = moduleRef.get(AuditLogService);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetSchema(prisma);
  });

  /** Dữ liệu tối thiểu cho một phiếu nhập: người lập, chi nhánh, NCC, sản phẩm + đơn vị. */
  async function seed() {
    const role = await prisma.role.create({ data: { code: 'ADMIN', name: 'Quản trị', level: 90 } });
    const user = await prisma.user.create({ data: { fullName: 'Người lập phiếu', roleId: role.id } });
    const branch = await prisma.branch.create({
      data: { code: 'CN01', name: 'Chi nhánh 1', phone: '0900000001', address: 'Hà Nội' },
    });
    const supplier = await prisma.supplier.create({
      data: { code: 'NCC01', name: 'Nhà cung cấp', phone: '0900000002' },
    });
    const unit = await prisma.unit.create({ data: { code: 'VIEN', name: 'Viên' } });
    const category = await prisma.category.create({ data: { name: 'Thuốc' } });
    const product = await prisma.product.create({
      // GOODS: không cần gắn CSDL Dược (`products_drug_link_chk`), đủ cho luồng nhập kho.
      data: { code: 'SP01', name: 'Khẩu trang', type: ProductType.GOODS, categoryId: category.id, baseUnitId: unit.id },
    });
    const productUnit = await prisma.productUnit.create({
      data: { productId: product.id, unitId: unit.id, conversionRate: 1, salePrice: 1000, isBaseUnit: true },
    });
    return { user, branch, supplier, product, productUnit };
  }

  it('tạo phiếu nhập rồi xác nhận → đúng 2 dòng GOODS_RECEIPT.CREATED/CONFIRMED, phạm vi + searchText + actor + requestId', async () => {
    const { user, branch, supplier, product, productUnit } = await seed();
    const requestId = randomUUID();
    const actor = {
      user: { userId: user.id, role: AuthRole.ADMIN, branchId: null, email: null, sid: 's1' },
      ip: '10.0.0.1',
      userAgent: 'jest',
      requestId,
    } as unknown as RequestActor;

    const created = await receipts.create(
      {
        branchId: branch.id,
        supplierId: supplier.id,
        items: [
          {
            productId: product.id,
            productUnitId: productUnit.id,
            quantity: 10,
            importPrice: 700,
            batchNumber: 'LO-01',
            expiryDate: addDaysToDateOnly(todayInVietnam(), 400),
          },
        ],
      },
      actor,
    );
    await receipts.confirm(created.id, actor);

    const rows = await prisma.auditLog.findMany({ where: { entityId: created.id }, orderBy: { id: 'asc' } });
    expect(rows.map((row) => row.event)).toEqual(['GOODS_RECEIPT.CREATED', 'GOODS_RECEIPT.CONFIRMED']);
    for (const row of rows) {
      expect(row).toMatchObject({
        entityType: 'goods_receipts',
        entityLabel: created.code,
        branchIds: [branch.id],
        branchId: branch.id,
        actorId: user.id,
        actorType: 'USER',
        actorRoleCode: AuthRole.ADMIN,
        ipAddress: '10.0.0.1',
        requestId,
        amount: 7000n,
      });
      expect(row.searchText).toContain(created.code.toLowerCase());
    }
    // Không trả tiền khi nhập → không có dòng thanh toán nào khác trong cả bảng.
    expect(await prisma.auditLog.count()).toBe(2);
  });

  it('record() 3.500 entry trong một lần → không vượt giới hạn bind parameter, đủ 3.500 dòng', async () => {
    const { user, branch } = await seed();
    const entries: AuditEntry[] = Array.from({ length: 3500 }, (_, index) => ({
      event: 'BATCH.STATUS_CHANGED',
      entityType: 'batches',
      entityId: randomUUID(),
      entityLabel: `LO-${index}`,
      branchIds: [branch.id],
      searchTerms: [`LO-${index}`],
      before: { status: 'AVAILABLE' },
      after: { status: 'QUARANTINE' },
    }));
    await prisma.$transaction(
      (tx) =>
        audit.record(
          tx,
          { userId: user.id, type: 'USER', roleCode: 'ADMIN', branchId: null, ip: null, requestId: null },
          entries,
        ),
      { timeout: 60_000 },
    );
    expect(await prisma.auditLog.count({ where: { event: 'BATCH.STATUS_CHANGED' } })).toBe(3500);
  });
});
