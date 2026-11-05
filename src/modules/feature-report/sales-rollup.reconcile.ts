import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from 'src/common/databases/prisma.service';
import { addDaysToDateOnly, todayInVietnam } from 'src/common/utils/date-only.util';
import { SalesRollupRepository } from './sales-rollup.repository';

/** `rebuild` chờ khoá ngày của đơn đang thu dở; chừa thời gian rộng cho transaction. */
const RECONCILE_TX_TIMEOUT_MS = 5 * 60_000;

/**
 * Hằng đêm dựng lại tổng hợp doanh thu của hôm qua và hôm nay (giờ VN) từ dữ liệu gốc, sửa mọi sai lệch tích luỹ.
 * Chạy 00:15: đã sang ngày mới nên "hôm qua" đã chốt, còn "hôm nay" gần như trống. An toàn khi đang có đơn thu:
 * `rebuild` khoá độc quyền từng ngày, đơn đang thu dở giữ khoá chia sẻ nên được chờ rồi mới đọc.
 */
@Injectable()
export class SalesRollupReconcileJob {
  private readonly logger = new Logger(SalesRollupReconcileJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rollup: SalesRollupRepository,
  ) {}

  @Cron('15 0 * * *', { timeZone: 'Asia/Ho_Chi_Minh' })
  async run(now: Date = new Date()): Promise<void> {
    const to = todayInVietnam(now);
    const from = addDaysToDateOnly(to, -1);
    try {
      const result = await this.prisma.$transaction((tx) => this.rollup.rebuild(tx, from, to), {
        timeout: RECONCILE_TX_TIMEOUT_MS,
        maxWait: 30_000,
      });
      this.logger.log(`Đối soát doanh thu ${from} → ${to}: ${result.days} ngày, ${result.rows} dòng`);
    } catch (error) {
      // Chỉ log: lần chạy sau (hoặc `npm run report:rebuild`) sẽ sửa; không được làm sập app.
      this.logger.error(`Đối soát doanh thu ${from} → ${to} lỗi`, error as Error);
    }
  }
}
