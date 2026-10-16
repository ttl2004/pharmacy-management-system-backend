import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OrderService } from './order.service';

/** Mỗi phút huỷ đơn tại quầy bỏ dở (luật S8). Chạy nhiều instance vẫn an toàn: huỷ là cập nhật có điều kiện. */
@Injectable()
export class OrderExpiryJob {
  private readonly logger = new Logger(OrderExpiryJob.name);

  constructor(private readonly orders: OrderService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async run(): Promise<void> {
    try {
      const cancelled = await this.orders.expireAbandonedPos();
      if (cancelled) this.logger.log(`Tự huỷ ${cancelled} đơn tại quầy bỏ dở`);
    } catch (error) {
      this.logger.error('Job tự huỷ đơn tại quầy lỗi', error as Error);
    }
  }
}
