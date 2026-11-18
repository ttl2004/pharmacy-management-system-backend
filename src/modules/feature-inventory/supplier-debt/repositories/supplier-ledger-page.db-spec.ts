import { AdjustmentType, PaymentMethod, PrismaClient, ReceiptStatus } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';
import { createTestPrisma, resetSchema } from 'src/test-support/db-test';
import { LEDGER_KINDS } from '../dtos/supplier-debt.query';
import { buildLedger } from '../supplier-debt-ledger.builder';
import { SupplierDebtRepository } from './supplier-debt.repository';

/**
 * L7: sổ nợ NCC tính trong SQL phải ra ĐÚNG như bản dựng ở Node (`buildLedger`, chuẩn cũ) — cùng thứ tự, cùng số dư
 * từng dòng — với dữ liệu ngẫu nhiên nhiều chi nhánh, chứng từ huỷ, phiếu chi trả nhiều phiếu nhập, mốc trùng nhau.
 */
describe('sổ nợ NCC một trang trong SQL = buildLedger (db)', () => {
  let prisma: PrismaClient;
  let repo: SupplierDebtRepository;

  beforeAll(async () => {
    prisma = await createTestPrisma();
    repo = new SupplierDebtRepository(prisma as unknown as PrismaService);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetSchema(prisma);
  });

  /** Sinh số giả ngẫu nhiên có hạt giống — lỗi tái hiện được. */
  function rng(seed: number) {
    return () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
  }

  async function seed(random: () => number) {
    const supplier = await prisma.supplier.create({ data: { code: 'NCC01', name: 'Dược A', phone: '0900000000' } });
    const other = await prisma.supplier.create({ data: { code: 'NCC02', name: 'Dược B', phone: '0900000009' } });
    const branches = await Promise.all(
      ['CN01', 'CN02'].map((code, i) =>
        prisma.branch.create({ data: { code, name: code, phone: `090000000${i + 1}`, address: 'HN' } }),
      ),
    );
    const base = new Date('2026-01-01T00:00:00Z').getTime();
    // Mốc chỉ tới phút và hay trùng nhau, để thử thứ tự phụ (lúc lập, mã).
    const at = () => new Date(base + Math.floor(random() * 300) * 60_000);
    const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)];

    const receipts: { id: string; branchId: string }[] = [];
    for (let i = 0; i < 40; i++) {
      const confirmedAt = at();
      const status =
        random() < 0.15 ? ReceiptStatus.CANCELLED : random() < 0.1 ? ReceiptStatus.DRAFT : ReceiptStatus.CONFIRMED;
      const r = await prisma.goodsReceipt.create({
        data: {
          code: `PN${String(i).padStart(6, '0')}`,
          branchId: pick(branches).id,
          supplierId: random() < 0.9 ? supplier.id : other.id,
          status,
          confirmedAt: status === ReceiptStatus.DRAFT ? null : confirmedAt,
          ...(() => {
            const total = BigInt(Math.floor(random() * 100) * 10_000);
            return { totalAmount: total, subtotalAmount: total };
          })(),
          cancelReason: status === ReceiptStatus.CANCELLED ? 'Huỷ' : null,
          isDeleted: random() < 0.05,
        },
      });
      receipts.push({ id: r.id, branchId: r.branchId });
    }
    for (let i = 0; i < 30; i++) {
      const createdAt = at();
      const payment = await prisma.supplierPayment.create({
        data: {
          code: `TTPN${String(i).padStart(6, '0')}`,
          supplierId: supplier.id,
          branchId: pick(branches).id,
          paidAt: random() < 0.5 ? createdAt : at(),
          createdAt,
          method: PaymentMethod.CASH,
          amount: 1n,
          cancelledAt: random() < 0.15 ? at() : null,
        },
      });
      const targets = new Set<string>();
      for (let k = 0; k < 1 + Math.floor(random() * 3); k++) targets.add(pick(receipts).id);
      await prisma.supplierPaymentAllocation.createMany({
        data: [...targets].map((receiptId) => ({
          paymentId: payment.id,
          receiptId,
          amount: BigInt((1 + Math.floor(random() * 20)) * 5_000),
        })),
      });
    }
    for (let i = 0; i < 15; i++) {
      const status = random() < 0.2 ? ReceiptStatus.CANCELLED : ReceiptStatus.CONFIRMED;
      const total = BigInt(Math.floor(random() * 30) * 10_000);
      await prisma.stockAdjustment.create({
        data: {
          code: `TH${String(i).padStart(4, '0')}`,
          branchId: pick(branches).id,
          supplierId: supplier.id,
          type: AdjustmentType.RETURN_TO_SUPPLIER,
          reason: 'Trả hàng',
          status,
          cancelReason: status === ReceiptStatus.CANCELLED ? 'Huỷ' : null,
          confirmedAt: at(),
          goodsAmount: total,
          totalAmount: total,
          supplierPaid: total / 3n,
        },
      });
    }
    for (let i = 0; i < 15; i++) {
      const createdAt = at();
      const delta = BigInt((Math.floor(random() * 40) - 20 || 1) * 1_000);
      await prisma.supplierDebtAdjustment.create({
        data: {
          code: `DCN${String(i).padStart(6, '0')}`,
          supplierId: supplier.id,
          branchId: pick(branches).id,
          adjustedAt: at(),
          createdAt,
          debtBefore: 50_000n,
          debtAfter: 50_000n + delta,
          delta,
          note: 'Đối chiếu',
          cancelledAt: random() < 0.15 ? at() : null,
        },
      });
    }
    return { supplier, branches };
  }

  /** Chuẩn cũ: tải hết rồi dựng ở Node. */
  async function oracle(supplierId: string, branchId: string | undefined) {
    const [receipts, payments, adjustments, returns] = await Promise.all([
      repo.findLedgerReceipts(supplierId, branchId),
      repo.findLedgerPayments(supplierId),
      repo.findLedgerAdjustments(supplierId),
      repo.findLedgerReturns(supplierId, branchId),
    ]);
    // `-0` (phiếu trả 0đ) ra JSON vẫn là 0 — chuẩn hoá để so.
    return buildLedger({
      receipts,
      payments,
      adjustments,
      returns,
      inScope: (id) => !branchId || id === branchId,
    }).map((row) => ({ ...row, amount: row.amount + 0 }));
  }

  it.each([11, 2024, 777])('hạt giống %i: mọi phạm vi, mọi loại, phân trang đều khớp', async (seedValue) => {
    const { supplier, branches } = await seed(rng(seedValue));
    for (const branchId of [undefined, branches[0].id, branches[1].id]) {
      const expected = await oracle(supplier.id, branchId);
      for (const kind of [undefined, ...LEDGER_KINDS]) {
        const rows = expected.filter((row) => !kind || row.kind === kind);
        const all = await repo.findLedgerPage({ supplierId: supplier.id, branchId, kind, limit: 1000, offset: 0 });
        expect(all.total).toBe(rows.length);
        expect(all.rows).toEqual(rows);
        // Trang giữa: đúng lát cắt của sổ đầy đủ.
        const page = await repo.findLedgerPage({ supplierId: supplier.id, branchId, kind, limit: 7, offset: 7 });
        expect(page.rows).toEqual(rows.slice(7, 14));
      }
    }
  });
});
