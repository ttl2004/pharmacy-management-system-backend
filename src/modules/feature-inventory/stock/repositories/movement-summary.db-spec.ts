import { PrismaClient, StockMovementType, StockRefType } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from 'src/common/databases/prisma.service';
import { addDaysToDateOnly, vietnamDayStartUtc } from 'src/common/utils/date-only.util';
import { createTestPrisma, resetSchema } from 'src/test-support/db-test';
import { ReportBase, seedReportBase } from 'src/test-support/report-db-seed';
import { MovementSummaryRow, StockQueryRepository, monthlyBoundary } from './stock-query.repository';

/**
 * Nhập–xuất–tồn (T4) trên PostgreSQL thật: so với cách tính "chân lý" (cộng mọi bút toán từ đầu sổ) ở nhiều kỳ,
 * cả khi bảng tháng chưa dựng, đã dựng, và có bút toán mới sau khi dựng.
 */
describe('StockQueryRepository.findMovementSummary — bảng tháng (db)', () => {
  let prisma: PrismaClient;
  let base: ReportBase;
  let repo: StockQueryRepository;

  beforeAll(async () => {
    prisma = await createTestPrisma();
    repo = new StockQueryRepository(prisma as unknown as PrismaService);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetSchema(prisma);
    base = await seedReportBase(prisma);
  });

  interface Mv {
    branch: number;
    product: number;
    at: Date;
    type: StockMovementType;
    qty: number;
    cost: number | null;
  }

  const insert = (rows: Mv[]) =>
    prisma.stockMovement.createMany({
      data: rows.map((r) => {
        const branchId = base.branches[r.branch].id;
        const productId = base.products[r.product].id;
        return {
          branchId,
          productId,
          batchId: base.batches[`${branchId}:${productId}`].id,
          type: r.type,
          quantity: r.qty,
          balanceAfter: 0,
          unitCost: r.cost,
          refType: StockRefType.STOCK_ADJUSTMENT,
          refId: randomUUID(),
          createdAt: r.at,
        };
      }),
    });

  /** Chân lý: cộng thẳng mọi bút toán (như câu SQL cũ), tính ở JS. */
  async function oracle(branch: number | null, from: Date, toExclusive: Date) {
    const rows = await prisma.stockMovement.findMany({
      where: {
        createdAt: { lt: toExclusive },
        ...(branch === null ? {} : { branchId: base.branches[branch].id }),
      },
    });
    const by = new Map<string, Record<string, number>>();
    for (const m of rows) {
      const r = by.get(m.productId) ?? {
        opening: 0,
        openingValue: 0,
        inQuantity: 0,
        outQuantity: 0,
        inValue: 0,
        outValue: 0,
        saleQty: 0,
        importQty: 0,
      };
      const value = m.quantity * (m.unitCost ?? 0);
      if (m.createdAt < from) {
        r.opening += m.quantity;
        r.openingValue += value;
      } else {
        if (m.quantity > 0) {
          r.inQuantity += m.quantity;
          r.inValue += value;
        } else {
          r.outQuantity -= m.quantity;
          r.outValue -= value;
        }
        if (m.type === StockMovementType.SALE) r.saleQty += m.quantity;
        if (m.type === StockMovementType.IMPORT) r.importQty += m.quantity;
      }
      by.set(m.productId, r);
    }
    return by;
  }

  function expectMatches(actual: MovementSummaryRow[], expected: Map<string, Record<string, number>>) {
    expect(new Set(actual.map((r) => r.productId))).toEqual(new Set(expected.keys()));
    for (const row of actual) {
      const e = expected.get(row.productId)!;
      expect({
        opening: row.opening,
        openingValue: row.openingValue,
        inQuantity: row.inQuantity,
        outQuantity: row.outQuantity,
        inValue: row.inValue,
        outValue: row.outValue,
        saleQty: row.saleQty,
        importQty: row.importQty,
      }).toEqual(e);
      expect(row.closing).toBe(e.opening + e.inQuantity - e.outQuantity);
      expect(row.closingValue).toBe(e.openingValue + e.inValue - e.outValue);
    }
  }

  const vn = (date: string, time = '10:00') => new Date(`${date}T${time}:00.000+07:00`);
  const period = (fromDate: string, toDate: string) => ({
    from: vietnamDayStartUtc(fromDate),
    toExclusive: vietnamDayStartUtc(addDaysToDateOnly(toDate, 1)),
  });

  async function seedHistory() {
    await insert([
      { branch: 0, product: 0, at: vn('2026-06-05'), type: 'IMPORT', qty: 100, cost: 500 },
      { branch: 1, product: 0, at: vn('2026-06-20'), type: 'IMPORT', qty: 40, cost: 520 },
      { branch: 0, product: 0, at: vn('2026-07-03'), type: 'SALE', qty: -30, cost: 500 },
      { branch: 0, product: 1, at: vn('2026-07-31', '23:59'), type: 'IMPORT', qty: 10, cost: 2000 },
      { branch: 0, product: 1, at: vn('2026-08-01', '00:00'), type: 'SALE', qty: -4, cost: 2000 },
      { branch: 0, product: 0, at: vn('2026-08-15'), type: 'ADJUST', qty: -2, cost: null },
      { branch: 1, product: 2, at: vn('2026-09-10'), type: 'IMPORT', qty: 7, cost: 300 },
      { branch: 0, product: 0, at: vn('2026-09-30', '23:59'), type: 'SALE', qty: -5, cost: 510 },
      { branch: 0, product: 0, at: vn('2026-10-01', '00:00'), type: 'IMPORT', qty: 50, cost: 530 },
      { branch: 1, product: 0, at: vn('2026-10-12'), type: 'SALE', qty: -8, cost: 520 },
    ]);
  }

  const cases: [string, string, number | null][] = [
    ['2026-10-01', '2026-10-31', null],
    ['2026-10-01', '2026-10-31', 0],
    ['2026-08-01', '2026-08-31', null],
    ['2026-07-15', '2026-09-30', 1],
    ['2026-09-30', '2026-10-01', 0],
    ['2026-05-01', '2026-05-31', null],
  ];

  it.each(cases)('kỳ %s → %s, chi nhánh %s: khớp cách cộng toàn bộ sổ', async (fromDate, toDate, branch) => {
    await seedHistory();
    const p = period(fromDate, toDate);
    const filter = { ...p, branchId: branch === null ? undefined : base.branches[branch].id };
    // Lần 1 dựng bảng tháng, lần 2 đọc từ bảng tháng — cả hai phải khớp.
    expectMatches(await repo.findMovementSummary(filter), await oracle(branch, p.from, p.toExclusive));
    expectMatches(await repo.findMovementSummary(filter), await oracle(branch, p.from, p.toExclusive));
  });

  it('dựng các tháng đã đóng một lần, liền mạch; bút toán mới (tháng hiện tại) vẫn được tính', async () => {
    await seedHistory();
    const p = period('2026-10-01', '2026-10-31');
    await repo.findMovementSummary(p);

    const built = await prisma.stockMovementMonthlyBuilt.findMany({ orderBy: { month: 'asc' } });
    expect(built.map((b) => b.month.toISOString().slice(0, 10))).toEqual([
      '2026-06-01',
      '2026-07-01',
      '2026-08-01',
      '2026-09-01',
    ]);
    // Bút toán 31/07 23:59 VN thuộc tháng 7, 01/08 00:00 VN thuộc tháng 8.
    const p1 = await prisma.stockMovementMonthly.findMany({
      where: { productId: base.products[1].id },
      orderBy: { month: 'asc' },
    });
    expect(p1.map((r) => [r.month.toISOString().slice(0, 10), Number(r.quantity)])).toEqual([
      ['2026-07-01', 10],
      ['2026-08-01', -4],
    ]);

    // Bút toán mới ghi "bây giờ" → luôn sau mốc bảng tháng, phải hiện ở kỳ chứa hôm nay.
    await insert([{ branch: 0, product: 2, at: new Date(), type: 'IMPORT', qty: 3, cost: 100 }]);
    const today = new Date().toISOString().slice(0, 10);
    const q = period('2026-06-01', addDaysToDateOnly(today, 1));
    expectMatches(await repo.findMovementSummary(q), await oracle(null, q.from, q.toExclusive));
  });

  it('tổng vượt int4 không lỗi', async () => {
    await insert([
      { branch: 0, product: 0, at: vn('2026-06-01'), type: 'IMPORT', qty: 2_000_000_000, cost: 1 },
      { branch: 1, product: 0, at: vn('2026-06-02'), type: 'IMPORT', qty: 2_000_000_000, cost: 1 },
    ]);
    const [row] = await repo.findMovementSummary(period('2026-07-01', '2026-07-31'));
    expect(row.opening).toBe(4_000_000_000);
    expect(row.closingValue).toBe(4_000_000_000);
  });

  it('mốc tháng không vượt tháng chưa đóng (10 phút đầu tháng vẫn coi tháng trước là chưa đóng)', () => {
    const b = monthlyBoundary(vn('2026-12-15'), vn('2026-11-18'));
    expect(b.month).toBe('2026-11-01');
    expect(b.previousMonth).toBe('2026-10-01');
    expect(monthlyBoundary(vn('2026-11-20'), vn('2026-11-01', '00:05')).month).toBe('2026-10-01');
    expect(monthlyBoundary(vn('2026-08-20'), vn('2026-11-18')).month).toBe('2026-08-01');
  });
});
