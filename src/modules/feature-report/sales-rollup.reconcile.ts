import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { addDaysToDateOnly, todayInVietnam } from 'src/common/utils/date-only.util';
import { ReconcileService } from './reconcile.service';

export const RECONCILE_CRON_NAME = 'sales-rollup-reconcile';
const DEFAULT_CRON = '15 0 * * *';

/**
 * Hằng đêm dựng lại tổng hợp doanh thu của hôm qua và hôm nay (giờ VN) từ dữ liệu gốc, sửa mọi sai lệch tích luỹ.
 * Mặc định 00:15 (`REPORT_RECONCILE_CRON`): đã sang ngày mới nên "hôm qua" đã chốt, còn "hôm nay" gần như trống.
 * `REPORT_RECONCILE_ENABLED=false` → không đăng ký. Việc chạy, ghi nhật ký và báo lệch do `ReconcileService` làm.
 */
@Injectable()
export class SalesRollupReconcileJob implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SalesRollupReconcileJob.name);

  constructor(
    private readonly reconcile: ReconcileService,
    private readonly registry: SchedulerRegistry,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.get<string>('REPORT_RECONCILE_ENABLED') === 'false') {
      this.logger.log('Đối soát doanh thu hằng đêm đang TẮT (REPORT_RECONCILE_ENABLED=false)');
      return;
    }
    const expression = this.config.get<string>('REPORT_RECONCILE_CRON') ?? DEFAULT_CRON;
    const job = CronJob.from({
      cronTime: expression,
      onTick: () => void this.run(),
      start: true,
      timeZone: 'Asia/Ho_Chi_Minh',
    });
    this.registry.addCronJob(RECONCILE_CRON_NAME, job);
    this.logger.log(`Đã đăng ký đối soát doanh thu hằng đêm: "${expression}" (giờ Asia/Ho_Chi_Minh)`);
  }

  onModuleDestroy(): void {
    if (this.registry.doesExist?.('cron', RECONCILE_CRON_NAME)) this.registry.deleteCronJob(RECONCILE_CRON_NAME);
  }

  async run(now: Date = new Date()): Promise<void> {
    const to = todayInVietnam(now);
    const from = addDaysToDateOnly(to, -1);
    try {
      await this.reconcile.run('CRON', null, from, to);
    } catch (error) {
      // Cron không được làm sập app: "đang chạy" hoặc lỗi bất ngờ chỉ log; lần sau (hoặc nút chạy tay) sẽ sửa.
      this.logger.warn(`Đối soát doanh thu ${from} → ${to} không chạy: ${(error as Error).message}`);
    }
  }
}
