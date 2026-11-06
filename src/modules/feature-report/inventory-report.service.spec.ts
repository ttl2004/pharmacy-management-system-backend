import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthRole } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';
import { InventoryReportRepository } from './inventory-report.repository';
import { InventoryReportService } from './inventory-report.service';
import { InMemoryReportCache } from './report-cache';

const actorOf = (role: AuthRole, branchId: string | null) =>
  ({ user: { userId: 'u1', role, branchId, roleLevel: 40 } }) as unknown as RequestActor;
const BRANCH_1 = '11111111-1111-4111-8111-111111111111';
const BRANCH_2 = '22222222-2222-4222-8222-222222222222';
const pm = actorOf(AuthRole.PHARMACY_MANAGER, BRANCH_1);
const admin = actorOf(AuthRole.ADMIN, null);

const row = (branchId: string, name: string, lotCount: number, value: bigint) => ({
  branchId,
  branchName: name,
  lotCount,
  value,
  expired: 0,
  critical: lotCount,
  warning: 0,
  info: 0,
  ok: 0,
});

describe('InventoryReportService', () => {
  let now = 5_000_000;
  const repo = { byBranch: jest.fn(), distinctProducts: jest.fn(), inTransitQty: jest.fn() };
  let service: InventoryReportService;

  beforeEach(() => {
    jest.clearAllMocks();
    now = 5_000_000;
    repo.byBranch.mockResolvedValue([]);
    repo.distinctProducts.mockResolvedValue(0);
    repo.inTransitQty.mockResolvedValue(0n);
    service = new InventoryReportService(
      repo as unknown as InventoryReportRepository,
      new InMemoryReportCache(() => now),
    );
  });

  it('PM không gửi branchIds → chi nhánh mình; gửi CN khác → 1506, không đọc DB', async () => {
    await service.inventoryReport({}, pm);
    expect(repo.byBranch).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), [BRANCH_1]);
    expect(repo.inTransitQty).toHaveBeenCalledWith([BRANCH_1]);
    repo.byBranch.mockClear();
    await expect(service.inventoryReport({ branchIds: [BRANCH_1, BRANCH_2] }, pm)).rejects.toMatchObject({
      response: { code: ErrorCode.BRANCH_ACCESS_DENIED },
    });
    expect(repo.byBranch).not.toHaveBeenCalled();
  });

  it('ADMIN rỗng → toàn chuỗi, byBranch gồm chi nhánh 0 tồn; tổng cộng dồn từ các chi nhánh', async () => {
    repo.byBranch.mockResolvedValue([row(BRANCH_1, 'CN1', 2, 1000n), row(BRANCH_2, 'CN2', 0, 0n)]);
    repo.distinctProducts.mockResolvedValue(2);
    repo.inTransitQty.mockResolvedValue(7n);
    const report = await service.inventoryReport({}, admin);
    expect(repo.byBranch).toHaveBeenCalledWith(expect.any(String), undefined);
    expect(report).toEqual({
      lotCount: 2,
      drugCount: 2,
      estimatedValue: 1000,
      inTransitQty: 7,
      byBranch: [
        { branchId: BRANCH_1, branchName: 'CN1', lotCount: 2, estimatedValue: 1000 },
        { branchId: BRANCH_2, branchName: 'CN2', lotCount: 0, estimatedValue: 0 },
      ],
      expirySummary: { expired: 0, critical: 2, warning: 0, info: 0, ok: 0 },
    });
  });

  it('cache theo phạm vi: gọi lại trong 60s dùng cache, hết hạn thì đọc lại; ADMIN và PM không dùng chung khoá', async () => {
    await service.inventoryReport({ branchIds: [BRANCH_1] }, admin);
    await service.inventoryReport({ branchIds: [BRANCH_1] }, admin);
    expect(repo.byBranch).toHaveBeenCalledTimes(1);
    await service.inventoryReport({ branchIds: [BRANCH_1] }, pm);
    expect(repo.byBranch).toHaveBeenCalledTimes(2);
    now += 60_001;
    await service.inventoryReport({ branchIds: [BRANCH_1] }, admin);
    expect(repo.byBranch).toHaveBeenCalledTimes(3);
  });

  it('PM xin chi nhánh khác vẫn bị 1506 dù ADMIN đã làm nóng cache cùng khoá', async () => {
    await service.inventoryReport({ branchIds: [BRANCH_2] }, admin);
    await expect(service.inventoryReport({ branchIds: [BRANCH_2] }, pm)).rejects.toMatchObject({
      response: { code: ErrorCode.BRANCH_ACCESS_DENIED },
    });
  });
});
