import { PrismaService } from 'src/common/databases/prisma.service';
import { MONTHLY_BUILD_TX_OPTIONS, StockQueryRepository } from './stock-query.repository';

describe('StockQueryRepository.ensureMonthlyBuilt', () => {
  it('K2: dựng bảng tháng chạy trong transaction có timeout rộng, không dùng mặc định 5 s', async () => {
    const $queryRaw = jest.fn().mockResolvedValue([{ ok: false }]);
    const $transaction = jest.fn().mockResolvedValue(undefined);
    const repo = new StockQueryRepository({ $queryRaw, $transaction } as unknown as PrismaService);

    await (repo as unknown as { ensureMonthlyBuilt(b: object): Promise<void> }).ensureMonthlyBuilt({
      month: '2026-11-01',
      at: new Date('2026-10-31T17:00:00Z'),
      previousMonth: '2026-10-01',
    });

    expect($transaction).toHaveBeenCalledWith(expect.any(Function), MONTHLY_BUILD_TX_OPTIONS);
    expect(MONTHLY_BUILD_TX_OPTIONS.timeout).toBeGreaterThanOrEqual(60_000);
  });
});
