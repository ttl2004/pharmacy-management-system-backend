import { PrismaClient } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';
import { addDaysToDateOnly, parseDateOnly, todayInVietnam } from 'src/common/utils/date-only.util';
import { createTestPrisma, resetSchema } from 'src/test-support/db-test';
import { ReportBase, seedReportBase } from 'src/test-support/report-db-seed';
import { StockQueryRepository } from './stock-query.repository';

/** Đếm lô hết hạn / cận hạn theo chi nhánh trên PostgreSQL thật (thẻ Tổng quan, cả chế độ Toàn chuỗi). */
describe('StockQueryRepository.findExpirySummary (db)', () => {
  let prisma: PrismaClient;
  let base: ReportBase;
  let repo: StockQueryRepository;
  const today = todayInVietnam();
  const filter = (branchId?: string) => ({
    branchId,
    today: parseDateOnly(today),
    until: parseDateOnly(addDaysToDateOnly(today, 30)),
  });

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

  /** Đặt HSD (lệch so với hôm nay) + tồn cho lô (chi nhánh, sản phẩm) của dữ liệu mẫu. */
  const setLot = (branch: number, product: number, daysFromToday: number, qty: number, isDeleted = false) =>
    prisma.stockBatch.update({
      where: { id: base.batches[`${base.branches[branch].id}:${base.products[product].id}`].id },
      data: { expiryDate: parseDateOnly(addDaysToDateOnly(today, daysFromToday)), quantityOnHand: qty, isDeleted },
    });

  it('gom theo chi nhánh: hết hạn hôm nay tính là hết hạn; bỏ lô tồn 0, lô đã xoá, lô ngoài khoảng', async () => {
    await setLot(0, 0, 0, 5); // hết hạn hôm nay
    await setLot(0, 1, 30, 5); // cận hạn đúng biên
    await setLot(0, 2, 31, 5); // ngoài khoảng
    await setLot(1, 0, -10, 5); // đã hết hạn
    await setLot(1, 1, 5, 0); // tồn 0 → bỏ
    await setLot(1, 2, 1, 5, true); // đã xoá → bỏ

    const all = await repo.findExpirySummary(filter());
    expect(all).toEqual([
      { branchId: base.branches[0].id, branchCode: 'CN01', branchName: 'Chi nhánh 1', expired: 1, expiring: 1 },
      { branchId: base.branches[1].id, branchCode: 'CN02', branchName: 'Chi nhánh 2', expired: 1, expiring: 0 },
    ]);

    const one = await repo.findExpirySummary(filter(base.branches[1].id));
    expect(one).toEqual([all[1]]);
  });

  it('không có lô nào trong khoảng → mảng rỗng', async () => {
    await expect(repo.findExpirySummary(filter())).resolves.toEqual([]);
  });
});
