import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthRole } from 'src/common/types/common.enum';
import { PriceBookRowsService } from './price-book-rows.service';

const ADMIN: RequestActor = {
  user: { userId: 'admin-1', sid: 's', email: null, role: AuthRole.ADMIN, branchId: null, roleLevel: 80 },
  ip: '10.0.0.1',
  userAgent: null,
  requestId: 'req-1',
};

const TX = { marker: 'tx' };

function makeService(unit: Record<string, unknown> | null) {
  const rowsRepository = {
    findProductUnit: jest.fn().mockResolvedValue(unit),
    setGeneralPrice: jest.fn().mockResolvedValue(undefined),
  };
  const bookRepository = { transaction: jest.fn().mockImplementation((work: (tx: unknown) => unknown) => work(TX)) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new PriceBookRowsService(rowsRepository as never, bookRepository as never, audit as never);
  return { service, rowsRepository, audit };
}

describe('PriceBookRowsService — sửa giá chung', () => {
  const unit = { id: 'pu-1', salePrice: 500, product: { code: 'SP0001', name: 'Paracetamol' } };

  it('ghi PRODUCT.PRICE_CHANGED, amount = giá mới (bigint), nhãn = mã sản phẩm, branchIds []', async () => {
    const { service, rowsRepository, audit } = makeService(unit);

    await service.setGeneralPrice({ drugId: 'prod-1', unitId: 'unit-1', price: 650 }, ADMIN);

    expect(rowsRepository.setGeneralPrice).toHaveBeenCalledWith(TX, 'pu-1', 650, 'admin-1');
    expect(audit.record).toHaveBeenCalledTimes(1);
    const [tx, actor, entries] = audit.record.mock.calls[0] as [unknown, Record<string, unknown>, unknown[]];
    expect(tx).toBe(TX);
    expect(actor).toMatchObject({ userId: 'admin-1', ip: '10.0.0.1', requestId: 'req-1' });
    expect(entries).toEqual([
      {
        event: 'PRODUCT.PRICE_CHANGED',
        entityType: 'products',
        entityId: 'prod-1',
        entityLabel: 'SP0001',
        branchIds: [],
        before: { unitId: 'unit-1', salePrice: 500 },
        after: { unitId: 'unit-1', salePrice: 650 },
        amount: 650n,
        searchTerms: ['SP0001', 'Paracetamol'],
      },
    ]);
  });

  it('giá không đổi thì không ghi', async () => {
    const { service, audit } = makeService(unit);
    await service.setGeneralPrice({ drugId: 'prod-1', unitId: 'unit-1', price: 500 }, ADMIN);
    expect(audit.record).not.toHaveBeenCalled();
  });
});
