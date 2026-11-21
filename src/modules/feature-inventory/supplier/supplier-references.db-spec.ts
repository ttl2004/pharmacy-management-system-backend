import { PrismaClient } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';
import { createTestPrisma, resetSchema } from 'src/test-support/db-test';
import { SupplierRepository } from './repositories/supplier.repository';

/** N3: NCC mới chỉ có điều chỉnh nợ (nợ đầu kỳ) hoặc phiếu chi vẫn phải bị chặn xoá. */
describe('SupplierRepository.countReferences (db)', () => {
  let prisma: PrismaClient;
  let repo: SupplierRepository;

  beforeAll(async () => {
    prisma = await createTestPrisma();
    repo = new SupplierRepository(prisma as unknown as PrismaService);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetSchema(prisma);
  });

  const seedBase = async () => {
    const branch = await prisma.branch.create({
      data: { code: 'CN01', name: 'CN01', phone: '0900000001', address: 'HN' },
    });
    const supplier = await prisma.supplier.create({ data: { code: 'NCC01', name: 'NCC01', phone: '0910000001' } });
    return { branch, supplier };
  };

  it('NCC không có gì → 0 (xoá được)', async () => {
    const { supplier } = await seedBase();
    expect(await repo.countReferences(prisma, supplier.id)).toBe(0);
  });

  it('chỉ có điều chỉnh nợ đầu kỳ → tính là có tham chiếu', async () => {
    const { branch, supplier } = await seedBase();
    await prisma.supplierDebtAdjustment.create({
      data: {
        code: 'DCN01',
        supplierId: supplier.id,
        branchId: branch.id,
        adjustedAt: new Date(),
        debtBefore: 0n,
        debtAfter: 8_000_000n,
        delta: 8_000_000n,
        note: 'Nợ đầu kỳ',
      },
    });
    expect(await repo.countReferences(prisma, supplier.id)).toBe(1);
  });

  it('chỉ có phiếu chi → tính là có tham chiếu', async () => {
    const { branch, supplier } = await seedBase();
    await prisma.supplierPayment.create({
      data: {
        code: 'TTPN01',
        supplierId: supplier.id,
        branchId: branch.id,
        paidAt: new Date(),
        method: 'CASH',
        amount: 1n,
      },
    });
    expect(await repo.countReferences(prisma, supplier.id)).toBe(1);
  });
});
