import { ADMIN_ACTOR, entriesOf, fakePrisma } from 'src/test-support/audit-harness';
import { LocationService } from './location.service';

describe('LocationService — nhật ký', () => {
  it('create ghi LOCATION.CREATED (shelf_locations, branchIds [], nhãn = tên)', async () => {
    const audit = { record: jest.fn() };
    const create = jest.fn().mockImplementation((d: object) => Promise.resolve({ id: 'loc-1', ...d }));
    const repository = { findByNameInsensitive: jest.fn().mockResolvedValue(null), create };
    const prisma = fakePrisma({ marker: true });
    const service = new LocationService(repository as never, prisma as never, audit as never);

    await expect(service.create({ name: 'Kệ A' }, ADMIN_ACTOR)).resolves.toEqual({ id: 'loc-1', name: 'Kệ A' });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Kệ A', createdBy: 'admin-1' }), prisma.tx);
    expect(entriesOf(audit)).toEqual([
      expect.objectContaining({
        event: 'LOCATION.CREATED',
        entityType: 'shelf_locations',
        entityId: 'loc-1',
        entityLabel: 'Kệ A',
        branchIds: [],
        after: { name: 'Kệ A' },
      }),
    ]);
  });
});
