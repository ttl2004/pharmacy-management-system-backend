import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthRole } from 'src/common/types/common.enum';
import { BranchProductService } from './branch-product.service';

const ADMIN: RequestActor = {
  user: { userId: 'admin-1', sid: 's', email: null, role: AuthRole.ADMIN, branchId: null, roleLevel: 80 },
  ip: '10.0.0.1',
  userAgent: null,
  requestId: 'req-1',
};

const ROW = {
  id: 'bp-1',
  branchId: 'branch-1',
  productId: 'prod-1',
  minStockLevel: 20,
  product: { id: 'prod-1', code: 'SP0001', name: 'Paracetamol', minStockLevel: 5 },
};

function makeService(existing: Record<string, unknown> | null) {
  const tx = {
    branch: { findFirst: jest.fn().mockResolvedValue({ id: 'branch-1' }) },
    product: { findFirst: jest.fn().mockResolvedValue({ id: 'prod-1' }) },
    branchProduct: {
      findUnique: jest.fn().mockResolvedValue(existing),
      findFirst: jest.fn().mockResolvedValue(existing),
      upsert: jest.fn().mockResolvedValue({ id: 'bp-1' }),
      findUniqueOrThrow: jest.fn().mockResolvedValue(ROW),
      update: jest.fn().mockResolvedValue(undefined),
    },
  };
  const transactions = { run: jest.fn((work: (ctx: unknown) => unknown) => work({ tx, afterCommit: jest.fn() })) };
  const audit = { record: jest.fn() };
  return { service: new BranchProductService({} as never, transactions as never, audit as never), audit, tx };
}

function entriesOf(audit: { record: jest.Mock }): Record<string, unknown>[] {
  expect(audit.record).toHaveBeenCalledTimes(1);
  return (audit.record.mock.calls[0] as [unknown, unknown, Record<string, unknown>[]])[2];
}

describe('BranchProductService — nhật ký', () => {
  it('đặt ngưỡng lần đầu ghi BRANCH_PRODUCT.UPSERTED, branchIds [chi nhánh], nhãn = mã sản phẩm', async () => {
    const { service, audit } = makeService(null);

    await service.upsert({ branchId: 'branch-1', productId: 'prod-1', minStockLevel: 20 }, ADMIN);

    const [, actor] = audit.record.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(actor).toMatchObject({ userId: 'admin-1', ip: '10.0.0.1', requestId: 'req-1' });
    expect(entriesOf(audit)).toEqual([
      {
        event: 'BRANCH_PRODUCT.UPSERTED',
        entityType: 'branch_products',
        entityId: 'bp-1',
        entityLabel: 'SP0001',
        branchIds: ['branch-1'],
        before: null,
        after: { minStockLevel: 20, productId: 'prod-1' },
        searchTerms: ['SP0001', 'Paracetamol'],
      },
    ]);
  });

  it('sửa ngưỡng đã có cũng ghi BRANCH_PRODUCT.UPSERTED với before', async () => {
    const { service, audit } = makeService({ id: 'bp-1', minStockLevel: 10, isDeleted: false });

    await service.upsert({ branchId: 'branch-1', productId: 'prod-1', minStockLevel: 20 }, ADMIN);

    expect(entriesOf(audit)[0]).toMatchObject({
      event: 'BRANCH_PRODUCT.UPSERTED',
      branchIds: ['branch-1'],
      before: { minStockLevel: 10 },
      after: { minStockLevel: 20, productId: 'prod-1' },
    });
  });

  it('ngưỡng không đổi thì không ghi', async () => {
    const { service, audit } = makeService({ id: 'bp-1', minStockLevel: 20, isDeleted: false });
    await service.upsert({ branchId: 'branch-1', productId: 'prod-1', minStockLevel: 20 }, ADMIN);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('bỏ ngưỡng riêng ghi BRANCH_PRODUCT.DELETED, nhãn = mã sản phẩm', async () => {
    const { service, audit } = makeService({
      id: 'bp-1',
      minStockLevel: 20,
      isDeleted: false,
      product: { code: 'SP0001', name: 'Paracetamol' },
    });

    await service.remove('prod-1', 'branch-1', ADMIN);

    expect(entriesOf(audit)).toEqual([
      {
        event: 'BRANCH_PRODUCT.DELETED',
        entityType: 'branch_products',
        entityId: 'bp-1',
        entityLabel: 'SP0001',
        branchIds: ['branch-1'],
        before: { minStockLevel: 20, productId: 'prod-1' },
        searchTerms: ['SP0001', 'Paracetamol'],
      },
    ]);
  });
});
