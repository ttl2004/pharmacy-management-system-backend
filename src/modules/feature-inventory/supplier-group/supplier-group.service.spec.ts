import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthRole } from 'src/common/types/common.enum';
import { SupplierGroupService } from './supplier-group.service';

const ADMIN: RequestActor = {
  user: { userId: 'admin-1', sid: 's', email: null, role: AuthRole.ADMIN, branchId: null, roleLevel: 80 },
  ip: '10.0.0.1',
  userAgent: null,
  requestId: 'req-1',
};

const EXISTING = { id: 'grp-1', name: 'Nhóm A', note: null };

function makeService() {
  const repository = {
    findAll: jest.fn(),
    findActiveWith: jest.fn().mockResolvedValue(EXISTING),
    nameTakenWith: jest.fn().mockResolvedValue(false),
    createWith: jest
      .fn()
      .mockImplementation((_tx: unknown, data: object) => Promise.resolve({ id: 'grp-new', ...data })),
    updateWith: jest
      .fn()
      .mockImplementation((_tx: unknown, _id: string, data: object) => Promise.resolve({ ...EXISTING, ...data })),
    detachSuppliersWith: jest.fn().mockResolvedValue(2),
  };
  const transactions = { run: jest.fn((work: (ctx: unknown) => unknown) => work({ tx: {}, afterCommit: jest.fn() })) };
  const audit = { record: jest.fn() };
  return {
    service: new SupplierGroupService(repository as never, transactions as never, audit as never),
    audit,
  };
}

function entriesOf(audit: { record: jest.Mock }): Record<string, unknown>[] {
  expect(audit.record).toHaveBeenCalledTimes(1);
  return (audit.record.mock.calls[0] as [unknown, unknown, Record<string, unknown>[]])[2];
}

describe('SupplierGroupService — nhật ký', () => {
  it('tạo ghi SUPPLIER_GROUP.CREATED, nhãn = tên, branchIds []', async () => {
    const { service, audit } = makeService();

    await service.create({ name: 'Nhóm B' }, ADMIN);

    const [, actor] = audit.record.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(actor).toMatchObject({ userId: 'admin-1', type: 'USER', ip: '10.0.0.1', requestId: 'req-1' });
    expect(entriesOf(audit)).toEqual([
      {
        event: 'SUPPLIER_GROUP.CREATED',
        entityType: 'supplier_groups',
        entityId: 'grp-new',
        entityLabel: 'Nhóm B',
        branchIds: [],
        after: { name: 'Nhóm B', note: null },
      },
    ]);
  });

  it('sửa ghi SUPPLIER_GROUP.UPDATED, nhãn = tên mới', async () => {
    const { service, audit } = makeService();

    await service.update('grp-1', { name: 'Nhóm C' }, ADMIN);

    expect(entriesOf(audit)).toEqual([
      {
        event: 'SUPPLIER_GROUP.UPDATED',
        entityType: 'supplier_groups',
        entityId: 'grp-1',
        entityLabel: 'Nhóm C',
        branchIds: [],
        before: { name: 'Nhóm A' },
        after: { name: 'Nhóm C' },
      },
    ]);
  });

  it('sửa không đổi gì thì không ghi', async () => {
    const { service, audit } = makeService();
    await service.update('grp-1', { name: 'Nhóm A' }, ADMIN);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('xoá ghi SUPPLIER_GROUP.DELETED kèm số NCC bị gỡ nhóm', async () => {
    const { service, audit } = makeService();

    await service.remove('grp-1', ADMIN);

    expect(entriesOf(audit)).toEqual([
      {
        event: 'SUPPLIER_GROUP.DELETED',
        entityType: 'supplier_groups',
        entityId: 'grp-1',
        entityLabel: 'Nhóm A',
        branchIds: [],
        before: { name: 'Nhóm A', note: null, detachedSuppliers: 2 },
      },
    ]);
  });
});
