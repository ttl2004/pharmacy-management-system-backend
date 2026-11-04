import type { Prisma, PrismaClient } from '@prisma/client';
import { BaseRecord } from './abstract-base.repository';
import { PrismaBaseRepository } from './prisma-base.repository';

type Row = BaseRecord & { name: string };

class CategoryRepo extends PrismaBaseRepository<Row> {
  constructor(prisma: PrismaClient) {
    super(prisma, 'Category');
  }
}

function makeDelegate() {
  return {
    create: jest.fn().mockImplementation(({ data }: { data: object }) => Promise.resolve({ id: 'id-1', ...data })),
    findFirst: jest.fn().mockResolvedValue({ id: 'id-1', name: 'cũ' }),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  };
}

describe('PrismaBaseRepository — nhận transaction client', () => {
  const where = { id: 'id-1' };

  it('truyền client thì dùng delegate của client, không đụng this.prisma', async () => {
    const own = makeDelegate();
    const inTx = makeDelegate();
    const repo = new CategoryRepo({ category: own } as never);
    const tx = { category: inTx } as unknown as Prisma.TransactionClient;

    await repo.create({ name: 'a' }, tx);
    await repo.update(where, { name: 'b' }, undefined, tx);
    await repo.softDelete(where, tx);

    expect(inTx.create).toHaveBeenCalledTimes(1);
    expect(inTx.findFirst).toHaveBeenCalled();
    expect(inTx.updateMany).toHaveBeenCalledTimes(2);
    expect(own.create).not.toHaveBeenCalled();
    expect(own.findFirst).not.toHaveBeenCalled();
    expect(own.updateMany).not.toHaveBeenCalled();
  });

  it('không truyền client thì hành vi như cũ (dùng this.prisma)', async () => {
    const own = makeDelegate();
    const repo = new CategoryRepo({ category: own } as never);

    await repo.create({ name: 'a' });
    await repo.update(where, { name: 'b' });
    await expect(repo.softDelete(where)).resolves.toBe(true);

    expect(own.create).toHaveBeenCalledTimes(1);
    expect(own.updateMany).toHaveBeenCalledTimes(2);
  });
});
