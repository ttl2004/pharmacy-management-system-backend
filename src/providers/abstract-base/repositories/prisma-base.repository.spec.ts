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

describe('PrismaBaseRepository — tìm kiếm gộp vào câu phân trang (T2)', () => {
  type FindArgs = { where: unknown; take?: number; skip?: number };
  const argsOf = (fn: jest.Mock) => (fn.mock.calls as [FindArgs][])[0][0];

  function makeRepo() {
    const delegate = {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn().mockResolvedValue(null),
    };
    const queryRaw = jest.fn().mockResolvedValue([]);
    const repo = new CategoryRepo({ category: delegate, $queryRaw: queryRaw } as never);
    return { repo, delegate, queryRaw };
  }

  it('không kéo danh sách id về Node: điều kiện ILIKE nằm trong where của câu có LIMIT', async () => {
    const { repo, delegate, queryRaw } = makeRepo();

    await repo.findManyWithPagination({}, { search: 'a%_', searchFields: ['name', 'code'], limit: 20, page: 2 });

    expect(queryRaw).not.toHaveBeenCalled();
    const args = argsOf(delegate.findMany);
    expect(args.take).toBe(20);
    expect(args.skip).toBe(20);
    expect(args.where).toEqual({
      AND: [
        { isDeleted: false },
        {
          OR: [
            { name: { contains: 'a\\%\\_', mode: 'insensitive' } },
            { code: { contains: 'a\\%\\_', mode: 'insensitive' } },
          ],
        },
      ],
    });
    expect(argsOf(delegate.count).where).toEqual(args.where);
  });

  it('bỏ cột không phải chuỗi hoặc không tồn tại; không còn cột nào thì không lọc', async () => {
    const { repo, delegate } = makeRepo();

    await repo.findMany({}, { search: 'x', searchFields: ['createdAt', 'khong-co'] });

    expect(argsOf(delegate.findMany).where).toEqual({ isDeleted: false });
  });
});
