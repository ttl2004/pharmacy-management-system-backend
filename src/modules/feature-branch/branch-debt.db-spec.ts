import { AdjustmentType, PrismaClient, ReceiptStatus } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';
import { SupplierDebtRepository } from 'src/modules/feature-inventory/supplier-debt/repositories/supplier-debt.repository';
import { createTestPrisma, resetSchema } from 'src/test-support/db-test';
import { BranchRepository } from './repositories/branch.repository';

/** M2: nợ NCC còn lại của chi nhánh (chặn xoá) phải khớp `debtOf` phạm vi chi nhánh — cùng công thức sổ nợ. */
describe('BranchRepository.findOutstandingSupplierDebts (db)', () => {
  let prisma: PrismaClient;
  let branches: BranchRepository;
  let debts: SupplierDebtRepository;

  beforeAll(async () => {
    prisma = await createTestPrisma();
    branches = new BranchRepository(prisma as unknown as PrismaService);
    debts = new SupplierDebtRepository(prisma as unknown as PrismaService);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetSchema(prisma);
  });

  async function seed() {
    const [a, b] = await Promise.all(
      ['CN01', 'CN02'].map((code, i) =>
        prisma.branch.create({ data: { code, name: code, phone: `090000000${i}`, address: 'HN' } }),
      ),
    );
    const [s1, s2] = await Promise.all(
      ['NCC01', 'NCC02'].map((code, i) =>
        prisma.supplier.create({ data: { code, name: code, phone: `091000000${i}` } }),
      ),
    );
    const receipt = (
      code: string,
      branchId: string,
      supplierId: string,
      total: bigint,
      paid: bigint,
      status: ReceiptStatus = ReceiptStatus.CONFIRMED,
    ) =>
      prisma.goodsReceipt.create({
        data: {
          code,
          branchId,
          supplierId,
          status,
          confirmedAt: status === ReceiptStatus.DRAFT ? null : new Date(),
          subtotalAmount: total,
          totalAmount: total,
          paidAmount: paid,
          cancelReason: status === ReceiptStatus.CANCELLED ? 'Huỷ' : null,
        },
      });
    // CN01 / NCC01: nhập 1.000.000 trả 200.000, trả hàng 300.000 (NCC hoàn 100.000) → nợ 600.000.
    await receipt('PN01', a.id, s1.id, 1_000_000n, 200_000n);
    await prisma.stockAdjustment.create({
      data: {
        code: 'TH01',
        branchId: a.id,
        supplierId: s1.id,
        type: AdjustmentType.RETURN_TO_SUPPLIER,
        reason: 'Trả hàng',
        status: ReceiptStatus.CONFIRMED,
        confirmedAt: new Date(),
        goodsAmount: 300_000n,
        totalAmount: 300_000n,
        supplierPaid: 100_000n,
      },
    });
    // CN01 / NCC02: nhập 500.000, điều chỉnh −500.000 → nợ 0 (không được tính).
    await receipt('PN02', a.id, s2.id, 500_000n, 0n);
    await prisma.supplierDebtAdjustment.create({
      data: {
        code: 'DCN01',
        supplierId: s2.id,
        branchId: a.id,
        adjustedAt: new Date(),
        debtBefore: 500_000n,
        debtAfter: 0n,
        delta: -500_000n,
        note: 'Đối chiếu',
      },
    });
    // Phiếu huỷ / nháp, và nợ của chi nhánh khác — không tính vào CN01.
    await receipt('PN03', a.id, s1.id, 9_000_000n, 0n, ReceiptStatus.CANCELLED);
    await receipt('PN04', a.id, s1.id, 9_000_000n, 0n, ReceiptStatus.DRAFT);
    await receipt('PN05', b.id, s1.id, 7_000_000n, 0n);
    return { a, b, s1, s2 };
  }

  it('chỉ trả NCC còn nợ ≠ 0, số nợ khớp debtOf phạm vi chi nhánh', async () => {
    const { a, b, s1, s2 } = await seed();
    const rows = await branches.findOutstandingSupplierDebts(a.id);
    expect(rows).toEqual([{ supplierId: s1.id, debt: 600_000n }]);
    expect((await debts.debtOf(s1.id, a.id)).scoped).toBe(600_000n);
    expect((await debts.debtOf(s2.id, a.id)).scoped).toBe(0n);
    expect(await branches.findOutstandingSupplierDebts(b.id)).toEqual([{ supplierId: s1.id, debt: 7_000_000n }]);
  });

  it('chi nhánh không có chứng từ nợ → rỗng (xoá được)', async () => {
    const branch = await prisma.branch.create({
      data: { code: 'CN09', name: 'CN09', phone: '0900000099', address: 'HN' },
    });
    expect(await branches.findOutstandingSupplierDebts(branch.id)).toEqual([]);
  });
});
