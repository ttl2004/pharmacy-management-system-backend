import { OrderStatus } from '@prisma/client';
import { OrderRepository } from './order.repository';

describe('OrderRepository.findDetail — cancelledByUser', () => {
  const updater = { id: 'u2', fullName: 'Quản lý B' };
  const row = (status: OrderStatus) => ({
    id: 'o1',
    status,
    updatedByUser: updater,
    payments: [{ id: 'p1', createdByUser: { id: 'u1', fullName: 'Nhân viên A' } }],
  });
  const repoWith = (found: unknown) => {
    const client = { order: { findFirst: jest.fn().mockResolvedValue(found) } };
    return { repo: new OrderRepository({} as never), client };
  };

  it('CANCELLED → cancelledByUser = người ghi cuối (updatedByUser), không lộ updatedByUser', async () => {
    const { repo, client } = repoWith(row(OrderStatus.CANCELLED));
    const detail = await repo.findDetail('o1', {}, client as never);
    expect(detail).toMatchObject({ cancelledByUser: updater });
    expect(detail).not.toHaveProperty('updatedByUser');
    expect(detail?.payments[0].createdByUser).toEqual({ id: 'u1', fullName: 'Nhân viên A' });
  });

  it.each([OrderStatus.PENDING, OrderStatus.COMPLETED])('%s → cancelledByUser = null', async (status) => {
    const { repo, client } = repoWith(row(status));
    expect((await repo.findDetail('o1', {}, client as never))?.cancelledByUser).toBeNull();
  });

  it('không có đơn → null', async () => {
    const { repo, client } = repoWith(null);
    expect(await repo.findDetail('o1', {}, client as never)).toBeNull();
  });

  it('findAbandonedPos lọc theo createdAt, không theo updatedAt', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const repo = new OrderRepository({ order: { findMany } } as never);
    const cutoff = new Date();
    await repo.findAbandonedPos(cutoff, 10);
    const arg = (findMany.mock.calls[0] as [{ where: object; orderBy: object }])[0];
    expect(arg.where).toMatchObject({ isDeleted: false, channel: 'POS', status: 'PENDING', createdAt: { lt: cutoff } });
    expect(JSON.stringify(arg)).not.toContain('updatedAt');
    expect(arg.orderBy).toEqual({ createdAt: 'asc' });
  });
});
