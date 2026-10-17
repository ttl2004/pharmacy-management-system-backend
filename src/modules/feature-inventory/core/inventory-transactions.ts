import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';
import { INVENTORY_TX_MAX_WAIT_MS, INVENTORY_TX_TIMEOUT_MS } from './inventory.constants';

/** Việc chạy sau khi transaction commit thành công (phát sự kiện, xoá cache…). */
export type AfterCommitHook = () => void | Promise<void>;

/** Ngữ cảnh một transaction kho: client transaction + chỗ đăng ký việc sau commit. */
export interface InventoryTxContext {
  tx: Prisma.TransactionClient;
  afterCommit(hook: AfterCommitHook): void;
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
    const hooks: AfterCommitHook[] = [];

    const result = await this.prisma.$transaction((tx) => work({ tx, afterCommit: (hook) => hooks.push(hook) }), {
      timeout: INVENTORY_TX_TIMEOUT_MS,
      maxWait: INVENTORY_TX_MAX_WAIT_MS,
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    });

    for (const hook of hooks) {
      try {
        await hook();
      } catch (error) {
        this.logger.error('Việc sau commit của transaction kho bị lỗi', error as Error);
      }
    }

    return result;
  }
}
