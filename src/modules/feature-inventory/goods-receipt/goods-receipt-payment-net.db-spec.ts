import { Test } from '@nestjs/testing';
import { AdjustmentType, PrismaClient, ProductType, ReceiptStatus } from '@prisma/client';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { PrismaService } from 'src/common/databases/prisma.service';
import { AuthRole } from 'src/common/types/common.enum';
import { addDaysToDateOnly, todayInVietnam } from 'src/common/utils/date-only.util';
import { PermissionService } from 'src/modules/feature-auth/permission/permission.service';
import { AuditLogService } from 'src/providers/audit-log/audit-log.service';
import { createTestPrisma, resetSchema } from 'src/test-support/db-test';
import { DocumentCodeService } from '../core/document-code.service';
import { InventoryEvents } from '../core/inventory-events';
import { InventoryTransactions } from '../core/inventory-transactions';
import { StockBatchRepository } from '../core/stock-batch.repository';
import { StockIntakeService } from '../core/stock-intake.service';
import { StockLedgerRepository } from '../core/stock-ledger.repository';
import { StockLedgerService } from '../core/stock-ledger.service';
import { SupplierDebtRepository } from '../supplier-debt/repositories/supplier-debt.repository';
import { SupplierPaymentRepository } from '../supplier-debt/repositories/supplier-payment.repository';
import { SupplierPaymentWriter } from '../supplier-debt/supplier-payment.writer';
import { GoodsReceiptDraftBuilder } from './goods-receipt-draft.builder';
import { GoodsReceiptLocker } from './goods-receipt-locker';
import { GoodsReceiptPaymentService } from './goods-receipt-payment.service';
import { GoodsReceiptService } from './goods-receipt.service';
import { GoodsReceiptRepository } from './repositories/goods-receipt.repository';

/** Thanh toán phiếu nhập theo nợ thật (đã trừ trả hàng NCC) trên schema thật. */
describe('thanh toán phiếu nhập — nợ thật sau trả hàng (db)', () => {
  let prisma: PrismaClient;
  let receipts: GoodsReceiptService;
  let payments: GoodsReceiptPaymentService;
  let repo: GoodsReceiptRepository;

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
        GoodsReceiptPaymentService,
        {
          provide: PermissionService,
          useValue: {
            getGrantedCodes: () => Promise.resolve(new Set(['goods-receipt:create', 'supplier-debt:write'])),
          },
        },
      ],
    }).compile();
    receipts = moduleRef.get(GoodsReceiptService);
    payments = moduleRef.get(GoodsReceiptPaymentService);
    repo = moduleRef.get(GoodsReceiptRepository);
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
    const supplier = await prisma.supplier.create({ data: { code: 'NCC01', name: 'NCC', phone: '0900000002' } });
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
    // 100 × 5.000 = 500.000.
    const created = await receipts.create(
      {
        branchId: branch.id,
        supplierId: supplier.id,
        items: [
          {
            productId: product.id,
            productUnitId: productUnit.id,
            quantity: 100,
            importPrice: 5000,
            batchNumber: 'LO-01',
            expiryDate: addDaysToDateOnly(todayInVietnam(), 400),
          },
        ],
      },
      actor,
    );
    await receipts.confirm(created.id, actor);
    return { branch, supplier, actor, receiptId: created.id };
  }

  let seq = 0;
  const addReturn = (
    s: Awaited<ReturnType<typeof seed>>,
    status: ReceiptStatus,
    total: bigint,
    paid: bigint,
    extra: { isDeleted?: boolean } = {},
  ) =>
    prisma.stockAdjustment.create({
      data: {
        code: `TH${++seq}`,
        branchId: s.branch.id,
        supplierId: s.supplier.id,
        goodsReceiptId: s.receiptId,
        type: AdjustmentType.RETURN_TO_SUPPLIER,
        status,
        reason: 'Trả hàng',
        cancelReason: status === ReceiptStatus.CANCELLED ? 'Huỷ' : null,
        goodsAmount: total,
        totalAmount: total,
        supplierPaid: paid,
        confirmedAt: status === ReceiptStatus.DRAFT ? null : new Date(),
        ...extra,
      },
    });

  it('returnedAmount = Σ(tổng − hoàn tiền ngay) của phiếu trả đã xác nhận; nháp/huỷ/xoá bị bỏ qua', async () => {
    const s = await seed();
    await addReturn(s, ReceiptStatus.CONFIRMED, 200_000n, 50_000n);
    await addReturn(s, ReceiptStatus.DRAFT, 80_000n, 0n);
    await addReturn(s, ReceiptStatus.CANCELLED, 90_000n, 0n);
    await addReturn(s, ReceiptStatus.CONFIRMED, 70_000n, 0n, { isDeleted: true });
    const detail = await repo.findDetail(s.receiptId, {});
    expect(detail?.returnedAmount).toBe(150_000n);
  });

  it('PATCH payment: vượt nợ thật bị từ chối, đúng nợ thật được nhận và lập phiếu chi đúng số', async () => {
    const s = await seed();
    await addReturn(s, ReceiptStatus.CONFIRMED, 200_000n, 50_000n); // nợ thật = 500.000 − 150.000 = 350.000
    await expect(payments.updatePayment(s.receiptId, { paidAmount: 350_001 } as never, s.actor)).rejects.toThrow(
      'Tổng đã trả vượt số nợ của phiếu (đã trừ trả hàng): tối đa 350000',
    );
    expect(await prisma.supplierPayment.count()).toBe(0);

    const result = await payments.updatePayment(s.receiptId, { paidAmount: 350_000 } as never, s.actor);
    expect(result.paidAmount).toBe(350_000n);
    expect(result.returnedAmount).toBe(150_000n);
    const vouchers = await prisma.supplierPayment.findMany();
    expect(vouchers).toHaveLength(1);
    expect(vouchers[0].amount).toBe(350_000n);
  });
});
