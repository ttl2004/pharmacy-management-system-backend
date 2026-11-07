import { Injectable, Logger } from '@nestjs/common';
import { Prisma, SalesReconcileRun } from '@prisma/client';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { PrismaService } from 'src/common/databases/prisma.service';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';
import { parseDateOnly } from 'src/common/utils/date-only.util';
import { auditActorOf, jobActor } from 'src/providers/audit-log/audit-actor';
import { AuditLogService } from 'src/providers/audit-log/audit-log.service';
import type { AuditJson } from 'src/providers/audit-log/audit-log.types';
import { SalesRollupRepository } from './sales-rollup.repository';

export type ReconcileTrigger = 'CRON' | 'MANUAL';

/** `rebuild` chờ khoá ngày của đơn đang thu dở; chừa thời gian rộng cho transaction. */
const RECONCILE_TX_TIMEOUT_MS = 5 * 60_000;
/** Dòng RUNNING cũ hơn mức này coi như tiến trình đã chết giữa chừng. */
const STALE_RUNNING_MS = 60 * 60_000;
const BUSY_MESSAGE = 'Đối soát đang chạy';

/**
 * Một lần đối soát: ghi nhật ký (`sales_reconcile_runs`), chạy `rebuild` (có so sánh trước khi ghi đè), báo lệch qua audit.
 * Dùng chung cho cron và nút chạy tay.
 *
 * Chống chạy chồng: transaction ngắn đầu tiên lấy `pg_try_advisory_xact_lock('sales-reconcile')`, kiểm tra chưa có dòng
 * RUNNING còn mới rồi mới chèn dòng RUNNING và commit. Khoá chỉ cần giữ tới lúc dòng RUNNING hiện ra (mọi lần chạy khác
 * nhìn thấy dòng đó, kể cả từ instance khác); suốt thời gian chạy chính dòng RUNNING là "khoá". Tiến trình chết giữa chừng
 * → dòng RUNNING bị coi là hỏng sau 1 giờ, lần chạy sau dọn và chạy tiếp.
 */
@Injectable()
export class ReconcileService {
  private readonly logger = new Logger(ReconcileService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rollup: SalesRollupRepository,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * Chạy đồng bộ. Ném `HTTP_BAD_REQUEST` "Đối soát đang chạy" nếu có lần khác đang chạy; lỗi lúc dựng lại KHÔNG ném —
   * lần chạy được ghi FAILED và trả về.
   */
  async run(
    trigger: ReconcileTrigger,
    actor: RequestActor | null,
    fromDate: string,
    toDate: string,
  ): Promise<SalesReconcileRun> {
    const auditActor = actor ? auditActorOf(actor) : jobActor();
    const started = await this.start(trigger, actor, auditActor, fromDate, toDate);

    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const result = await this.rollup.rebuild(tx, fromDate, toDate);
          const run = await tx.salesReconcileRun.update({
            where: { id: started.id },
            data: {
              status: 'SUCCESS',
              finishedAt: new Date(),
              mismatchCount: result.mismatchCount,
              mismatches: result.mismatches as unknown as Prisma.InputJsonValue,
            },
          });
          if (result.mismatchCount > 0) {
            await this.audit.record(tx, auditActor, [
              {
                event: 'REPORT.RECONCILE_MISMATCH',
                entityType: 'sales_reconcile_runs',
                entityId: run.id,
                entityLabel: `Đối soát ${fromDate} → ${toDate}`,
                branchIds: result.branchIds,
                metadata: {
                  fromDate,
                  toDate,
                  trigger,
                  mismatchCount: result.mismatchCount,
                  tables: [...new Set(result.mismatches.map((m) => m.table))],
                } satisfies AuditJson,
              },
            ]);
            this.logger.warn(
              `Đối soát doanh thu ${fromDate} → ${toDate}: ${result.mismatchCount} dòng lệch (đã sửa) — xem lần chạy ${run.id}`,
            );
          } else {
            this.logger.log(
              `Đối soát doanh thu ${fromDate} → ${toDate}: ${result.days} ngày, ${result.rows} dòng, không lệch`,
            );
          }
          return run;
        },
        { timeout: RECONCILE_TX_TIMEOUT_MS, maxWait: 30_000 },
      );
    } catch (error) {
      // Transaction đã rollback (số liệu cũ giữ nguyên); ghi FAILED để người xem nhật ký biết. Lần sau (hoặc
      // `npm run report:rebuild`) sẽ sửa.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Đối soát doanh thu ${fromDate} → ${toDate} lỗi: ${message}`,
        error instanceof Error ? error.stack : undefined,
      );
      return this.prisma.salesReconcileRun.update({
        where: { id: started.id },
        data: { status: 'FAILED', finishedAt: new Date(), errorMessage: message.slice(0, 2000) },
      });
    }
  }

  /** Transaction ngắn: khoá toàn cục → dọn RUNNING hỏng → kiểm tra không ai đang chạy → chèn dòng RUNNING. */
  private async start(
    trigger: ReconcileTrigger,
    actor: RequestActor | null,
    auditActor: ReturnType<typeof auditActorOf>,
    fromDate: string,
    toDate: string,
  ): Promise<SalesReconcileRun> {
    return this.prisma.$transaction(async (tx) => {
      const [lock] = await tx.$queryRaw<{ locked: boolean }[]>(
        Prisma.sql`SELECT pg_try_advisory_xact_lock(hashtextextended('sales-reconcile', 0)) AS "locked"`,
      );
      if (!lock?.locked) throw new ErrorException({ code: ErrorCode.HTTP_BAD_REQUEST, message: BUSY_MESSAGE });

      const staleBefore = new Date(Date.now() - STALE_RUNNING_MS);
      await tx.salesReconcileRun.updateMany({
        where: { status: 'RUNNING', startedAt: { lt: staleBefore } },
        data: { status: 'FAILED', finishedAt: new Date(), errorMessage: 'Lần chạy bị ngắt giữa chừng' },
      });
      const running = await tx.salesReconcileRun.findFirst({ where: { status: 'RUNNING' }, select: { id: true } });
      if (running) throw new ErrorException({ code: ErrorCode.HTTP_BAD_REQUEST, message: BUSY_MESSAGE });

      const run = await tx.salesReconcileRun.create({
        data: {
          trigger,
          actorId: actor?.user.userId ?? null,
          fromDate: parseDateOnly(fromDate),
          toDate: parseDateOnly(toDate),
          status: 'RUNNING',
        },
      });
      if (trigger === 'MANUAL') {
        await this.audit.record(tx, auditActor, [
          {
            event: 'REPORT.RECONCILE_TRIGGERED',
            entityType: 'sales_reconcile_runs',
            entityId: run.id,
            entityLabel: `Đối soát ${fromDate} → ${toDate}`,
            branchIds: [],
            metadata: { fromDate, toDate } satisfies AuditJson,
          },
        ]);
      }
      return run;
    });
  }
}
