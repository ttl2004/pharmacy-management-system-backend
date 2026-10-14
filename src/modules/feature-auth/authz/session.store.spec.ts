import { DbSessionStore, SessionTransactions } from './session.store';

const FUTURE = new Date(Date.now() + 3_600_000);

function makeStore(findFirst: jest.Mock) {
  const prisma = {
    refreshToken: { findFirst, updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    $transaction: jest.fn((work: (tx: unknown) => unknown) => work(prisma)),
  };
  const transactions = new SessionTransactions(prisma as never);
  return { store: new DbSessionStore(prisma as never, transactions), transactions };
}

describe('DbSessionStore.isActive', () => {
  it('không xếp hàng sau một transaction ghi đang chạy', async () => {
    const findFirst = jest.fn().mockResolvedValue({ expiresAt: FUTURE });
    const { store, transactions } = makeStore(findFirst);

    let release!: () => void;
    const pendingWrite = transactions.write(() => new Promise<void>((resolve) => (release = resolve)));

    await expect(store.isActive('sid-1')).resolves.toBe(true);
    release();
    await pendingWrite;
  });

  it('cache kết quả đọc khi không có lần ghi nào xen vào', async () => {
    const findFirst = jest.fn().mockResolvedValue({ expiresAt: FUTURE });
    const { store } = makeStore(findFirst);

    await store.isActive('sid-1');
    await store.isActive('sid-1');

    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it('không cache khi có lần ghi commit trong lúc đang đọc — có thể chính là lần thu hồi phiên', async () => {
    const { store, transactions } = makeStore(jest.fn());
    const findFirst = jest.fn().mockImplementation(() => {
      transactions.revision++;
      return Promise.resolve({ expiresAt: FUTURE });
    });
    (store as unknown as { prisma: { refreshToken: { findFirst: jest.Mock } } }).prisma.refreshToken.findFirst =
      findFirst;

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
});
