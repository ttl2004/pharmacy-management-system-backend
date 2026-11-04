import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/common/databases/prisma.service';
import { lockAdvisoryKeys } from 'src/common/databases/advisory-lock';
import type { RequestContext } from 'src/common/decorators/request-context';
import { SecurityEventService } from 'src/providers/security-event/security-event.service';

/**
 * Phát hiện dò mật khẩu một tài khoản nhân viên (D4). KHÔNG khoá tài khoản — chỉ để lại dấu vết sev 2 cho ADMIN xem.
 *
 * Race-safe: khoá advisory `brute-force:<actorId>` ép các lần kiểm tra song song cho cùng một người chạy nối tiếp,
 * nên lần sau luôn thấy dòng `BRUTE_FORCE_SUSPECTED` của lần trước — tối đa một dòng mỗi cửa sổ, kể cả nhiều instance.
 */
@Injectable()
export class BruteForceDetector {
  static readonly THRESHOLD = 10;
  static readonly WINDOW_MS = 15 * 60_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly security: SecurityEventService,
  ) {}

  /** Gọi SAU khi đã ghi `LOGIN_FAILED`. Trả `true` nếu lần này đã ghi `BRUTE_FORCE_SUSPECTED`. */
  check(actorId: string, actorRoleCode: string | null, ctx: RequestContext, now: Date = new Date()): Promise<boolean> {
    const since = new Date(now.getTime() - BruteForceDetector.WINDOW_MS);
    return this.prisma.$transaction(async (tx) => {
      await lockAdvisoryKeys(tx, [`brute-force:${actorId}`]);
      const failed = await tx.securityEvent.count({
        where: { actorId, type: 'AUTH.LOGIN_FAILED', createdAt: { gte: since } },
      });
      if (failed < BruteForceDetector.THRESHOLD) return false;
      const already = await tx.securityEvent.count({
        where: { actorId, type: 'AUTH.BRUTE_FORCE_SUSPECTED', createdAt: { gte: since } },
      });
      if (already > 0) return false;
      await this.security.record(
        [
          {
            type: 'AUTH.BRUTE_FORCE_SUSPECTED',
            actorId,
            actorRoleCode,
            context: ctx,
            metadata: { count: failed, windowMinutes: BruteForceDetector.WINDOW_MS / 60_000 },
          },
        ],
        tx,
      );
      return true;
    });
  }
}
