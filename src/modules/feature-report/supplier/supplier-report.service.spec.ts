import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthRole } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';
import { PermissionService } from '../../feature-auth/permission/permission.service';
import { InMemoryReportCache } from '../report-cache';
import { SupplierReportFilter, SupplierReportRepository } from './supplier-report.repository';
import { SupplierReportService } from './supplier-report.service';

const actorOf = (role: AuthRole, branchId: string | null) =>
  ({ user: { userId: 'u1', role, branchId, roleLevel: 40 } }) as unknown as RequestActor;
const BRANCH_1 = '11111111-1111-4111-8111-111111111111';
const BRANCH_2 = '22222222-2222-4222-8222-222222222222';
const BRANCH_3 = '33333333-3333-4333-8333-333333333333';
const S1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const S2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const pm = actorOf(AuthRole.PHARMACY_MANAGER, BRANCH_1);
const admin = actorOf(AuthRole.ADMIN, null);
const superAdmin = actorOf(AuthRole.SUPER_ADMIN, null);
const range = { from: '2026-11-01', to: '2026-11-30' };

describe('SupplierReportService', () => {
  let now = 5_000_000;
  const repo = {
    receipts: jest.fn(),
    payments: jest.fn(),
    returns: jest.fn(),
    adjustments: jest.fn(),
    topProducts: jest.fn(),
    suppliersByIds: jest.fn(),
    branches: jest.fn(),
    receiptList: jest.fn(),
  };
  const permissions = { getGrantedCodes: jest.fn() };
  let service: SupplierReportService;

  beforeEach(() => {
    jest.clearAllMocks();
    now = 5_000_000;
    for (const fn of [repo.receipts, repo.payments, repo.returns, repo.adjustments, repo.topProducts]) {
      fn.mockResolvedValue([]);
    }
    repo.suppliersByIds.mockResolvedValue([]);
    repo.branches.mockResolvedValue([]);
    permissions.getGrantedCodes.mockResolvedValue(new Set(['supplier-debt:read']));
    service = new SupplierReportService(
      repo as unknown as SupplierReportRepository,
      permissions as unknown as PermissionService,
      new InMemoryReportCache(() => now),
    );
  });

  it('from > to và khoảng > 366 ngày → 1002, không đọc DB', async () => {
    await expect(service.supplierReport({ from: '2026-11-30', to: '2026-11-01' }, admin)).rejects.toMatchObject({
      errorCode: ErrorCode.HTTP_BAD_REQUEST,
    });
    await expect(service.supplierReport({ from: '2025-11-01', to: '2026-11-30' }, admin)).rejects.toMatchObject({
      errorCode: ErrorCode.HTTP_BAD_REQUEST,
    });
    expect(repo.receipts).not.toHaveBeenCalled();
    // đúng 366 ngày thì được
    await service.supplierReport({ from: '2026-01-01', to: '2027-01-01' }, admin);
    expect(repo.receipts).toHaveBeenCalledTimes(1);
  });

  it('PM bỏ trống → chi nhánh mình; xin CN khác → 1506; ADMIN bỏ trống → toàn chuỗi (undefined)', async () => {
    await service.supplierReport(range, pm);
    expect(repo.receipts).toHaveBeenCalledWith(expect.objectContaining({ branchIds: [BRANCH_1] }));
    repo.receipts.mockClear();
    await expect(service.supplierReport({ ...range, branchIds: [BRANCH_2] }, pm)).rejects.toMatchObject({
      response: { code: ErrorCode.BRANCH_ACCESS_DENIED },
    });
    expect(repo.receipts).not.toHaveBeenCalled();
    await service.supplierReport(range, admin);
    expect(repo.receipts).toHaveBeenCalledWith(expect.objectContaining({ branchIds: undefined }));
  });

  it('mốc thời gian là 00:00 giờ VN của from và của to+1; supplierId được chuyển xuống', async () => {
    await service.supplierReport({ ...range, supplierId: S1 }, admin);
    expect(repo.receipts).toHaveBeenCalledWith(
      expect.objectContaining({
        start: new Date('2026-11-01T00:00:00.000+07:00'),
        end: new Date('2026-12-01T00:00:00.000+07:00'),
        supplierId: S1,
      }),
    );
  });

  it('ghép các thành phần: closing = opening + nhập − trả − chi + điều chỉnh; sắp theo nhập giảm dần', async () => {
    repo.receipts.mockResolvedValue([
      { supplierId: S1, branchId: BRANCH_1, opening: 5_000_000n, period: 20_000_000n, count: 2 },
      { supplierId: S2, branchId: BRANCH_1, opening: 0n, period: 30_000_000n, count: 1 },
    ]);
    repo.returns.mockResolvedValue([{ supplierId: S1, branchId: BRANCH_1, opening: 0n, period: 1_000_000n, count: 1 }]);
    repo.payments.mockResolvedValue([
      { supplierId: S1, branchId: BRANCH_1, opening: 0n, period: 15_000_000n, count: 1 },
    ]);
    repo.adjustments.mockResolvedValue([{ supplierId: S1, branchId: BRANCH_1, opening: 0n, period: 500n, count: 1 }]);
    repo.suppliersByIds.mockResolvedValue([
      { id: S1, code: 'NCC1', name: 'Dược Hậu Giang' },
      { id: S2, code: 'NCC2', name: 'Traphaco' },
    ]);
    repo.topProducts.mockResolvedValue([{ productId: 'p1', productName: 'Para', qtyBase: 10, amount: 700n }]);

    const report = await service.supplierReport(range, admin);

    expect(report.bySupplier.map((s) => s.supplierId)).toEqual([S2, S1]);
    expect(report.bySupplier[1]).toEqual({
      supplierId: S1,
      supplierCode: 'NCC1',
      supplierName: 'Dược Hậu Giang',
      receiptCount: 2,
      purchaseAmount: 20_000_000,
      returnCount: 1,
      returnAmount: 1_000_000,
      paidAmount: 15_000_000,
      adjustmentAmount: 500,
      openingDebt: 5_000_000,
      closingDebt: 9_000_500,
    });
    expect(report.totals).toEqual({
      purchaseAmount: 50_000_000,
      returnAmount: 1_000_000,
      paidAmount: 15_000_000,
      adjustmentAmount: 500,
      openingDebt: 5_000_000,
      closingDebt: 39_000_500,
    });
    expect(report.topProducts).toEqual([{ productId: 'p1', productName: 'Para', qtyBase: 10, amount: 700 }]);
  });

  it('byBranch: cộng theo chi nhánh qua mọi NCC, tổng các dòng = totals; chi nhánh 0đ vẫn có dòng; sắp theo nhập giảm dần', async () => {
    repo.receipts.mockResolvedValue([
      { supplierId: S1, branchId: BRANCH_1, opening: 5_000_000n, period: 20_000_000n, count: 2 },
      { supplierId: S1, branchId: BRANCH_2, opening: 1_000n, period: 30_000_000n, count: 1 },
      { supplierId: S2, branchId: BRANCH_1, opening: 0n, period: 4_000_000n, count: 1 },
    ]);
    repo.payments.mockResolvedValue([
      { supplierId: S1, branchId: BRANCH_2, opening: 0n, period: 10_000_000n, count: 1 },
    ]);
    repo.returns.mockResolvedValue([{ supplierId: S2, branchId: BRANCH_1, opening: 0n, period: 500n, count: 1 }]);
    repo.suppliersByIds.mockResolvedValue([
      { id: S1, code: 'NCC1', name: 'A' },
      { id: S2, code: 'NCC2', name: 'B' },
    ]);
    repo.branches.mockResolvedValue([
      { id: BRANCH_1, name: 'CN1' },
      { id: BRANCH_2, name: 'CN2' },
      { id: BRANCH_3, name: 'CN3' },
    ]);

    const report = await service.supplierReport(range, admin);

    expect(repo.branches).toHaveBeenCalledWith(undefined, expect.arrayContaining([BRANCH_1, BRANCH_2]));
    expect(report.byBranch).toEqual([
      {
        branchId: BRANCH_2,
        branchName: 'CN2',
        receiptCount: 1,
        purchaseAmount: 30_000_000,
        returnCount: 0,
        returnAmount: 0,
        paidAmount: 10_000_000,
        adjustmentAmount: 0,
        openingDebt: 1_000,
        closingDebt: 20_001_000,
      },
      {
        branchId: BRANCH_1,
        branchName: 'CN1',
        receiptCount: 3,
        purchaseAmount: 24_000_000,
        returnCount: 1,
        returnAmount: 500,
        paidAmount: 0,
        adjustmentAmount: 0,
        openingDebt: 5_000_000,
        closingDebt: 28_999_500,
      },
      {
        branchId: BRANCH_3,
        branchName: 'CN3',
        receiptCount: 0,
        purchaseAmount: 0,
        returnCount: 0,
        returnAmount: 0,
        paidAmount: 0,
        adjustmentAmount: 0,
        openingDebt: 0,
        closingDebt: 0,
      },
    ]);
    const sum = (k: 'purchaseAmount' | 'closingDebt') => report.byBranch.reduce((s, b) => s + (b[k] ?? 0), 0);
    expect(sum('purchaseAmount')).toBe(report.totals.purchaseAmount);
    expect(sum('closingDebt')).toBe(report.totals.closingDebt);

    // Không có quyền nợ: số nợ theo chi nhánh cũng null.
    permissions.getGrantedCodes.mockResolvedValue(new Set(['report:read']));
    const noDebt = await service.supplierReport(range, admin);
    expect(noDebt.byBranch[0]).toMatchObject({ purchaseAmount: 30_000_000, paidAmount: null, openingDebt: null });
  });

  it('byBranch theo phạm vi: PM chỉ lấy chi nhánh mình', async () => {
    await service.supplierReport(range, pm);
    expect(repo.branches).toHaveBeenCalledWith([BRANCH_1], []);
  });

  it('NCC chỉ có nợ đầu kỳ vẫn hiện; NCC đầu kỳ 0 và không phát sinh thì không hiện', async () => {
    repo.receipts.mockResolvedValue([
      { supplierId: S1, branchId: BRANCH_1, opening: 100n, period: 0n, count: 0 },
      { supplierId: S2, branchId: BRANCH_1, opening: 0n, period: 0n, count: 0 },
    ]);
    repo.suppliersByIds.mockResolvedValue([{ id: S1, code: 'NCC1', name: 'A' }]);
    const report = await service.supplierReport(range, admin);
    expect(report.bySupplier).toHaveLength(1);
    expect(report.bySupplier[0]).toMatchObject({ supplierId: S1, openingDebt: 100, closingDebt: 100 });
  });

  it('thiếu supplier-debt:read → các trường nợ null (cả totals), không hiện NCC chỉ vì nợ đầu kỳ, không đọc phiếu chi/điều chỉnh', async () => {
    permissions.getGrantedCodes.mockResolvedValue(new Set(['report:read']));
    repo.receipts.mockResolvedValue([
      { supplierId: S1, branchId: BRANCH_1, opening: 7_654_321n, period: 0n, count: 0 }, // chỉ có nợ cũ: không được lộ
      { supplierId: S2, branchId: BRANCH_1, opening: 0n, period: 900n, count: 1 },
    ]);
    repo.suppliersByIds.mockResolvedValue([{ id: S2, code: 'NCC2', name: 'B' }]);

    const report = await service.supplierReport(range, admin);

    expect(repo.payments).not.toHaveBeenCalled();
    expect(repo.adjustments).not.toHaveBeenCalled();
    expect(report.bySupplier).toHaveLength(1);
    expect(report.bySupplier[0]).toMatchObject({
      supplierId: S2,
      purchaseAmount: 900,
      openingDebt: null,
      closingDebt: null,
      paidAmount: null,
      adjustmentAmount: null,
    });
    expect(report.totals).toMatchObject({
      purchaseAmount: 900,
      openingDebt: null,
      closingDebt: null,
      paidAmount: null,
      adjustmentAmount: null,
    });
    expect(JSON.stringify(report)).not.toContain('7654321');
  });

  it('SUPER_ADMIN luôn xem được nợ, không cần bảng quyền', async () => {
    permissions.getGrantedCodes.mockResolvedValue(new Set());
    repo.receipts.mockResolvedValue([{ supplierId: S1, branchId: BRANCH_1, opening: 100n, period: 0n, count: 0 }]);
    repo.suppliersByIds.mockResolvedValue([{ id: S1, code: 'NCC1', name: 'A' }]);
    const report = await service.supplierReport(range, superAdmin);
    expect(report.bySupplier[0].openingDebt).toBe(100);
  });

  it('cache: khoá phân biệt phạm vi và quyền xem nợ; hết 60 giây thì đọc lại', async () => {
    await service.supplierReport(range, admin);
    await service.supplierReport(range, admin);
    expect(repo.receipts).toHaveBeenCalledTimes(1);
    await service.supplierReport({ ...range, branchIds: [BRANCH_1] }, pm); // PM khác phạm vi
    expect(repo.receipts).toHaveBeenCalledTimes(2);
    // cùng ADMIN nhưng không có quyền nợ: không được dùng cache có số nợ
    permissions.getGrantedCodes.mockResolvedValue(new Set(['report:read']));
    const noDebt = await service.supplierReport(range, admin);
    expect(repo.receipts).toHaveBeenCalledTimes(3);
    expect(noDebt.totals.openingDebt).toBeNull();
    await service.supplierReport({ ...range, supplierId: S1 }, admin);
    expect(repo.receipts).toHaveBeenCalledTimes(4);
    now += 60_001;
    await service.supplierReport({ ...range, supplierId: S1 }, admin);
    expect(repo.receipts).toHaveBeenCalledTimes(5);
  });

  describe('supplierReceipts', () => {
    const row = {
      id: 'r1',
      code: 'PN1',
      confirmedAt: new Date('2026-11-05T03:00:00Z'),
      supplierId: S1,
      supplierName: 'A',
      branchId: BRANCH_1,
      branchName: 'CN1',
      totalAmount: 1000n,
      paidAmount: 300n,
      returnAmount: 100n,
      total: 7,
    };

    it('ánh xạ dòng, remaining = nhập − trả − trả hàng, total từ cửa sổ; mặc định limit 100; mốc giờ VN', async () => {
      repo.receiptList.mockResolvedValue([row]);
      const res = await service.supplierReceipts({ ...range, supplierId: S1 }, admin);
      expect(res.total).toBe(7);
      expect(res.items[0]).toMatchObject({
        paidAmount: 300,
        returnAmount: 100,
        remaining: 600,
        confirmedAt: '2026-11-05T03:00:00.000Z',
      });
      const [filter, limit] = repo.receiptList.mock.calls[0] as [SupplierReportFilter, number];
      expect(limit).toBe(100);
      expect(filter.start.toISOString()).toBe('2026-10-31T17:00:00.000Z');
      expect(filter.end.toISOString()).toBe('2026-11-30T17:00:00.000Z');
      expect(filter.supplierId).toBe(S1);
    });

    it('PM bị giới hạn chi nhánh mình, CN khác → 1506; rỗng → total 0', async () => {
      repo.receiptList.mockResolvedValue([]);
      const res = await service.supplierReceipts(range, pm);
      expect(res).toEqual({ items: [], total: 0 });
      expect((repo.receiptList.mock.calls[0] as [SupplierReportFilter])[0].branchIds).toEqual([BRANCH_1]);
      await expect(service.supplierReceipts({ ...range, branchIds: [BRANCH_2] }, pm)).rejects.toMatchObject({
        response: { code: ErrorCode.BRANCH_ACCESS_DENIED },
      });
    });

    it('thiếu supplier-debt:read → paidAmount, remaining null; có cache', async () => {
      permissions.getGrantedCodes.mockResolvedValue(new Set(['report:read']));
      repo.receiptList.mockResolvedValue([row]);
      const res = await service.supplierReceipts({ ...range, limit: 5 }, admin);
      expect(res.items[0]).toMatchObject({ paidAmount: null, remaining: null, totalAmount: 1000 });
      await service.supplierReceipts({ ...range, limit: 5 }, admin);
      expect(repo.receiptList).toHaveBeenCalledTimes(1);
    });
  });
});
