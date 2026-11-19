import { Test } from '@nestjs/testing';
import { Prisma, PrismaClient, StockMovementType, StockRefType } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from 'src/common/databases/prisma.service';
import { afterCursorDesc, decodeCursor, encodeCursor } from 'src/common/utils/keyset-cursor';
import { createTestPrisma, resetSchema } from 'src/test-support/db-test';
import { ReportBase, seedReportBase } from 'src/test-support/report-db-seed';
import { InventoryEvents } from '../../core/inventory-events';
import { StockLedgerRepository } from '../../core/stock-ledger.repository';
import { LedgerEntry, StockLedgerService } from '../../core/stock-ledger.service';
import { StockQueryRepository } from './stock-query.repository';

/**
 * B5: `productBalanceAfter` = tồn thuốc (mọi lô) sau từng bút toán. Bút toán ghi qua `StockLedgerService` thật nên
 * `stock_batches.quantityOnHand` và sổ kho khớp nhau như production; chân lý là cộng dồn sổ kho theo (createdAt, id).
 */
describe('StockQueryRepository.findMovementsWithProductBalance (db)', () => {
  let prisma: PrismaClient;
  let ledger: StockLedgerService;
  let repo: StockQueryRepository;
  let base: ReportBase;
  let actorId: string;

  beforeAll(async () => {
    prisma = await createTestPrisma();
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: PrismaService, useValue: prisma },
        StockLedgerRepository,
        StockLedgerService,
        InventoryEvents,
      ],
    }).compile();
    ledger = moduleRef.get(StockLedgerService);
    repo = new StockQueryRepository(prisma as unknown as PrismaService);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetSchema(prisma);
    base = await seedReportBase(prisma);
    const role = await prisma.role.create({ data: { code: 'ADMIN', name: 'Quản trị', level: 90 } });
    actorId = (await prisma.user.create({ data: { fullName: 'Thủ kho', roleId: role.id } })).id;
  });

  const wait = (ms = 8) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Một transaction = một lần `apply` (các bút toán cùng `createdAt`); nghỉ vài ms để các transaction khác mốc giờ. */
  async function write(entries: (Omit<LedgerEntry, 'refType' | 'refId' | 'unitCost'> & { batchId: string })[]) {
    await prisma.$transaction((tx) =>
      ledger.apply(
        { tx, afterCommit: () => undefined },
        entries.map((e) => ({ ...e, unitCost: 500, refType: StockRefType.STOCK_ADJUSTMENT, refId: randomUUID() })),
        actorId,
      ),
    );
    await wait();
  }

  async function seedHistory() {
    const [b1, p1, p2] = [base.branches[0].id, base.products[0].id, base.products[1].id];
    const a = base.batches[`${b1}:${p1}`].id;
    const b = (
      await prisma.stockBatch.create({
        data: {
          branchId: b1,
          productId: p1,
          batchNumber: 'LO-02',
          expiryDate: new Date('2031-01-01'),
          importPrice: 500,
        },
      })
    ).id;
    const other = base.batches[`${b1}:${p2}`].id;
    const imp = StockMovementType.IMPORT;
    const sale = StockMovementType.SALE;
    await write([
      { batchId: a, type: imp, quantity: 10 },
      { batchId: b, type: imp, quantity: 20 }, // cùng transaction với dòng trên
    ]);
    await write([{ batchId: other, type: imp, quantity: 99 }]); // sản phẩm khác xen vào
    await write([{ batchId: a, type: sale, quantity: -3 }]);
    await write([
      { batchId: b, type: imp, quantity: 5 },
      { batchId: a, type: sale, quantity: -2 }, // hai dòng cùng createdAt
    ]);
    await write([{ batchId: b, type: StockMovementType.ADJUST, quantity: -4 }]);
    return { b1, p1, a, b };
  }

  /** Chân lý: cộng dồn mọi bút toán của (chi nhánh, sản phẩm) theo (createdAt, id) tăng dần. */
  async function trueBalances(branchId: string, productId: string) {
    const all = await prisma.stockMovement.findMany({
      where: { branchId, productId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    let running = 0;
    return new Map(all.map((m) => [m.id, (running += m.quantity)]));
  }

  it('mọi dòng bằng số dư chạy thật của thuốc (kể cả hai dòng cùng transaction); dòng mới nhất = tồn hiện tại', async () => {
    const { b1, p1 } = await seedHistory();
    const rows = await repo.findMovementsWithProductBalance({ branchId: b1, productId: p1 }, 100);
    const truth = await trueBalances(b1, p1);
    expect(rows).toHaveLength(6);
    for (const row of rows) expect(row.productBalanceAfter).toBe(truth.get(row.id));
    const onHand = await prisma.stockBatch.aggregate({
      where: { branchId: b1, productId: p1 },
      _sum: { quantityOnHand: true },
    });
    expect(onHand._sum.quantityOnHand).toBe(26);
    expect(rows[0].productBalanceAfter).toBe(26);
    // hai dòng cùng createdAt vẫn tự nhất quán: dòng liền nhau lệch đúng bằng số lượng của dòng đứng trên
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].productBalanceAfter - rows[i].productBalanceAfter).toBe(rows[i - 1].quantity);
    }
    expect(rows.some((r, i) => i > 0 && r.createdAt.getTime() === rows[i - 1].createdAt.getTime())).toBe(true);
  });

  it('không lọc sản phẩm: mỗi dòng theo thuốc của nó, thuốc khác không lẫn vào', async () => {
    const { b1, p1 } = await seedHistory();
    const rows = await repo.findMovementsWithProductBalance({ branchId: b1 }, 100);
    expect(rows).toHaveLength(7);
    const truthP1 = await trueBalances(b1, p1);
    for (const row of rows) {
      if (row.product.id === p1) expect(row.productBalanceAfter).toBe(truthP1.get(row.id));
      else expect(row.productBalanceAfter).toBe(99);
    }
  });

  it('lọc theo lô / loại: vẫn là tồn THUỐC (mọi lô, mọi loại), không phải tồn lô', async () => {
    const { b1, p1, b } = await seedHistory();
    const truth = await trueBalances(b1, p1);
    const byBatch = await repo.findMovementsWithProductBalance({ batchId: b }, 100);
    expect(byBatch).toHaveLength(3);
    for (const row of byBatch) expect(row.productBalanceAfter).toBe(truth.get(row.id));
    expect(byBatch.map((r) => r.productBalanceAfter)).not.toEqual(byBatch.map((r) => r.balanceAfter));

    const bySale = await repo.findMovementsWithProductBalance({ type: StockMovementType.SALE }, 100);
    expect(bySale).toHaveLength(2);
    for (const row of bySale) expect(row.productBalanceAfter).toBe(truth.get(row.id));
  });

  it('trang sau (cursor) vẫn đúng, kể cả khi trang cắt giữa hai dòng cùng createdAt', async () => {
    const { b1, p1 } = await seedHistory();
    const truth = await trueBalances(b1, p1);
    let cursor: ReturnType<typeof decodeCursor> | null = null;
    const seen: string[] = [];
    for (let guard = 0; guard < 10; guard++) {
      const where: Prisma.StockMovementWhereInput = {
        AND: [{ branchId: b1, productId: p1 }, ...(cursor ? [afterCursorDesc(cursor)] : [])],
      };
      const page = await repo.findMovementsWithProductBalance(where, 2);
      if (!page.length) break;
      for (const row of page) {
        expect(row.productBalanceAfter).toBe(truth.get(row.id));
        seen.push(row.id);
      }
      cursor = decodeCursor(encodeCursor(page[page.length - 1]));
    }
    expect(seen).toHaveLength(6);
  });

  it('bút toán ghi SAU khi trang đã tính không làm đổi giá trị đã trả; trang mới có dòng mới nhất = tồn mới', async () => {
    const { b1, p1, a } = await seedHistory();
    const before = await repo.findMovementsWithProductBalance({ branchId: b1, productId: p1 }, 100);
    await write([{ batchId: a, type: StockMovementType.SALE, quantity: -1 }]);
    const after = await repo.findMovementsWithProductBalance({ branchId: b1, productId: p1 }, 100);
    expect(after[0].productBalanceAfter).toBe(25);
    expect(after.slice(1).map((r) => r.productBalanceAfter)).toEqual(before.map((r) => r.productBalanceAfter));
  });

  it('trang rỗng → mảng rỗng, không gọi SQL cộng dồn', async () => {
    expect(await repo.findMovementsWithProductBalance({ branchId: randomUUID() }, 10)).toEqual([]);
  });
});
