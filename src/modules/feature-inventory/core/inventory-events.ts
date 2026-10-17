import { Injectable, Logger } from '@nestjs/common';
import type { StockRefType } from '@prisma/client';
import { Subject, Subscription } from 'rxjs';

/**
 * Tồn kho của một chi nhánh vừa đổi — phát **sau khi commit**, không bao giờ phát cho transaction đã rollback.
 *
 * Đây là chỗ nối cho hạ tầng sau này, không module nào phải sửa lại luồng nghiệp vụ:
 * - Redis: subscriber xoá cache tồn/báo cáo theo `branchId` + `productIds`.
 * - RabbitMQ: subscriber đẩy sự kiện ra exchange cho dịch vụ AI / thông báo.
 * Hiện chưa có subscriber nào — phát vào khoảng không là đúng thiết kế.
 */
export interface StockChangedEvent {
  branchId: string;
  productIds: string[];
  /** `null` khi lượng bán được đổi mà không qua chứng từ (khoá/mở/thu hồi lô). */
  refType: StockRefType | null;
  refId: string | null;
  occurredAt: Date;
}

/** Handler có thể đồng bộ hoặc trả Promise (vd. gọi Redis/RabbitMQ). */
export type StockChangedHandler = (event: StockChangedEvent) => void | Promise<void>;

@Injectable()
export class InventoryEvents {
  private readonly logger = new Logger(InventoryEvents.name);
  private readonly stockChangedSubject = new Subject<StockChangedEvent>();

  /**
   * Đăng ký nghe sự kiện tồn kho. KHÔNG mở `Subject` ra ngoài: RxJS đẩy lỗi của subscriber ra
   * `setTimeout(() => { throw err })` — một subscriber ném lỗi (Redis chết) sẽ làm sập cả tiến trình ngay sau một
   * commit thành công. Mỗi handler ở đây được bọc riêng: lỗi đồng bộ lẫn Promise bị reject chỉ ghi log.
   */
  onStockChanged(handler: StockChangedHandler): Subscription {
    return this.stockChangedSubject.subscribe((event) => {
      try {
        void Promise.resolve(handler(event)).catch((error: unknown) => this.logFailure(event, error));
      } catch (error) {
        this.logFailure(event, error);
      }
    });
  }

  emitStockChanged(event: StockChangedEvent): void {
    this.stockChangedSubject.next(event);
  }

  private logFailure(event: StockChangedEvent, error: unknown): void {
    this.logger.error(
      `Subscriber stockChanged lỗi cho ${event.refType ?? 'BATCH_STATUS'} ${event.refId ?? ''}`,
      error instanceof Error ? error.stack : String(error),
    );
  }
}
