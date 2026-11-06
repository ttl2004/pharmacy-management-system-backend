import { BatchStatus, PrismaClient, TransferStatus } from '@prisma/client';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { PrismaService } from 'src/common/databases/prisma.service';
import { AuthRole } from 'src/common/types/common.enum';
import { addDaysToDateOnly, parseDateOnly, todayInVietnam } from 'src/common/utils/date-only.util';
import { createTestPrisma, resetSchema } from 'src/test-support/db-test';
import { ReportBase, seedReportBase } from 'src/test-support/report-db-seed';
import { InventoryReportRepository } from './inventory-report.repository';
import { InventoryReportService } from './inventory-report.service';
import { InMemoryReportCache } from './report-cache';

const adminActor = { user: { userId: 'u', role: AuthRole.ADMIN, branchId: null } } as unknown as RequestActor;

describe('GET /reports/inventory — truy vấn thật (db)', () => {
  let prisma: PrismaClient;
  let base: ReportBase;
  let service: InventoryReportService;

  beforeAll(async () => {
    prisma = await createTestPrisma();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetSchema(prisma);
    base = await seedReportBase(prisma);
    // Cache mới mỗi test: không để kết quả test trước rò sang test sau.
    service = new InventoryReportService(
      new InventoryReportRepository(prisma as unknown as PrismaService),
      new InMemoryReportCache(),
    );
  });

  let seq = 0;
  const lot = (
    branch: number,
    product: number,
    over: { qty?: number; price?: number; days?: number; deleted?: boolean; status?: BatchStatus } = {},
  ) =>
    prisma.stockBatch.create({
      data: {
        branchId: base.branches[branch].id,
        productId: base.products[product].id,
        batchNumber: `X-${(seq += 1)}`,
        expiryDate: parseDateOnly(addDaysToDateOnly(todayInVietnam(), over.days ?? 365)),
        quantityOnHand: over.qty ?? 10,
        importPrice: over.price ?? 100,
        isDeleted: over.deleted ?? false,
        status: over.status ?? BatchStatus.AVAILABLE,
        blockedReason: over.status && over.status !== BatchStatus.AVAILABLE ? 'Kiểm nghiệm' : null,
      },
    });

  it('dữ liệu 2 CN: lô còn tồn, lô hết hàng, lô xoá mềm, lô cách ly → lotCount/drugCount/estimatedValue/byBranch đúng (lô hết hàng & xoá mềm không tính, lô cách ly có tính)', async () => {
    const [cn1, cn2] = base.branches;
    await lot(0, 0, { qty: 100, price: 500 }); // 50.000
    await lot(0, 1, { qty: 10, price: 1000, status: BatchStatus.QUARANTINE }); // 10.000, cách ly vẫn tính
    await lot(0, 0, { qty: 0, price: 9999 }); // hết hàng: bỏ
    await lot(0, 2, { qty: 50, price: 100, deleted: true }); // xoá mềm: bỏ
    await lot(1, 0, { qty: 3, price: 200 }); // 600, cùng sản phẩm 0 với CN1

    const report = await service.inventoryReport({}, adminActor);

    expect(report.lotCount).toBe(3);
    expect(report.drugCount).toBe(2); // sản phẩm 0 và 1; sản phẩm 0 ở 2 chi nhánh chỉ đếm một lần
    expect(report.estimatedValue).toBe(60600);
    expect(report.inTransitQty).toBe(0);
    expect(report.byBranch).toEqual([
      { branchId: cn1.id, branchName: 'Chi nhánh 1', lotCount: 2, estimatedValue: 60000 },
      { branchId: cn2.id, branchName: 'Chi nhánh 2', lotCount: 1, estimatedValue: 600 },
    ]);

    const only2 = await service.inventoryReport({ branchIds: [cn2.id] }, adminActor);
    expect(only2).toMatchObject({ lotCount: 1, drugCount: 1, estimatedValue: 600 });
    expect(only2.byBranch).toHaveLength(1);
  });

  it('chi nhánh 0 tồn vẫn có trong byBranch; chi nhánh đã xoá thì không', async () => {
    await lot(0, 0);
    await prisma.branch.update({ where: { id: base.branches[1].id }, data: { isDeleted: true } });
    await lot(1, 0); // lô của chi nhánh đã xoá không tính
    const report = await service.inventoryReport({}, adminActor);
    expect(report.byBranch.map((b) => b.branchId)).toEqual([base.branches[0].id]);
    expect(report.lotCount).toBe(1);
    await prisma.branch.update({ where: { id: base.branches[1].id }, data: { isDeleted: false } });
    const again = await new InventoryReportService(
      new InventoryReportRepository(prisma as unknown as PrismaService),
      new InMemoryReportCache(),
    ).inventoryReport({}, adminActor);
    expect(again.byBranch.find((b) => b.branchId === base.branches[1].id)).toMatchObject({ lotCount: 1 });
  });

  it('expirySummary đúng ranh giới 0/30/31/60/61/90/91 ngày theo giờ VN', async () => {
    for (const days of [-5, 0, 1, 30, 31, 60, 61, 90, 91]) await lot(0, 0, { days });
    const report = await service.inventoryReport({}, adminActor);
    // -5,0 → expired · 1,30 → critical · 31,60 → warning · 61,90 → info · 91 → ok
    expect(report.expirySummary).toEqual({ expired: 2, critical: 2, warning: 2, info: 2, ok: 1 });
  });

  const transfer = async (
    from: number,
    to: number,
    status: TransferStatus,
    quantities: number[],
    isDeleted = false,
  ) => {
    seq += 1;
    const t = await prisma.stockTransfer.create({
      data: {
        code: `PC${seq}`,
        fromBranchId: base.branches[from].id,
        toBranchId: base.branches[to].id,
        status,
        isDeleted,
        cancelReason: status === TransferStatus.CANCELLED ? 'Huỷ' : null,
      },
    });
    for (const quantity of quantities) {
      const batch = await lot(from, 0, { qty: 1 });
      await prisma.stockTransferItem.create({
        data: { transferId: t.id, productId: base.products[0].id, batchId: batch.id, quantity },
      });
    }
  };

  it('inTransitQty: phiếu IN_TRANSIT A→B, phạm vi {A,B} → đếm một lần; phạm vi {B} → vẫn đếm; phiếu DRAFT/RECEIVED không tính', async () => {
    const [a, b] = base.branches;
    await transfer(0, 1, TransferStatus.IN_TRANSIT, [7, 5]);
    await transfer(0, 1, TransferStatus.PENDING, [100]);
    await transfer(0, 1, TransferStatus.RECEIVED, [200]);
    await transfer(0, 1, TransferStatus.CANCELLED, [300]);
    await transfer(0, 1, TransferStatus.IN_TRANSIT, [400], true); // phiếu xoá mềm

    expect((await service.inventoryReport({ branchIds: [a.id, b.id] }, adminActor)).inTransitQty).toBe(12);
    expect((await service.inventoryReport({ branchIds: [b.id] }, adminActor)).inTransitQty).toBe(12);
    expect((await service.inventoryReport({ branchIds: [a.id] }, adminActor)).inTransitQty).toBe(12);
    expect((await service.inventoryReport({}, adminActor)).inTransitQty).toBe(12);
  });
});
