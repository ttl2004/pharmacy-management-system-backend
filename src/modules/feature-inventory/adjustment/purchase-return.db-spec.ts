import { Test } from '@nestjs/testing';
import { PrismaClient, ProductType } from '@prisma/client';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { PrismaService } from 'src/common/databases/prisma.service';
import { AuthRole } from 'src/common/types/common.enum';
import { addDaysToDateOnly, todayInVietnam } from 'src/common/utils/date-only.util';
import { AuditLogService } from 'src/providers/audit-log/audit-log.service';
import { createTestPrisma, resetSchema } from 'src/test-support/db-test';
import { DocumentCodeService } from '../core/document-code.service';
import { InventoryEvents } from '../core/inventory-events';
import { InventoryTransactions } from '../core/inventory-transactions';
import { StockBatchRepository } from '../core/stock-batch.repository';
import { StockIntakeService } from '../core/stock-intake.service';
import { StockLedgerRepository } from '../core/stock-ledger.repository';
import { StockLedgerService } from '../core/stock-ledger.service';
import { GoodsReceiptDraftBuilder } from '../goods-receipt/goods-receipt-draft.builder';
import { GoodsReceiptLocker } from '../goods-receipt/goods-receipt-locker';
import { GoodsReceiptService } from '../goods-receipt/goods-receipt.service';
import { GoodsReceiptRepository } from '../goods-receipt/repositories/goods-receipt.repository';
import { SupplierDebtRepository } from '../supplier-debt/repositories/supplier-debt.repository';
import { SupplierPaymentRepository } from '../supplier-debt/repositories/supplier-payment.repository';
import { SupplierPaymentWriter } from '../supplier-debt/supplier-payment.writer';
import { AdjustmentService } from './adjustment.service';
import { PurchaseReturnMoneyService } from './purchase-return-money.service';
import { AdjustmentRepository } from './repositories/adjustment.repository';
import { PurchaseReturnRepository } from './repositories/purchase-return.repository';

/** Xác nhận phiếu trả NCC thật trên schema `audit_db_test`: nợ không âm, kể cả khi hai phiếu cùng NCC chạy song song. */
describe('phiếu trả NCC — công nợ không âm (db)', () => {
  let prisma: PrismaClient;
  let receipts: GoodsReceiptService;
  let adjustments: AdjustmentService;

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
        AdjustmentRepository,
        PurchaseReturnRepository,
        PurchaseReturnMoneyService,
        AdjustmentService,
      ],
    }).compile();
    receipts = moduleRef.get(GoodsReceiptService);
    adjustments = moduleRef.get(AdjustmentService);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetSchema(prisma);
  });

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
      data: { code: 'SP01', name: 'Khẩu trang', type: ProductType.GOODS, categoryId: category.id, baseUnitId: unit.id },
    });
    const productUnit = await prisma.productUnit.create({
      data: { productId: product.id, unitId: unit.id, conversionRate: 1, salePrice: 1000, isBaseUnit: true },
    });
    const actor = {
      user: { userId: user.id, role: AuthRole.ADMIN, branchId: null, email: null, sid: 's1' },
      ip: '10.0.0.1',
      userAgent: 'jest',
      requestId: null,
    } as unknown as RequestActor;
    // Nhập 100 viên × 700 = 70.000 nợ, rồi giảm nợ còn 35.000 (điều chỉnh âm 35.000).
    const created = await receipts.create(
      {
        branchId: branch.id,
        supplierId: supplier.id,
        items: [
          {
            productId: product.id,
            productUnitId: productUnit.id,
            quantity: 100,
            importPrice: 700,
            batchNumber: 'LO-01',
            expiryDate: addDaysToDateOnly(todayInVietnam(), 400),
          },
        ],
      },
      actor,
    );
    await receipts.confirm(created.id, actor);
    await prisma.supplierDebtAdjustment.create({
      data: {
        code: 'DC01',
        supplierId: supplier.id,
        branchId: branch.id,
        adjustedAt: new Date(),
        debtBefore: 70000n,
        debtAfter: 35000n,
        delta: -35000n,
        note: 'Thoả thuận giảm nợ',
      },
    });
    const batch = await prisma.stockBatch.findFirstOrThrow({ where: { branchId: branch.id } });
    return { branch, supplier, batch, actor };
  }

  const draftReturn = (s: Awaited<ReturnType<typeof seed>>, quantity: number) =>
    adjustments.create(
      {
        branchId: s.branch.id,
        type: 'RETURN_TO_SUPPLIER',
        supplierId: s.supplier.id,
        reason: 'Trả hàng lỗi',
        items: [{ batchId: s.batch.id, quantity }],
      } as never,
      s.actor,
    );

  it('hai phiếu trả cùng NCC xác nhận song song, mỗi phiếu một mình hợp lệ nhưng cộng lại làm nợ âm → đúng một phiếu thành công', async () => {
    const s = await seed();
    // Mỗi phiếu: 30 × 700 = 21.000 ≤ nợ 35.000; cộng lại 42.000 > 35.000.
    const [first, second] = [await draftReturn(s, 30), await draftReturn(s, 30)];

    const results = await Promise.allSettled([
      adjustments.confirm(first.id, s.actor),
      adjustments.confirm(second.id, s.actor),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(String((failed.reason as Error).message)).toContain('công nợ');
    const confirmed = await prisma.stockAdjustment.count({ where: { status: 'CONFIRMED' } });
    expect(confirmed).toBe(1);
    const batch = await prisma.stockBatch.findUniqueOrThrow({ where: { id: s.batch.id } });
    expect(batch.quantityOnHand).toBe(70);
    const debt = await new SupplierDebtRepository(prisma as never).debtOf(s.supplier.id, s.branch.id);
    expect(debt.scoped).toBe(14000n);
  });

  it('một phiếu trả vượt nợ hiện có → bị từ chối, tồn và nợ không đổi', async () => {
    const s = await seed();
    const draft = await draftReturn(s, 60); // 42.000 > 35.000
    await expect(adjustments.confirm(draft.id, s.actor)).rejects.toThrow('công nợ');
    const batch = await prisma.stockBatch.findUniqueOrThrow({ where: { id: s.batch.id } });
    expect(batch.quantityOnHand).toBe(100);
    const row = await prisma.stockAdjustment.findUniqueOrThrow({ where: { id: draft.id } });
    expect(row.status).toBe('DRAFT');
  });
});
