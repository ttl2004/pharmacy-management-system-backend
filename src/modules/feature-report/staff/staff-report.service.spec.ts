import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthRole } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';
import { InMemoryReportCache } from '../report-cache';
import { StaffReportRepository } from './staff-report.repository';
import { StaffReportService } from './staff-report.service';

const actorOf = (role: AuthRole, branchId: string | null) =>
  ({ user: { userId: 'u1', role, branchId, roleLevel: 40 } }) as unknown as RequestActor;
const BRANCH_1 = '11111111-1111-4111-8111-111111111111';
const BRANCH_2 = '22222222-2222-4222-8222-222222222222';
const pm = actorOf(AuthRole.PHARMACY_MANAGER, BRANCH_1);
const admin = actorOf(AuthRole.ADMIN, null);

const row = (staffId: string, over: Record<string, unknown> = {}) => ({
  staffId,
  staffName: `NV ${staffId}`,
  branchName: 'CN1',
  orderCount: 120,
  cancelledCount: 2,
  refundAmount: 300000n,
  revenue: 17700000n,
  cogs: 13500000n,
  ...over,
});

describe('StaffReportService', () => {
  let now = 5_000_000;
  const repo = { byStaff: jest.fn() };
  let service: StaffReportService;

  beforeEach(() => {
    jest.clearAllMocks();
    now = 5_000_000;
    repo.byStaff.mockResolvedValue([]);
    service = new StaffReportService(repo as unknown as StaffReportRepository, new InMemoryReportCache(() => now));
  });

  const range = { from: '2026-11-01', to: '2026-11-30' };

  it('PM bỏ trống → chi nhánh mình; CN khác → 1506, không đọc DB', async () => {
    await service.staffReport(range, pm);
    expect(repo.byStaff).toHaveBeenCalledWith({ ...range, branchIds: [BRANCH_1] });
    repo.byStaff.mockClear();
    await expect(service.staffReport({ ...range, branchIds: [BRANCH_2] }, pm)).rejects.toMatchObject({
      response: { code: ErrorCode.BRANCH_ACCESS_DENIED },
    });
    expect(repo.byStaff).not.toHaveBeenCalled();
  });

  it('ADMIN bỏ trống → toàn chuỗi (branchIds undefined)', async () => {
    await service.staffReport(range, admin);
    expect(repo.byStaff).toHaveBeenCalledWith({ ...range, branchIds: undefined });
  });

  it('from > to hoặc quá 92 ngày → 1002, không đọc DB; đúng 92 ngày thì được', async () => {
    for (const q of [
      { from: '2026-11-10', to: '2026-11-09' },
      { from: '2026-01-01', to: '2026-04-03' }, // 93 ngày
    ]) {
      await expect(service.staffReport(q, admin)).rejects.toMatchObject({
        errorCode: ErrorCode.HTTP_BAD_REQUEST,
      });
    }
    expect(repo.byStaff).not.toHaveBeenCalled();
    await service.staffReport({ from: '2026-01-01', to: '2026-04-02' }, admin); // 92 ngày
    expect(repo.byStaff).toHaveBeenCalledTimes(1);
  });

  it('ví dụ contract: Lan 120 đơn, huỷ 2 hoàn 300.000, giá vốn 13.500.000 → lãi gộp 4.200.000; avg làm tròn; totals cộng dồn', async () => {
    repo.byStaff.mockResolvedValue([
      row('a'),
      row('b', { orderCount: 3, revenue: 1000n, cogs: 400n, cancelledCount: 0, refundAmount: 0n, branchName: null }),
      row('c', { orderCount: 0, revenue: 0n, cogs: 0n, cancelledCount: 1, refundAmount: 0n }),
    ]);
    const report = await service.staffReport(range, admin);
    expect(report.byStaff[0]).toEqual({
      staffId: 'a',
      staffName: 'NV a',
      branchName: 'CN1',
      orderCount: 120,
      revenue: 17700000,
      avgOrderValue: 147500,
      cancelledCount: 2,
      refundAmount: 300000,
      cogs: 13500000,
      grossProfit: 4200000,
    });
    expect(report.byStaff[1]).toMatchObject({ avgOrderValue: 333, grossProfit: 600, branchName: null });
    expect(report.byStaff[2]).toMatchObject({ avgOrderValue: 0 });
    expect(report.totals).toEqual({ orderCount: 123, revenue: 17701000, cancelledCount: 3, refundAmount: 300000 });
  });

  it('cache 60 giây theo khoá có phạm vi; PM không đọc cache của ADMIN', async () => {
    await service.staffReport(range, admin);
    await service.staffReport(range, admin);
    expect(repo.byStaff).toHaveBeenCalledTimes(1);
    await service.staffReport({ ...range, branchIds: [BRANCH_1] }, admin); // khoá khác
    expect(repo.byStaff).toHaveBeenCalledTimes(2);
    await service.staffReport({ ...range, branchIds: [BRANCH_1] }, pm); // cùng CN nhưng scopeKey khác
    expect(repo.byStaff).toHaveBeenCalledTimes(3);
    now += 60_001;
    await service.staffReport(range, admin);
    expect(repo.byStaff).toHaveBeenCalledTimes(4);
  });
});
