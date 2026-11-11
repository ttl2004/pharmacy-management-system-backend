import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthRole } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';
import { addDaysToDateOnly, todayInVietnam } from 'src/common/utils/date-only.util';
import { InMemoryReportCache } from '../report-cache';
import { EndOfDayReportRepository } from './end-of-day-report.repository';
import { EndOfDayReportService } from './end-of-day-report.service';

const actorOf = (role: AuthRole, branchId: string | null) =>
  ({ user: { userId: 'u1', role, branchId, roleLevel: 40 } }) as unknown as RequestActor;
const BRANCH_1 = '11111111-1111-4111-8111-111111111111';
const BRANCH_2 = '22222222-2222-4222-8222-222222222222';
const pm = actorOf(AuthRole.PHARMACY_MANAGER, BRANCH_1);
const admin = actorOf(AuthRole.ADMIN, null);
const DATE = '2026-11-10';

describe('EndOfDayReportService', () => {
  let now = 5_000_000;
  const repo = {
    paymentsByMethod: jest.fn(),
    orderCounts: jest.fn(),
    supplierReceipts: jest.fn(),
    supplierPayments: jest.fn(),
    topProducts: jest.fn(),
    byStaff: jest.fn(),
  };
  let service: EndOfDayReportService;

  beforeEach(() => {
    jest.clearAllMocks();
    now = 5_000_000;
    repo.paymentsByMethod.mockResolvedValue([]);
    repo.orderCounts.mockResolvedValue({ orderCount: 0, cancelledCount: 0 });
    repo.supplierReceipts.mockResolvedValue({ count: 0, amount: 0n });
    repo.supplierPayments.mockResolvedValue([]);
    repo.topProducts.mockResolvedValue([]);
    repo.byStaff.mockResolvedValue([]);
    service = new EndOfDayReportService(
      repo as unknown as EndOfDayReportRepository,
      new InMemoryReportCache(() => now),
    );
  });

  it('ví dụ contract: thu 3.000.000 (mặt 2tr, CK 1tr), hoàn mặt 200k → net 2.800.000; CASH net 1.800.000; đủ 3 dòng method', async () => {
    repo.paymentsByMethod.mockResolvedValue([
      { method: 'CASH', kind: 'PAYMENT', total: 2_000_000n },
      { method: 'BANK_TRANSFER', kind: 'PAYMENT', total: 1_000_000n },
      { method: 'CASH', kind: 'REFUND', total: 200_000n },
    ]);
    repo.orderCounts.mockResolvedValue({ orderCount: 5, cancelledCount: 1 });
    repo.supplierReceipts.mockResolvedValue({ count: 2, amount: 7_000_000n });
    repo.supplierPayments.mockResolvedValue([
      { method: 'BANK_TRANSFER', count: 1, amount: 500_000n },
      { method: 'CASH', count: 2, amount: 300_000n },
    ]);
    repo.topProducts.mockResolvedValue([{ productId: 'p1', productName: 'A', qtyBase: 3n, amount: 90_000n }]);
    repo.byStaff.mockResolvedValue([{ staffId: 's1', staffName: 'Lan', orderCount: 5, netAmount: 2_800_000n }]);

    const report = await service.endOfDay({ date: DATE }, admin);

    expect(report).toEqual({
      date: DATE,
      sales: { orderCount: 5, grossAmount: 3_000_000, refundAmount: 200_000, netAmount: 2_800_000, cancelledCount: 1 },
      byMethod: [
        { method: 'CASH', received: 2_000_000, refunded: 200_000, net: 1_800_000 },
        { method: 'BANK_TRANSFER', received: 1_000_000, refunded: 0, net: 1_000_000 },
        { method: 'CARD', received: 0, refunded: 0, net: 0 },
      ],
      supplier: {
        receiptCount: 2,
        receiptAmount: 7_000_000,
        paymentCount: 3,
        paymentAmount: 800_000,
        paymentByMethod: [
          { method: 'CASH', amount: 300_000 },
          { method: 'BANK_TRANSFER', amount: 500_000 },
        ],
      },
      topProducts: [{ productId: 'p1', productName: 'A', qtyBase: 3, amount: 90_000 }],
      byStaff: [{ staffId: 's1', staffName: 'Lan', orderCount: 5, netAmount: 2_800_000 }],
    });
  });

  it('không có dữ liệu → toàn 0, đủ 3 method', async () => {
    const report = await service.endOfDay({ date: DATE }, admin);
    expect(report.sales.netAmount).toBe(0);
    expect(report.byMethod.map((m) => m.method)).toEqual(['CASH', 'BANK_TRANSFER', 'CARD']);
    expect(report.supplier.paymentByMethod).toEqual([]);
  });

  it('mặc định hôm nay giờ VN; ngày tương lai → 1002, không đọc DB', async () => {
    await service.endOfDay({}, admin);
    expect(repo.orderCounts).toHaveBeenCalledTimes(1);
    const range = (repo.orderCounts.mock.calls as [{ start: Date; end: Date }][])[0][0];
    expect(range.end.getTime() - range.start.getTime()).toBe(86_400_000);
    repo.orderCounts.mockClear();
    await expect(service.endOfDay({ date: addDaysToDateOnly(todayInVietnam(), 1) }, admin)).rejects.toMatchObject({
      errorCode: ErrorCode.HTTP_BAD_REQUEST,
    });
    expect(repo.orderCounts).not.toHaveBeenCalled();
  });

  it('mốc ngày = [00:00 VN, 00:00 VN hôm sau) quy ra UTC', async () => {
    await service.endOfDay({ date: DATE }, admin);
    const range = (repo.paymentsByMethod.mock.calls as [{ start: Date; end: Date }][])[0][0];
    expect(range.start.toISOString()).toBe('2026-11-09T17:00:00.000Z');
    expect(range.end.toISOString()).toBe('2026-11-10T17:00:00.000Z');
  });

  it('PM không gửi branchIds → chi nhánh mình; gửi CN khác → 1506, không đọc DB', async () => {
    await service.endOfDay({ date: DATE }, pm);
    expect(repo.paymentsByMethod).toHaveBeenCalledWith(expect.anything(), [BRANCH_1]);
    repo.paymentsByMethod.mockClear();
    await expect(service.endOfDay({ date: DATE, branchIds: [BRANCH_1, BRANCH_2] }, pm)).rejects.toMatchObject({
      response: { code: ErrorCode.BRANCH_ACCESS_DENIED },
    });
    expect(repo.paymentsByMethod).not.toHaveBeenCalled();
  });

  it('ADMIN rỗng → toàn chuỗi (undefined)', async () => {
    await service.endOfDay({ date: DATE }, admin);
    expect(repo.paymentsByMethod).toHaveBeenCalledWith(expect.anything(), undefined);
  });

  it('cache theo ngày + phạm vi: dùng lại trong 60s, hết hạn đọc lại; khác ngày / ADMIN-PM không dùng chung', async () => {
    await service.endOfDay({ date: DATE, branchIds: [BRANCH_1] }, admin);
    await service.endOfDay({ date: DATE, branchIds: [BRANCH_1] }, admin);
    expect(repo.paymentsByMethod).toHaveBeenCalledTimes(1);
    await service.endOfDay({ date: DATE, branchIds: [BRANCH_1] }, pm);
    expect(repo.paymentsByMethod).toHaveBeenCalledTimes(2);
    await service.endOfDay({ date: '2026-11-09', branchIds: [BRANCH_1] }, admin);
    expect(repo.paymentsByMethod).toHaveBeenCalledTimes(3);
    now += 60_001;
    await service.endOfDay({ date: DATE, branchIds: [BRANCH_1] }, admin);
    expect(repo.paymentsByMethod).toHaveBeenCalledTimes(4);
  });

  it('PM xin chi nhánh khác vẫn bị 1506 dù ADMIN đã làm nóng cache cùng khoá', async () => {
    await service.endOfDay({ date: DATE, branchIds: [BRANCH_2] }, admin);
    await expect(service.endOfDay({ date: DATE, branchIds: [BRANCH_2] }, pm)).rejects.toMatchObject({
      response: { code: ErrorCode.BRANCH_ACCESS_DENIED },
    });
  });
});
