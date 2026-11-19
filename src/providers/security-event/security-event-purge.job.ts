import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { lockAdvisoryKeys } from 'src/common/databases/advisory-lock';
import { PrismaService } from 'src/common/databases/prisma.service';

const BATCH_SIZE = 5000;
const MAX_BATCHES = 200;

/**
 * Mỗi ngày dọn sự kiện đăng nhập cũ hơn 180 ngày khỏi `security_events`; loại khác giữ vĩnh viễn. Trigger của bảng
 * (migration don_nhat_ky_dang_nhap_cu) tự cho xoá đúng nhóm này nên job KHÔNG bật app.audit_maintenance. Mốc 180 ngày
 * tính bằng now() của DB, cùng đồng hồ với trigger. Mỗi lô là một transaction ngắn có khoá advisory để nhiều
 * instance không dọn chồng nhau.
 */
@Injectable()
export class SecurityEventPurgeJob {
  private readonly logger = new Logger(SecurityEventPurgeJob.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron('0 30 3 * * *')
  async purgeOldLoginEvents(): Promise<number> {
    let total = 0;
    try {
      for (let batch = 0; batch < MAX_BATCHES; batch++) {
        const deleted = await this.prisma.$transaction(async (tx) => {
          await lockAdvisoryKeys(tx, ['security-events-purge']);
          return tx.$executeRaw`
            DELETE FROM "security_events" WHERE "id" IN (
              SELECT "id" FROM "security_events"
              WHERE "type" IN ('AUTH.LOGIN_OK', 'AUTH.LOGIN_FAILED', 'AUTH.LOGIN_FAILED_BURST')
                AND "createdAt" < now() - interval '180 days'
              ORDER BY "createdAt" LIMIT ${BATCH_SIZE})`;
        });
        total += deleted;
        if (deleted < BATCH_SIZE) break;
      }
      if (total) this.logger.log(`Dọn ${total} sự kiện đăng nhập cũ hơn 180 ngày`);
    } catch (error) {
      this.logger.error(`Dọn sự kiện đăng nhập cũ lỗi (đã xoá ${total})`, error as Error);
    }
    return total;
  }
}
