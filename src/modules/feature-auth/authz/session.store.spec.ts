import { DbSessionStore, SessionTransactions } from './session.store';

const FUTURE = new Date(Date.now() + 3_600_000);

function makeStore(findFirst: jest.Mock) {
  const tx = { $executeRaw: jest.fn(), refreshToken: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };
  const prisma = {
    refreshToken: { findFirst, updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    $transaction: jest.fn((work: (client: unknown) => unknown) => work(tx)),
  };
  const transactions = new SessionTransactions(prisma as never);
  return { store: new DbSessionStore(prisma as never, transactions), transactions, prisma, tx };
}

describe('SessionTransactions.forUser', () => {
  it('khoá theo người dùng trước khi chạy việc, trong cùng transaction', async () => {
    const { transactions, tx } = makeStore(jest.fn());
    const work = jest.fn().mockResolvedValue('ok');

    await expect(transactions.forUser('u1', work)).resolves.toBe('ok');

    const [sql] = tx.$executeRaw.mock.calls[0] as [{ values: unknown[] }];
    expect(sql.values).toEqual([['session:u1']]);
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(work.mock.invocationCallOrder[0]);
  });

  it('tăng revision cả khi lỗi — không biết chắc transaction đã commit tới đâu', async () => {
    const { transactions } = makeStore(jest.fn());
    await expect(transactions.forUser('u1', () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(transactions.revision).toBe(1);
  });
});

describe('DbSessionStore.isActive', () => {
  it('không chờ transaction phiên đang chạy của người khác', async () => {
    const findFirst = jest.fn().mockResolvedValue({ expiresAt: FUTURE });
    const { store, transactions } = makeStore(findFirst);

    let release!: () => void;
    const pending = transactions.forUser('u2', () => new Promise<void>((resolve) => (release = resolve)));

    await expect(store.isActive('sid-1')).resolves.toBe(true);
    release();
    await pending;
  });

  it('cache kết quả đọc khi không có lần thu hồi nào xen vào', async () => {
    const findFirst = jest.fn().mockResolvedValue({ expiresAt: FUTURE });
    const { store } = makeStore(findFirst);

    await store.isActive('sid-1');
    await store.isActive('sid-1');

    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it('không cache khi có lần thu hồi commit trong lúc đang đọc — có thể chính là lần thu hồi phiên này', async () => {
    const findFirst = jest.fn();
    const { store, transactions } = makeStore(findFirst);
    findFirst.mockImplementation(() => {
      transactions.changed();
      return Promise.resolve({ expiresAt: FUTURE });
    });

    await expect(store.isActive('sid-1')).resolves.toBe(true);
    await store.isActive('sid-1');

    expect(findFirst).toHaveBeenCalledTimes(2);
  });

  it('thu hồi phiên xong thì lần kiểm sau đọc lại DB, không dùng cache cũ', async () => {
    const findFirst = jest.fn().mockResolvedValueOnce({ expiresAt: FUTURE }).mockResolvedValueOnce(null);
    const { store } = makeStore(findFirst);

    await expect(store.isActive('sid-1')).resolves.toBe(true);
    await store.revoke('sid-1');

    await expect(store.isActive('sid-1')).resolves.toBe(false);
  });

  it('đăng xuất mọi nơi (khoá theo người dùng) cũng bỏ cache của mọi phiên', async () => {
    const findFirst = jest.fn().mockResolvedValueOnce({ expiresAt: FUTURE }).mockResolvedValueOnce(null);
    const { store, tx } = makeStore(findFirst);

    await store.isActive('sid-1');
    await store.revokeAllByUser('u1');

    expect(tx.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'u1', revokedAt: null } }),
    );
    await expect(store.isActive('sid-1')).resolves.toBe(false);
  });
});
