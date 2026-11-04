import { RecordStatus } from '@prisma/client';
import { AuthRole } from 'src/common/types/common.enum';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { StockOpeningService } from './stock-opening.service';

const A = '11111111-1111-4111-8111-111111111111';
const PM_A: RequestActor = {
  user: { userId: 'pm-a', sid: 's', email: null, role: AuthRole.PHARMACY_MANAGER, branchId: A, roleLevel: 60 },
  ip: null,
  userAgent: null,
  requestId: null,
};

function makeService(auditEntries: unknown[]) {
  const tx = {
    branch: { findFirst: jest.fn().mockResolvedValue({ id: A, status: RecordStatus.ACTIVE }) },
    product: { findFirst: jest.fn().mockResolvedValue({ id: 'p1', trackBatches: false }) },
    stockBatch: { count: jest.fn().mockResolvedValue(0) },
  };
  const transactions = { run: jest.fn((work: (ctx: unknown) => unknown) => work({ tx })) };
  const intake = {
    intake: jest.fn().mockResolvedValue({ batchIdByRefItem: new Map([['p1', 'b1']]), movements: [], auditEntries }),
  };
  const audit = { record: jest.fn() };
  const service = new StockOpeningService(transactions as never, intake as never, audit as never);
  return { service, audit };
}

describe('StockOpeningService — nhật ký', () => {
  const dto = { branchId: A, productId: 'p1', quantity: 10, unitCost: 1000 };

  it('lô tồn đầu thừa hưởng thu hồi → record entry intake trả về (một lần, actor của request)', async () => {
    const recalled = { event: 'BATCH.RECALLED', entityId: 'b1', branchIds: [A], reason: 'QĐ' };
    const { service, audit } = makeService([recalled]);
    await service.create(dto, PM_A);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ userId: 'pm-a' }), [
      recalled,
    ]);
  });

  it('không có entry → không gọi record', async () => {
    const { service, audit } = makeService([]);
    await service.create(dto, PM_A);
    expect(audit.record).not.toHaveBeenCalled();
  });
});
