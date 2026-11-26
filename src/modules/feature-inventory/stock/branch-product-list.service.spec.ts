import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthRole } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';
import { addDaysToDateOnly, todayInVietnam } from 'src/common/utils/date-only.util';
import { BranchProductListService, forecastStockout } from './branch-product-list.service';
import { BranchProductListQuery } from './dtos/branch-product-list.query';

const BRANCH_A = '11111111-1111-4111-8111-111111111111';
const BRANCH_B = '22222222-2222-4222-8222-222222222222';
const P1 = '33333333-3333-4333-8333-333333333333';

const actor = (role: AuthRole, branchId: string | null = null): RequestActor => ({
  user: { userId: 'u', sid: 's', email: null, role, branchId, roleLevel: 60 },
  ip: null,
  userAgent: null,
  requestId: null,
});
const PM_A = actor(AuthRole.PHARMACY_MANAGER, BRANCH_A);
const ADMIN = actor(AuthRole.ADMIN);

const query = (over: Partial<BranchProductListQuery> = {}) =>
  Object.assign(new BranchProductListQuery(), { page: 1, limit: 10, ...over });

const aggRow = {
  productId: P1,
  onHand: 120,
  sellable: 100,
  avgCost: 650,
  nearestExpiry: new Date('2027-06-30T00:00:00Z'),
  minStock: 50,
  maxStock: 500,
};

function makeService(granted: string[] = ['goods-receipt:create']) {
  const repository = {
    findPage: jest.fn().mockResolvedValue({ rows: [aggRow], total: 1, totalQtyOnHand: 120 }),
    findItems: jest.fn().mockResolvedValue([{ id: P1, code: 'TH0001', name: 'Paracetamol' }]),
    findLastPurchase: jest
      .fn()
      .mockImplementation((_scope: string, _ids: string[], perBranch?: boolean) =>
        Promise.resolve(new Map([[perBranch ? `${BRANCH_A}:${P1}` : P1, 700]])),
      ),
    findSold: jest
      .fn()
      .mockImplementation((_scope: string, _ids: string[], _today: string, perBranch?: boolean) =>
        Promise.resolve(new Map([[perBranch ? `${BRANCH_A}:${P1}` : P1, 60]])),
      ),
    findBranchBreakdown: jest
      .fn()
      .mockResolvedValue([{ ...aggRow, branchId: BRANCH_A, branchCode: 'CN01', branchName: 'Chi nhánh 1' }]),
  };
  const permissions = { getGrantedCodes: jest.fn().mockResolvedValue(new Set(granted)) };
  const pageCall = (i: 0 | 1) => (repository.findPage.mock.calls[0] as Record<string, unknown>[])[i];
  return { service: new BranchProductListService(repository as never, permissions as never), repository, pageCall };
}

describe('forecastStockout', () => {
  it('hôm nay + floor(tồn × 30 / bán 30 ngày)', () => {
    expect(forecastStockout('2026-11-26', 100, 60)).toBe('2027-01-15'); // 50 ngày
    expect(forecastStockout('2026-11-26', 10, 7)).toBe('2027-01-07'); // floor(42,86) = 42
  });
  it('null khi hết tồn hoặc không bán', () => {
    expect(forecastStockout('2026-11-26', 0, 10)).toBeNull();
    expect(forecastStockout('2026-11-26', -5, 10)).toBeNull();
    expect(forecastStockout('2026-11-26', 10, 0)).toBeNull();
  });
});

describe('BranchProductListService — phạm vi', () => {
  it('PM không gửi branchId → chi nhánh mình, không có branches', async () => {
    const { service, repository, pageCall } = makeService();
    const res = await service.list(query(), PM_A);
    expect(pageCall(0)).toMatchObject({ branchId: BRANCH_A });
    expect(repository.findBranchBreakdown).not.toHaveBeenCalled();
    expect(res.branchId).toBe(BRANCH_A);
    expect(res.hits[0].branches).toBeNull();
  });

  it('PM gửi chi nhánh khác → 1506, không truy vấn', async () => {
    const { service, repository } = makeService();
    await expect(service.list(query({ branchId: BRANCH_B }), PM_A)).rejects.toMatchObject({
      response: { code: ErrorCode.BRANCH_ACCESS_DENIED },
    });
    expect(repository.findPage).not.toHaveBeenCalled();
  });

  it('ADMIN không gửi branchId → toàn chuỗi: branches theo chi nhánh, định mức dòng tổng null', async () => {
    const { service, repository, pageCall } = makeService();
    const res = await service.list(query(), ADMIN);
    expect(pageCall(0)).toMatchObject({ branchId: null });
    expect(repository.findLastPurchase).toHaveBeenCalledWith('ALL', [P1]);
    expect(repository.findLastPurchase).toHaveBeenCalledWith('ALL', [P1], true);
    expect(res.branchId).toBeNull();
    expect(res.hits[0]).toMatchObject({ minStock: null, maxStock: null, lastPurchaseCost: 700 });
    expect(res.hits[0].branches).toEqual([
      expect.objectContaining({ branchCode: 'CN01', qtyOnHand: 120, lastPurchaseCost: 700, minStock: 50 }),
    ]);
  });
});

describe('BranchProductListService — số liệu và giá vốn', () => {
  it('gộp số liệu + tổng tồn + phân trang', async () => {
    const { service } = makeService();
    const res = await service.list(query({ branchId: BRANCH_A }), ADMIN);
    const today = todayInVietnam();
    expect(res).toMatchObject({ total: 1, page: 1, totalPages: 1, limit: 10, summary: { totalQtyOnHand: 120 } });
    expect(res.hits[0]).toMatchObject({
      code: 'TH0001',
      qtyOnHand: 120,
      sellable: 100,
      avgCost: 650,
      lastPurchaseCost: 700,
      soldLast30Days: 60,
      stockoutDate: addDaysToDateOnly(today, 60),
      nearestExpiry: '2027-06-30',
      minStock: 50,
      maxStock: 500,
    });
  });

  it('chuyển bộ lọc: mặc định stock=all, stockOp=lt, sortDir=asc; mảng rỗng khi không gửi', async () => {
    const { service, pageCall } = makeService();
    await service.list(query({ branchId: BRANCH_A, q: '  para ', sortBy: 'qtyOnHand' }), ADMIN);
    const [filter, options] = [pageCall(0), pageCall(1)];
    expect(filter).toMatchObject({ stock: 'all', stockOp: 'lt', supplierIds: [], product: { q: 'para' } });
    expect(options).toEqual({ page: 1, limit: 10, sortBy: 'qtyOnHand', sortDir: 'asc' });
  });

  it('không được xem giá vốn → giá null, không đọc giá nhập cuối, sort theo giá bị bỏ', async () => {
    const { service, repository, pageCall } = makeService(['stock:read', 'product:read']);
    const res = await service.list(query({ sortBy: 'lastPurchaseCost', sortDir: 'desc' }), ADMIN);
    expect(pageCall(1)).toMatchObject({ sortBy: undefined });
    expect(repository.findLastPurchase).not.toHaveBeenCalled();
    expect(res.hits[0]).toMatchObject({ avgCost: null, lastPurchaseCost: null });
    expect(res.hits[0].branches?.[0]).toMatchObject({ avgCost: null, lastPurchaseCost: null });
  });

  it('SUPER_ADMIN luôn thấy giá vốn; sort khác giá vẫn giữ khi không thấy giá', async () => {
    const { service } = makeService([]);
    const res = await service.list(query({ branchId: BRANCH_A }), actor(AuthRole.SUPER_ADMIN));
    expect(res.hits[0].avgCost).toBe(650);
    const hidden = makeService([]);
    await hidden.service.list(query({ sortBy: 'stockoutDate' }), ADMIN);
    expect(hidden.pageCall(1)).toMatchObject({ sortBy: 'stockoutDate' });
  });
});
