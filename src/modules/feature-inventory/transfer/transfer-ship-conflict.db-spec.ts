import { Test } from '@nestjs/testing';
import { PrismaClient, ProductType } from '@prisma/client';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { PrismaService } from 'src/common/databases/prisma.service';
import { AuthRole } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';
import { addDaysToDateOnly, parseDateOnly, todayInVietnam } from 'src/common/utils/date-only.util';
import { AuditLogService } from 'src/providers/audit-log/audit-log.service';
import { createTestPrisma, resetSchema } from 'src/test-support/db-test';
import { DocumentCodeService } from '../core/document-code.service';
import { InventoryEvents } from '../core/inventory-events';
import { InventoryTransactions } from '../core/inventory-transactions';
import { StockBatchRepository } from '../core/stock-batch.repository';
import { StockIntakeService } from '../core/stock-intake.service';
import { StockLedgerRepository } from '../core/stock-ledger.repository';
import { StockLedgerService } from '../core/stock-ledger.service';
import { TransferRepository } from './repositories/transfer.repository';
import { TransferService } from './transfer.service';

/** K4 trên DB thật: chi nhánh nhận đã có lô cùng số khác hạn dùng → xuất bị từ chối, không trừ kho gửi. */
describe('xuất điều chuyển kiểm trước chi nhánh nhận (db)', () => {
  let prisma: PrismaClient;
  let transfers: TransferService;

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
        TransferRepository,
        TransferService,
      ],
    }).compile();
    transfers = moduleRef.get(TransferService);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetSchema(prisma);
  });

  it('đích có lô A123 khác hạn (còn hàng) → 1703 lúc xuất, kho gửi nguyên, phiếu vẫn PENDING', async () => {
    const role = await prisma.role.create({ data: { code: 'ADMIN', name: 'Quản trị', level: 90 } });
    const user = await prisma.user.create({ data: { fullName: 'Thủ kho', roleId: role.id } });
    const [a, b] = await Promise.all(
      ['CN01', 'CN02'].map((code, i) =>
        prisma.branch.create({ data: { code, name: code, phone: `090000000${i}`, address: 'Hà Nội' } }),
      ),
    );
    const unit = await prisma.unit.create({ data: { code: 'HOP', name: 'Hộp' } });
    const category = await prisma.category.create({ data: { name: 'Thuốc' } });
    const product = await prisma.product.create({
      data: { code: 'SP01', name: 'Panadol', type: ProductType.GOODS, categoryId: category.id, baseUnitId: unit.id },
    });
    const day = (n: number) => parseDateOnly(addDaysToDateOnly(todayInVietnam(), n));
    const source = await prisma.stockBatch.create({
      data: {
        branchId: a.id,
        productId: product.id,
        batchNumber: 'A123',
        expiryDate: day(400),
        quantityOnHand: 50,
        importPrice: 1_000,
      },
    });
    await prisma.stockBatch.create({
      data: {
        branchId: b.id,
        productId: product.id,
        batchNumber: 'A123',
        expiryDate: day(500),
        quantityOnHand: 5,
        importPrice: 1_000,
      },
    });
    const actor = {
      user: { userId: user.id, role: AuthRole.ADMIN, branchId: null, email: null, sid: 's1' },
      ip: '10.0.0.1',
      userAgent: 'jest',
      requestId: null,
    } as unknown as RequestActor;

    const created = await transfers.create(
      { fromBranchId: a.id, toBranchId: b.id, note: 'Bổ sung', items: [{ batchId: source.id, quantity: 20 }] },
      actor,
    );
    await expect(transfers.ship(created.id, actor)).rejects.toMatchObject({
      errorCode: ErrorCode.BATCH_EXPIRY_MISMATCH,
    });

    expect((await prisma.stockBatch.findUniqueOrThrow({ where: { id: source.id } })).quantityOnHand).toBe(50);
    expect(await prisma.stockMovement.count()).toBe(0);
    expect((await prisma.stockTransfer.findUniqueOrThrow({ where: { id: created.id } })).status).toBe('PENDING');
  });
});
