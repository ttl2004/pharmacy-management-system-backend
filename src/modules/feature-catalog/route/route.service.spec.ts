import { ADMIN_ACTOR, entriesOf } from 'src/test-support/audit-harness';
import { RouteService } from './route.service';

describe('RouteService — nhật ký', () => {
  it('create ghi ROUTE.CREATED (administration_routes, branchIds [], nhãn = tên) trong transaction', async () => {
    const audit = { record: jest.fn() };
    const create = jest.fn().mockResolvedValue({ id: 'rt-1', name: 'Uống' });
    const tx = { administrationRoute: { create } };
    const prisma = {
      administrationRoute: { findFirst: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn((work: (t: unknown) => unknown) => work(tx)),
    };
    const service = new RouteService(prisma as never, audit as never);

    await expect(service.create({ name: 'Uống' }, ADMIN_ACTOR)).resolves.toEqual({ id: 'rt-1', name: 'Uống' });

    expect(entriesOf(audit)).toEqual([
      expect.objectContaining({
        event: 'ROUTE.CREATED',
        entityType: 'administration_routes',
        entityId: 'rt-1',
        entityLabel: 'Uống',
        branchIds: [],
        after: { name: 'Uống' },
      }),
    ]);
  });
});
