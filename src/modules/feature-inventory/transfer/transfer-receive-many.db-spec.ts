import { Test } from '@nestjs/testing';
import { PrismaClient, ProductType, type StockBatch } from '@prisma/client';
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
import { TransferRepository } from './repositories/transfer.repository';
import { TransferService } from './transfer.service';

describe('điều chuyển nhận nhiều dòng — một câu UPDATE (db, K3)', () => {
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

  it('nhận phiếu 5 dòng: mỗi dòng ghi đúng số nhận + lý do (hoặc null), updatedBy được ghi', async () => {
    const role = await prisma.role.create({ data: { code: 'ADMIN', name: 'Quản trị', level: 90 } });
    const user = await prisma.user.create({ data: { fullName: 'Thủ kho', roleId: role.id } });
    const [a, b] = await Promise.all(
      ['CN01', 'CN02'].map((code, i) =>
        prisma.branch.create({ data: { code, name: code, phone: `090000000${i}`, address: 'Hà Nội' } }),
      ),
    );
    const unit = await prisma.unit.create({ data: { code: 'HOP', name: 'Hộp' } });
    const category = await prisma.category.create({ data: { name: 'Thuốc' } });
    const expiryDate = parseDateOnly(addDaysToDateOnly(todayInVietnam(), 400));
    const lots: StockBatch[] = [];
    for (let i = 0; i < 5; i++) {
      const product = await prisma.product.create({
        data: {
          code: `SP0${i}`,
          name: `SP ${i}`,
          type: ProductType.GOODS,
          categoryId: category.id,
          baseUnitId: unit.id,
        },
      });
      lots.push(
        await prisma.stockBatch.create({
          data: {
            branchId: a.id,
            productId: product.id,
            batchNumber: 'LO-01',
            expiryDate,
            quantityOnHand: 50,
            importPrice: 1_000,
          },
        }),
      );
    }
    const actor = {
      user: { userId: user.id, role: AuthRole.ADMIN, branchId: null, email: null, sid: 's1' },
      ip: '10.0.0.1',
      userAgent: 'jest',
      requestId: null,
    } as unknown as RequestActor;

    const created = await transfers.create(
      {
        fromBranchId: a.id,
        toBranchId: b.id,
        note: 'Nhiều dòng',
        items: lots.map((l) => ({ batchId: l.id, quantity: 50 })),
      },
      actor,
    );
    await transfers.ship(created.id, actor);
    const items = await prisma.stockTransferItem.findMany({ where: { transferId: created.id } });
    const itemOf = (batchId: string) => items.find((i) => i.batchId === batchId)!.id;
    // Nhận 50, 49, 48, 47, 46 — dòng đủ không cần lý do, dòng thiếu có lý do.
    const received = [50, 49, 48, 47, 46];
    await transfers.receive(created.id, actor, {
      lines: lots.map((l, i) => ({
        itemId: itemOf(l.id),
        receivedQuantity: received[i],
        ...(received[i] < 50 ? { varianceReason: `Lý do ${i}` } : {}),
      })),
    });

    const after = await prisma.stockTransferItem.findMany({ where: { transferId: created.id } });
    lots.forEach((l, i) => {
      const row = after.find((r) => r.batchId === l.id)!;
      expect(row.receivedQuantity).toBe(received[i]);
      expect(row.varianceReason).toBe(received[i] < 50 ? `Lý do ${i}` : null);
      expect(row.updatedBy).toBe(user.id);
    });
  });
});
