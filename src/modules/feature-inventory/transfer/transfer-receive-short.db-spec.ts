import { Test } from '@nestjs/testing';
import { PrismaClient, ProductType, StockMovementType } from '@prisma/client';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { PrismaService } from 'src/common/databases/prisma.service';
import { AuthRole } from 'src/common/types/common.enum';
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
import { StockQueryRepository } from '../stock/repositories/stock-query.repository';
import { TransferRepository } from './repositories/transfer.repository';
import { TransferService } from './transfer.service';

/** T1 trên DB thật: chuyển 100, nhận thiếu → phần thiếu thành hao hụt ở chi nhánh nhận, sổ kho khớp tồn lô. */
describe('điều chuyển nhận thiếu → hao hụt ở chi nhánh nhận (db)', () => {
  let prisma: PrismaClient;
  let transfers: TransferService;
  let stockQuery: StockQueryRepository;

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
    stockQuery = new StockQueryRepository(prisma as unknown as PrismaService);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetSchema(prisma);
  });

  async function seed() {
    const role = await prisma.role.create({ data: { code: 'ADMIN', name: 'Quản trị', level: 90 } });
    const user = await prisma.user.create({ data: { fullName: 'Thủ kho', roleId: role.id } });
    const [a, b] = await Promise.all(
      ['CN01', 'CN02'].map((code, i) =>
        prisma.branch.create({ data: { code, name: code, phone: `090000000${i}`, address: 'Hà Nội' } }),
      ),
    );
    const unit = await prisma.unit.create({ data: { code: 'HOP', name: 'Hộp' } });
    const category = await prisma.category.create({ data: { name: 'Thuốc' } });
    const [p1, p2] = await Promise.all(
      ['Panadol', 'Vitamin C'].map((name, i) =>
        prisma.product.create({
          data: { code: `SP0${i + 1}`, name, type: ProductType.GOODS, categoryId: category.id, baseUnitId: unit.id },
        }),
      ),
    );
    const expiryDate = parseDateOnly(addDaysToDateOnly(todayInVietnam(), 400));
    const lot = (productId: string, quantity: number, importPrice: number) =>
      prisma.stockBatch.create({
        data: { branchId: a.id, productId, batchNumber: 'LO-01', expiryDate, quantityOnHand: quantity, importPrice },
      });
    const [l1, l2] = await Promise.all([lot(p1.id, 100, 50_000), lot(p2.id, 10, 2_000)]);
    const actor = {
      user: { userId: user.id, role: AuthRole.ADMIN, branchId: null, email: null, sid: 's1' },
      ip: '10.0.0.1',
      userAgent: 'jest',
      requestId: null,
    } as unknown as RequestActor;
    return { a, b, p1, p2, l1, l2, actor };
  }

  it('gửi 100 + 10, nhận 90 + 0 → kho nhận còn 90, hao hụt 20 hộp ghi ở chi nhánh nhận, nhật ký có tiền', async () => {
    const { a, b, p1, p2, l1, l2, actor } = await seed();
    const created = await transfers.create(
      {
        fromBranchId: a.id,
        toBranchId: b.id,
        note: 'Bổ sung hàng',
        items: [
          { batchId: l1.id, quantity: 100 },
          { batchId: l2.id, quantity: 10 },
        ],
      },
      actor,
    );
    await transfers.ship(created.id, actor);
    const items = await prisma.stockTransferItem.findMany({ where: { transferId: created.id } });
    const itemOf = (batchId: string) => items.find((i) => i.batchId === batchId)!.id;
    await transfers.receive(created.id, actor, {
      lines: [
        { itemId: itemOf(l1.id), receivedQuantity: 90, varianceReason: 'Rơi vỡ' },
        { itemId: itemOf(l2.id), receivedQuantity: 0, varianceReason: 'Thất lạc' },
      ],
    });

    const destBatches = await prisma.stockBatch.findMany({ where: { branchId: b.id }, orderBy: { productId: 'asc' } });
    const dest = (productId: string) => destBatches.find((x) => x.productId === productId)!;
    expect(dest(p1.id)).toMatchObject({ quantityOnHand: 90, importPrice: 50_000 });
    // Dòng nhận 0 vẫn có lô nhận (tồn 0) để mang bút toán hao hụt.
    expect(dest(p2.id)).toMatchObject({ quantityOnHand: 0, importPrice: 2_000 });

    // Sổ kho mỗi lô khớp tồn lô; hao hụt là DISPOSE ở chi nhánh nhận.
    for (const batch of destBatches) {
      const sum = await prisma.stockMovement.aggregate({ where: { batchId: batch.id }, _sum: { quantity: true } });
      expect(sum._sum.quantity).toBe(batch.quantityOnHand);
    }
    const disposed = await prisma.stockMovement.findMany({
      where: { branchId: b.id, type: StockMovementType.DISPOSE },
      orderBy: [{ quantity: 'asc' }, { unitCost: 'asc' }],
    });
    expect(disposed.map((m) => [m.quantity, m.unitCost])).toEqual([
      [-10, 2_000],
      [-10, 50_000],
    ]);
    expect(disposed.every((m) => m.note?.startsWith('Hao hụt điều chuyển'))).toBe(true);

    // Toàn chuỗi: 110 rời A = 90 còn ở B + 20 hao hụt — không còn hàng "biến mất".
    const today = todayInVietnam();
    const summary = await stockQuery.findMovementSummary({
      from: parseDateOnly(addDaysToDateOnly(today, -1)),
      toExclusive: parseDateOnly(addDaysToDateOnly(today, 2)),
    });
    const row = (productId: string) => summary.find((r) => r.productId === productId)!;
    expect(row(p1.id)).toMatchObject({ disposeQty: -10, transferInQty: 100, transferOutQty: -100 });
    expect(row(p2.id)).toMatchObject({ disposeQty: -10, transferInQty: 10, transferOutQty: -10 });

    const log = await prisma.auditLog.findFirst({ where: { event: 'TRANSFER.RECEIVED_SHORT' } });
    expect(log).toMatchObject({ amount: 520_000n, severity: 2 });
    expect(log!.reason!.split('; ').sort()).toEqual(['Rơi vỡ', 'Thất lạc']);
  });
});
