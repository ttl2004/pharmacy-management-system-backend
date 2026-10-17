import { BatchStatus } from '@prisma/client';
import { AuthRole } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';
import { addDaysToDateOnly, parseDateOnly, todayInVietnam } from 'src/common/utils/date-only.util';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { StockQueryService } from './stock-query.service';

const BRANCH_A = '11111111-1111-4111-8111-111111111111';
const BRANCH_B = '22222222-2222-4222-8222-222222222222';
const actor = (role: AuthRole, branchId: string | null = null): RequestActor => ({
  user: { userId: 'u', sid: 's', email: null, role, branchId, roleLevel: 60 },
  ip: null,
});
const PM_A = actor(AuthRole.PHARMACY_MANAGER, BRANCH_A);
const ADMIN = actor(AuthRole.ADMIN);

function makeService(overrides: Record<string, jest.Mock> = {}) {
  const repository = {
    findBatchPage: jest.fn().mockResolvedValue({ hits: [], total: 0, page: 1, totalPages: 0, limit: 10 }),
    findBatch: jest.fn(),
    findProductStockPage: jest.fn().mockResolvedValue({ hits: [], total: 0, page: 1, totalPages: 0, limit: 10 }),
    findMovements: jest.fn().mockResolvedValue([]),
    findLowStock: jest.fn().mockResolvedValue([]),
    findMovementSummary: jest.fn().mockResolvedValue([]),
    ...overrides,
  };
  return { service: new StockQueryService(repository as never), repository };
}

describe('StockQueryService — phạm vi chi nhánh', () => {
  it('PM không gửi branchId → tự lọc chi nhánh mình', async () => {
    const { service, repository } = makeService();
    await service.listBatches({ page: 1, limit: 10 } as never, PM_A);
    const [where] = repository.findBatchPage.mock.calls[0] as [Record<string, unknown>];
    expect(where.branchId).toBe(BRANCH_A);
  });

  it('PM lọc chi nhánh khác → 1506', async () => {
    const { service } = makeService();
    await expect(service.listMovements({ branchId: BRANCH_B, limit: 10 } as never, PM_A)).rejects.toMatchObject({
      response: { code: ErrorCode.BRANCH_ACCESS_DENIED },
    });
  });

  it('chi tiết lô: điều kiện chi nhánh nằm trong truy vấn, ngoài phạm vi → 1600', async () => {
    const findBatch = jest.fn().mockResolvedValue(null);
    const { service } = makeService({ findBatch });
    await expect(service.getBatch('b1', PM_A)).rejects.toMatchObject({ errorCode: ErrorCode.RECORD_NOT_FOUND });
    expect(findBatch).toHaveBeenCalledWith('b1', { branchId: BRANCH_A });
  });

  it('báo cáo sắp hết hàng: ADMIN phải chọn chi nhánh', async () => {
    const { service } = makeService();
    await expect(service.lowStock({ page: 1, limit: 10 } as never, ADMIN)).rejects.toMatchObject({
      errorCode: ErrorCode.HTTP_BAD_REQUEST,
    });
  });
});

describe('StockQueryService — trường suy ra', () => {
  it('lô hết hạn hôm nay: isExpired, không bán được; available = tồn − giữ', async () => {
    const today = todayInVietnam();
    const findBatch = jest.fn().mockResolvedValue({
      id: 'b1',
      expiryDate: parseDateOnly(today),
      quantityOnHand: 10,
      reservedQuantity: 3,
      status: BatchStatus.AVAILABLE,
    });
    const { service } = makeService({ findBatch });

    expect(await service.getBatch('b1', ADMIN)).toMatchObject({
      availableQuantity: 7,
      daysToExpiry: 0,
      isExpired: true,
      isSellable: false,
    });
  });

  it('lô còn hạn nhưng bị thu hồi thì không bán được', async () => {
    const findBatch = jest.fn().mockResolvedValue({
      id: 'b1',
      expiryDate: parseDateOnly(addDaysToDateOnly(todayInVietnam(), 100)),
      quantityOnHand: 1,
      reservedQuantity: 0,
      status: BatchStatus.RECALLED,
    });
    const { service } = makeService({ findBatch });
    expect((await service.getBatch('b1', ADMIN)).isSellable).toBe(false);
  });

  it('tồn theo sản phẩm: isLow khi bán được < ngưỡng; ngưỡng 0 thì không bao giờ low', async () => {
    const { service } = makeService({
      findProductStockPage: jest.fn().mockResolvedValue({
        hits: [
          { productId: 'p1', sellable: 5, minStockLevel: 10 },
          { productId: 'p2', sellable: 0, minStockLevel: 0 },
        ],
        total: 2,
        page: 1,
        totalPages: 1,
        limit: 10,
      }),
    });
    const result = await service.listProducts({ page: 1, limit: 10 } as never, ADMIN);
    expect(result.hits.map((row) => row.isLow)).toEqual([true, false]);
  });
});

describe('StockQueryService — nhập–xuất–tồn', () => {
  it('kỳ quá 366 ngày hoặc ngược → 1002', async () => {
    const { service } = makeService();
    await expect(
      service.movementSummary({ fromDate: '2025-01-01', toDate: '2026-06-01' }, ADMIN),
    ).rejects.toMatchObject({
      errorCode: ErrorCode.HTTP_BAD_REQUEST,
    });
    await expect(
      service.movementSummary({ fromDate: '2026-02-01', toDate: '2026-01-01' }, ADMIN),
    ).rejects.toMatchObject({
      errorCode: ErrorCode.HTTP_BAD_REQUEST,
    });
  });

  it('ranh giới kỳ theo giờ VN: toDate tính trọn ngày', async () => {
    const { service, repository } = makeService();
    await service.movementSummary({ fromDate: '2026-10-01', toDate: '2026-10-31' }, PM_A);
    expect(repository.findMovementSummary).toHaveBeenCalledWith({
      branchId: BRANCH_A,
      from: new Date('2026-09-30T17:00:00.000Z'),
      toExclusive: new Date('2026-10-31T17:00:00.000Z'),
    });
  });
});
