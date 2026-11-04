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
    product: {
      findFirst: jest.fn().mockResolvedValue({ id: 'p1', code: 'SP001', name: 'Panadol', trackBatches: false }),
    },
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

  it('lô tồn đầu thừa hưởng thu hồi → MỘT lần record gồm entry intake trả về và STOCK.OPENING', async () => {
    const recalled = { event: 'BATCH.RECALLED', entityId: 'b1', branchIds: [A], reason: 'QĐ' };
    const { service, audit } = makeService([recalled]);
    await service.create(dto, PM_A);
    expect(audit.record).toHaveBeenCalledTimes(1);
    const entries = (audit.record.mock.calls[0] as [unknown, unknown, Record<string, unknown>[]])[2];
    expect(entries[0]).toEqual(recalled);
    expect(entries.map((e) => e.event)).toEqual(['BATCH.RECALLED', 'STOCK.OPENING']);
    expect((audit.record.mock.calls as unknown[][])[0][1]).toMatchObject({ userId: 'pm-a' });
  });

  it('opening ghi STOCK.OPENING amount đúng (quantity × unitCost, bigint), branchIds [chi nhánh]', async () => {
    const { service, audit } = makeService([]);
    await service.create({ ...dto, quantity: 10, unitCost: 1500 }, PM_A);
    expect(audit.record).toHaveBeenCalledTimes(1);
    const entries = (audit.record.mock.calls[0] as [unknown, unknown, Record<string, unknown>[]])[2];
    expect(entries).toEqual([
      {
        event: 'STOCK.OPENING',
        entityType: 'products',
        entityId: 'p1',
        entityLabel: 'SP001',
        branchIds: [A],
        searchTerms: ['SP001', 'Panadol'],
        amount: 15000n,
        metadata: { batchId: 'b1', quantity: 10, unitCost: '1500' },
      },
    ]);
  });
});
