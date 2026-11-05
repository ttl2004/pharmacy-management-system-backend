import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthRole } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';
import { InMemoryReportCache } from './report-cache';
import { SalesReportRepository } from './sales-report.repository';
import { SalesReportService } from './sales-report.service';

const actorOf = (role: AuthRole, branchId: string | null) =>
  ({ user: { userId: 'u1', role, branchId, roleLevel: 40 } }) as unknown as RequestActor;
const BRANCH_1 = '11111111-1111-4111-8111-111111111111';
const BRANCH_2 = '22222222-2222-4222-8222-222222222222';
const pm = actorOf(AuthRole.PHARMACY_MANAGER, BRANCH_1);
const admin = actorOf(AuthRole.ADMIN, null);

describe('SalesReportService', () => {
  let now = 5_000_000;
  const repo = { daily: jest.fn(), byBranch: jest.fn(), topProducts: jest.fn() };
  let service: SalesReportService;

  beforeEach(() => {
    jest.clearAllMocks();
    now = 5_000_000;
    repo.daily.mockResolvedValue([]);
    repo.byBranch.mockResolvedValue([]);
    repo.topProducts.mockResolvedValue([]);
    service = new SalesReportService(repo as unknown as SalesReportRepository, new InMemoryReportCache(() => now));
  });

  it('PM không gửi branchIds → chỉ chi nhánh mình', async () => {
    await service.salesReport({ from: '2026-11-01', to: '2026-11-02' }, pm);
    expect(repo.daily).toHaveBeenCalledWith({ from: '2026-11-01', to: '2026-11-02', branchIds: [BRANCH_1] });
  });

  it('PM gửi chi nhánh khác → 1506, không đọc DB', async () => {
    await expect(
      service.salesReport({ from: '2026-11-01', to: '2026-11-02', branchIds: [BRANCH_1, BRANCH_2] }, pm),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.BRANCH_ACCESS_DENIED },
    });
    expect(repo.daily).not.toHaveBeenCalled();
  });

  it('ADMIN không gửi branchIds → toàn chuỗi; có branchIds → đúng các chi nhánh đó', async () => {
    await service.salesReport({ from: '2026-11-01', to: '2026-11-01' }, admin);
    expect(repo.daily).toHaveBeenLastCalledWith({ from: '2026-11-01', to: '2026-11-01', branchIds: undefined });
    await service.salesReport({ from: '2026-11-01', to: '2026-11-01', branchIds: [BRANCH_2] }, admin);
    expect(repo.daily).toHaveBeenLastCalledWith({ from: '2026-11-01', to: '2026-11-01', branchIds: [BRANCH_2] });
  });

  it('from > to → 1002; khoảng 367 ngày → 1002; 366 ngày hợp lệ', async () => {
    await expect(service.salesReport({ from: '2026-11-02', to: '2026-11-01' }, admin)).rejects.toMatchObject({
      errorCode: ErrorCode.HTTP_BAD_REQUEST,
    });
    await expect(service.salesReport({ from: '2025-11-01', to: '2026-11-02' }, admin)).rejects.toMatchObject({
      errorCode: ErrorCode.HTTP_BAD_REQUEST,
    });
    await expect(service.salesReport({ from: '2025-11-02', to: '2026-11-02' }, admin)).resolves.toBeDefined();
  });

  it('daily đủ mọi ngày trong khoảng, ngày không bán = 0', async () => {
    repo.daily.mockResolvedValue([{ date: '2026-11-02', orders: 2, revenue: 70000n }]);
    const report = await service.salesReport({ from: '2026-11-01', to: '2026-11-03' }, admin);
    expect(report.daily).toEqual([
      { date: '2026-11-01', revenue: 0, orders: 0 },
      { date: '2026-11-02', revenue: 70000, orders: 2 },
      { date: '2026-11-03', revenue: 0, orders: 0 },
    ]);
    expect(report.totalRevenue).toBe(70000);
    expect(report.orderCount).toBe(2);
  });

  it('avgOrderValue = round(revenue / orderCount); 0 đơn → 0', async () => {
    repo.daily.mockResolvedValue([{ date: '2026-11-01', orders: 3, revenue: 100000n }]);
    expect((await service.salesReport({ from: '2026-11-01', to: '2026-11-01' }, admin)).avgOrderValue).toBe(33333);
    repo.daily.mockResolvedValue([]);
    expect((await service.salesReport({ from: '2026-11-02', to: '2026-11-02' }, admin)).avgOrderValue).toBe(0);
  });

  it('byBranch và topDrugs đổi bigint sang number, ánh xạ tên trường theo contract; topDrugs tối đa 10', async () => {
    repo.byBranch.mockResolvedValue([{ branchId: BRANCH_1, branchName: 'CN1', orderCount: 2, revenue: 70000n }]);
    repo.topProducts.mockResolvedValue([{ productId: 'p1', productName: 'Thuốc', qtyBase: 5, revenue: 50000n }]);
    const report = await service.salesReport({ from: '2026-11-01', to: '2026-11-01' }, admin);
    expect(repo.topProducts).toHaveBeenCalledWith(expect.anything(), 10);
    expect(report.byBranch).toEqual([{ branchId: BRANCH_1, branchName: 'CN1', revenue: 70000, orderCount: 2 }]);
    expect(report.topDrugs).toEqual([{ drugId: 'p1', drugName: 'Thuốc', qtyInBase: 5, revenue: 50000 }]);
  });

  it('cache: cùng tham số + cùng phạm vi gọi lần 2 không chạm DB; khác phạm vi → không dùng chung', async () => {
    const query = { from: '2026-11-01', to: '2026-11-01', branchIds: [BRANCH_1] };
    const first = await service.salesReport(query, pm);
    expect(repo.daily).toHaveBeenCalledTimes(1);
    expect(await service.salesReport({ ...query }, pm)).toEqual(first);
    expect(repo.daily).toHaveBeenCalledTimes(1);
    // ADMIN hỏi đúng chi nhánh đó: cùng dữ liệu nhưng khác phạm vi → khoá riêng.
    await service.salesReport(query, admin);
    expect(repo.daily).toHaveBeenCalledTimes(2);
    // Thứ tự branchIds không làm đổi khoá.
    await service.salesReport({ ...query, branchIds: [BRANCH_2, BRANCH_1] }, admin);
    await service.salesReport({ ...query, branchIds: [BRANCH_1, BRANCH_2] }, admin);
    expect(repo.daily).toHaveBeenCalledTimes(3);
  });

  it('cache: hết TTL 60 giây thì đọc lại; lỗi không được cache', async () => {
    const query = { from: '2026-11-01', to: '2026-11-01' };
    await service.salesReport(query, admin);
    now += 59_000;
    await service.salesReport(query, admin);
    expect(repo.daily).toHaveBeenCalledTimes(1);
    now += 1_000;
    await service.salesReport(query, admin);
    expect(repo.daily).toHaveBeenCalledTimes(2);

    repo.daily.mockRejectedValueOnce(new Error('db'));
    await expect(service.salesReport({ from: '2026-11-05', to: '2026-11-05' }, admin)).rejects.toThrow('db');
    await service.salesReport({ from: '2026-11-05', to: '2026-11-05' }, admin);
    expect(repo.daily).toHaveBeenCalledTimes(4);
  });
});
