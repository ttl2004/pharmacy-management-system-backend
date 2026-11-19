import { Test } from '@nestjs/testing';
import { PrismaClient, ProductType } from '@prisma/client';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { PrismaService } from 'src/common/databases/prisma.service';
import { AuthRole } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';
import { AuditLogService } from 'src/providers/audit-log/audit-log.service';
import { createTestPrisma, resetSchema } from 'src/test-support/db-test';
import { InventoryEvents } from '../core/inventory-events';
import { InventoryTransactions } from '../core/inventory-transactions';
import { StockBatchRepository } from '../core/stock-batch.repository';
import { StockIntakeService } from '../core/stock-intake.service';
import { StockLedgerRepository } from '../core/stock-ledger.repository';
import { StockLedgerService } from '../core/stock-ledger.service';
import { StockOpeningService } from './stock-opening.service';

/** M4 trên DB thật: hai lần "nhập tồn đầu" cùng lúc (bấm đúp) → một lần thành công, lần kia bị chặn, tồn không gấp đôi. */
describe('StockOpeningService — bấm đúp (db)', () => {
  let prisma: PrismaClient;
  let service: StockOpeningService;

  beforeAll(async () => {
    prisma = await createTestPrisma();
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: PrismaService, useValue: prisma },
        AuditLogService,
        InventoryTransactions,
        InventoryEvents,
        StockLedgerRepository,
        StockLedgerService,
        StockBatchRepository,
        StockIntakeService,
        StockOpeningService,
      ],
    }).compile();
    service = moduleRef.get(StockOpeningService);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetSchema(prisma);
  });

  it('hai request đồng thời: đúng một lô 10 cái, request còn lại 1xxx PRODUCT_HAS_STOCK', async () => {
    const role = await prisma.role.create({ data: { code: 'ADMIN', name: 'Quản trị', level: 90 } });
    const user = await prisma.user.create({ data: { fullName: 'Thủ kho', roleId: role.id } });
    const branch = await prisma.branch.create({
      data: { code: 'CN01', name: 'CN01', phone: '0900000001', address: 'HN' },
    });
    const unit = await prisma.unit.create({ data: { code: 'CAI', name: 'Cái' } });
    const category = await prisma.category.create({ data: { name: 'Vật tư' } });
    const product = await prisma.product.create({
      data: {
        code: 'SP01',
        name: 'Khẩu trang',
        type: ProductType.GOODS,
        categoryId: category.id,
        baseUnitId: unit.id,
        trackBatches: false,
      },
    });
    const actor = {
      user: { userId: user.id, role: AuthRole.ADMIN, branchId: null, email: null, sid: 's1', roleLevel: 90 },
      ip: null,
      userAgent: 'jest',
      requestId: null,
    } as unknown as RequestActor;
    const dto = { branchId: branch.id, productId: product.id, quantity: 10, unitCost: 2_000 };

    const results = await Promise.allSettled([service.create(dto, actor), service.create(dto, actor)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ errorCode: ErrorCode.PRODUCT_HAS_STOCK });

    const batches = await prisma.stockBatch.findMany({ where: { branchId: branch.id, productId: product.id } });
    expect(batches.map((b) => b.quantityOnHand)).toEqual([10]);
  });
});
