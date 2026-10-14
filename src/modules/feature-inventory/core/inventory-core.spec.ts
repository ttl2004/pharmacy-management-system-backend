import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { config } from 'rxjs';
import { ErrorCode } from 'src/common/types/error-code';
import { DocumentCodeService } from './document-code.service';
import { inventoryError } from './inventory.error';
import { InventoryEvents } from './inventory-events';
import { InventoryTransactions } from './inventory-transactions';
import { INVENTORY_TX_TIMEOUT_MS } from './inventory.constants';

describe('InventoryTransactions', () => {
  function makeTransactions(behaviour: 'commit' | 'rollback') {
    const $transaction = jest.fn((work: (tx: unknown) => Promise<unknown>) =>
      behaviour === 'commit' ? work({}) : work({}).then(() => Promise.reject(new Error('rollback'))),
    );
    return { transactions: new InventoryTransactions({ $transaction } as never), $transaction };
  }

  it('đặt timeout tường minh, không dùng mặc định 5 s', async () => {
    const { transactions, $transaction } = makeTransactions('commit');
    await transactions.run(() => Promise.resolve(1));
    expect($transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ timeout: INVENTORY_TX_TIMEOUT_MS }),
    );
  });

  it('hook sau commit chạy sau khi transaction xong', async () => {
    const { transactions } = makeTransactions('commit');
    const order: string[] = [];

    await transactions.run((ctx) => {
      ctx.afterCommit(() => {
        order.push('hook');
      });
      order.push('work');
      return Promise.resolve();
    });

    expect(order).toEqual(['work', 'hook']);
  });

  it('transaction rollback thì hook KHÔNG chạy', async () => {
    const { transactions } = makeTransactions('rollback');
    const hook = jest.fn();

    await expect(
      transactions.run((ctx) => {
        ctx.afterCommit(hook);
        return Promise.resolve();
      }),
    ).rejects.toThrow('rollback');
    expect(hook).not.toHaveBeenCalled();
  });

  it('hook lỗi không làm hỏng kết quả đã commit', async () => {
    const { transactions } = makeTransactions('commit');
    const result = await transactions.run((ctx) => {
      ctx.afterCommit(() => {
        throw new Error('redis chết');
      });
      return Promise.resolve('ok');
    });
    expect(result).toBe('ok');
  });
});

describe('DocumentCodeService', () => {
  it('ghép tiền tố và đệm 6 chữ số từ nextval của đúng sequence', async () => {
    const $queryRaw = jest.fn().mockResolvedValue([{ value: 42n }]);

    const code = await new DocumentCodeService().next({ $queryRaw } as never, 'STOCK_ADJUSTMENT');

    expect(code).toBe('DCK000042');
    const [sql] = $queryRaw.mock.calls[0] as [Prisma.Sql];
    expect(sql.sql).toContain('"stock_adjustment_code_seq"');
  });
});

describe('inventoryError', () => {
  it('giữ mã lỗi cố định, nối chi tiết vào thông báo', () => {
    const error = inventoryError(ErrorCode.INSUFFICIENT_STOCK, 'lô L01');
    expect(error.errorCode).toBe(ErrorCode.INSUFFICIENT_STOCK);
    expect(error.message).toBe('Tồn kho của lô không đủ: lô L01');
  });
});

describe('InventoryEvents', () => {
  const event = {
    branchId: 'b',
    productIds: [],
    refType: 'GOODS_RECEIPT' as const,
    refId: 'r',
    occurredAt: new Date(),
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  let previousHandler: typeof config.onUnhandledError;
  let unhandled: jest.Mock;
  let logError: jest.SpyInstance;

  beforeEach(() => {
    // RxJS đẩy lỗi của subscriber ra `setTimeout(() => { throw err })` — mặc định là uncaughtException, sập tiến trình.
    previousHandler = config.onUnhandledError;
    unhandled = jest.fn();
    config.onUnhandledError = unhandled;
    logError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    config.onUnhandledError = previousHandler;
    jest.restoreAllMocks();
  });

  it('handler ném lỗi: không thành lỗi chưa bắt, handler khác vẫn nhận sự kiện', async () => {
    const events = new InventoryEvents();
    const received: unknown[] = [];
    events.onStockChanged(() => {
      throw new Error('subscriber hỏng');
    });
    events.onStockChanged((e) => {
      received.push(e);
    });

    events.emitStockChanged(event);
    await flush();

    expect(unhandled).not.toHaveBeenCalled();
    expect(received).toEqual([event]);
    expect(logError).toHaveBeenCalledTimes(1);
  });

  it('handler bất đồng bộ bị reject (vd. Redis chết): được bắt và ghi log', async () => {
    const events = new InventoryEvents();
    events.onStockChanged(() => Promise.reject(new Error('redis chết')));

    events.emitStockChanged(event);
    await flush();

    expect(unhandled).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledTimes(1);
  });
});
