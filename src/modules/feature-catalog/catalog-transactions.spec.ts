import { CatalogTransactions, productWriteLocks } from './catalog-transactions';

describe('productWriteLocks', () => {
  it('khoá sản phẩm (khi có) và từng mã vạch được gửi, bỏ mã vạch trống', () => {
    expect(productWriteLocks('p1', ['A', null, undefined, '', 'B'])).toEqual(['product:p1', 'barcode:A', 'barcode:B']);
    expect(productWriteLocks(null, [])).toEqual([]);
  });
});

describe('CatalogTransactions.write', () => {
  it('lấy khoá trước khi chạy việc, timeout tường minh thay cho mặc định 5 s', async () => {
    const tx = { $executeRaw: jest.fn() };
    const $transaction = jest.fn((work: (client: unknown) => unknown) => work(tx));
    const work = jest.fn().mockResolvedValue('ok');

    await expect(new CatalogTransactions({ $transaction } as never).write(['product:p1'], work)).resolves.toBe('ok');

    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(work.mock.invocationCallOrder[0]);
    const [, options] = $transaction.mock.calls[0] as unknown as [unknown, { timeout: number }];
    expect(options.timeout).toBeGreaterThan(5000);
  });

  it('không có khoá nào (vd. sản phẩm không mã vạch) thì không gọi thêm câu lệnh', async () => {
    const tx = { $executeRaw: jest.fn() };
    const $transaction = jest.fn((work: (client: unknown) => unknown) => work(tx));
    await new CatalogTransactions({ $transaction } as never).write([], () => Promise.resolve());
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });
});
