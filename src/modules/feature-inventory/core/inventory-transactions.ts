import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { INVENTORY_TX_MAX_WAIT_MS, INVENTORY_TX_TIMEOUT_MS } from './inventory.constants';

/** Việc chạy sau khi transaction commit thành công (phát sự kiện, xoá cache…). */
export type AfterCommitHook = () => void | Promise<void>;

/** Ngữ cảnh một transaction kho: client transaction + chỗ đăng ký việc sau commit. */
export interface InventoryTxContext {
  tx: Prisma.TransactionClient;
  afterCommit(hook: AfterCommitHook): void;
}

/** Số lần chạy lại tối đa (ngoài lần đầu) khi Postgres chọn transaction này làm nạn nhân deadlock/serialization. */
const MAX_DEADLOCK_RETRIES = 2;

/** Lỗi do Postgres huỷ transaction vì deadlock (40P01) hoặc xung đột tuần tự hoá (40001) — chạy lại là hết. */
export function isRetryableTxError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  // Lỗi nghiệp vụ (1700 "lô 40001"…) có thể chứa số trùng mã Postgres trong message — không bao giờ chạy lại.
  if (error instanceof ErrorException) return false;
  const e = error as { code?: unknown; message?: unknown; meta?: unknown };
  // Prisma: write conflict / deadlock ở transaction tương tác; hoặc lỗi pg thô mang `code`.
  if (e.code === 'P2034' || e.code === '40P01' || e.code === '40001') return true;
  // Chỉ soi chữ trong lỗi của Prisma (raw query P2010 để mã pg trong `meta` / message).
  const isPrisma =
    error instanceof Prisma.PrismaClientKnownRequestError || error instanceof Prisma.PrismaClientUnknownRequestError;
  if (!isPrisma) return false;
  let meta = '';
  if (e.meta !== undefined) {
    try {
      meta = JSON.stringify(e.meta);
    } catch {
      meta = '';
    }
  }
  const text = `${typeof e.message === 'string' ? e.message : ''} ${meta}`;
  return /\b40P01\b|\b40001\b|deadlock detected|could not serialize access/i.test(text);
}

/**
 * Transaction dành riêng cho kho: đúng đắn của kho dựa vào khoá dòng và câu lệnh có điều kiện ở DB, nên chạy song
 * song được và chạy đúng cả khi có nhiều instance.
 *
 * - `timeout` tường minh thay cho mặc định 5 s của Prisma.
 * - Không gọi I/O ngoài (HTTP, RabbitMQ, Redis) bên trong `work` — đăng ký qua `afterCommit`.
 * - Hook lỗi chỉ ghi log: dữ liệu đã commit, request vẫn thành công.
 */
@Injectable()
export class InventoryTransactions {
  private readonly logger = new Logger(InventoryTransactions.name);

  constructor(private readonly prisma: PrismaService) {}

  async run<T>(work: (ctx: InventoryTxContext) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      // Hook của lần chạy hỏng bị bỏ: mỗi lần thử có mảng hook riêng, chỉ lần thành công mới chạy hook.
      const hooks: AfterCommitHook[] = [];
      try {
        const result = await this.prisma.$transaction((tx) => work({ tx, afterCommit: (hook) => hooks.push(hook) }), {
          timeout: INVENTORY_TX_TIMEOUT_MS,
          maxWait: INVENTORY_TX_MAX_WAIT_MS,
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        });
        await this.runHooks(hooks);
        return result;
      } catch (error) {
        if (attempt >= MAX_DEADLOCK_RETRIES || !isRetryableTxError(error)) throw error;
        this.logger.warn(`Transaction kho bị deadlock/xung đột, chạy lại lần ${attempt + 1}/${MAX_DEADLOCK_RETRIES}`);
        await new Promise((resolve) => setTimeout(resolve, 20 + Math.random() * 60));
      }
    }
  }

  private async runHooks(hooks: readonly AfterCommitHook[]): Promise<void> {
    for (const hook of hooks) {
      try {
        await hook();
      } catch (error) {
        this.logger.error('Việc sau commit của transaction kho bị lỗi', error as Error);
      }
    }
  }
}
