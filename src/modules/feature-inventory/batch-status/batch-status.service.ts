import { Injectable } from '@nestjs/common';
import { AuditAction, BatchStatus, Prisma } from '@prisma/client';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';
import { resolveBranchScope } from 'src/modules/feature-auth/permission/branch-scope';
import { AuditLogService } from 'src/providers/audit-log/audit-log.service';
import { badRequest, inventoryError } from '../core/inventory.error';
import { InventoryEvents } from '../core/inventory-events';
import { branchWhere } from '../core/inventory-scope';
import { InventoryTransactions, InventoryTxContext } from '../core/inventory-transactions';
import { AUDIT_ENTITY } from '../core/inventory.constants';
import { StockBatchRepository } from '../core/stock-batch.repository';
import { RecallBatchRequest, UpdateBatchStatusRequest } from './dtos/batch-status.request';

const BATCH_STATUS_SELECT = {
  id: true,
  branchId: true,
  productId: true,
  batchNumber: true,
  status: true,
  blockedReason: true,
  blockedAt: true,
  blockedBy: true,
} satisfies Prisma.StockBatchSelect;

/**
 * Mức chặn của lô: thu hồi (quyết định pháp lý) nặng hơn cách ly. Thu hồi theo số lô chỉ NÂNG mức — cách ly hàng loạt
 * không được hạ một lô đã bị thu hồi xuống cách ly (mất dấu quyết định thu hồi trên lô).
 */
const BLOCKING_RANK: Record<BatchStatus, number> = {
  [BatchStatus.AVAILABLE]: 0,
  [BatchStatus.QUARANTINE]: 1,
  [BatchStatus.RECALLED]: 2,
};

/**
 * Khoá / mở khoá / thu hồi lô. Không đổi tồn — chỉ đổi lô có được xuất/bán hay không (FEFO bỏ qua lô khác AVAILABLE).
 * Hàng của lô bị thu hồi đi ra khỏi kho bằng phiếu điều chỉnh DISPOSE hoặc RETURN_TO_SUPPLIER.
 * Cột `blocked*` chỉ giữ lần gần nhất; lịch sử khoá/mở đầy đủ ở `audit_logs`.
 */
@Injectable()
export class BatchStatusService {
  constructor(
    private readonly transactions: InventoryTransactions,
    private readonly batches: StockBatchRepository,
    private readonly events: InventoryEvents,
    private readonly audit: AuditLogService,
  ) {}

  async setStatus(id: string, dto: UpdateBatchStatusRequest, actor: RequestActor) {
    // Khoá/thu hồi bắt buộc lý do (DB cũng có CHECK); mở khoá thì xoá lý do cũ — lịch sử nằm ở nhật ký.
    const isBlocking = dto.status !== BatchStatus.AVAILABLE;
    if (isBlocking && !dto.reason) throw badRequest('Khoá hoặc thu hồi lô phải có lý do');
    const scope = resolveBranchScope(actor.user);
    const actorId = actor.user.userId;
    const blocked = {
      blockedReason: isBlocking ? (dto.reason ?? null) : null,
      blockedAt: isBlocking ? new Date() : null,
      blockedBy: isBlocking ? actorId : null,
    };

    return this.transactions.run(async (ctx) => {
      const { tx } = ctx;
      const batch = await tx.stockBatch.findFirst({
        where: { id, isDeleted: false, ...branchWhere(scope) },
        select: BATCH_STATUS_SELECT,
      });
      if (!batch) throw new ErrorException({ code: ErrorCode.RECORD_NOT_FOUND, message: 'Lô hàng không tồn tại' });
      // Đã ở đúng trạng thái: không ghi gì, không phát sự kiện (bấm lại không sinh nhật ký rác).
      if (batch.status === dto.status) return batch;
      // Thu hồi là quyết định pháp lý của cả chuỗi: chỉ người có phạm vi toàn chuỗi (ADMIN) được gỡ hoặc hạ mức.
      if (batch.status === BatchStatus.RECALLED && scope.kind !== 'ALL') {
        throw inventoryError(ErrorCode.RECALL_ADMIN_ONLY);
      }
      // Thu hồi lẻ cũng giữ khoá số lô như thu hồi theo số lô: lô cùng số đang được tạo ở chi nhánh khác hoặc thấy
      // quyết định này (thừa hưởng), hoặc đã tạo xong trước nó — không có kết quả tuỳ thời điểm.
      if (dto.status === BatchStatus.RECALLED) await this.batches.lockBatchNumbers(tx, [batch]);

      // Chỉ ghi khi lô vẫn ở trạng thái vừa đọc: request khác (vd. thu hồi theo số lô) đổi xen giữa thì báo lại,
      // không ghi đè — ghi đè có thể hạ một lô vừa bị thu hồi xuống cách ly.
      const { count } = await tx.stockBatch.updateMany({
        where: { id, status: batch.status, isDeleted: false },
        data: { status: dto.status, ...blocked, updatedAt: new Date(), updatedBy: actorId },
      });
      if (!count) {
        throw new ErrorException({
          code: ErrorCode.HTTP_CONFLICT,
          message: 'Lô vừa được người khác đổi trạng thái, hãy tải lại rồi thử lại',
        });
      }
      await this.audit.record(tx, [
        {
          actorId,
          action: AuditAction.STATUS_CHANGE,
          entityType: AUDIT_ENTITY.STOCK_BATCH,
          entityId: id,
          branchId: batch.branchId,
          before: { status: batch.status },
          after: { status: dto.status },
          reason: dto.reason ?? null,
          ipAddress: actor.ip,
        },
      ]);
      this.emitAfterCommit(ctx, [batch.branchId], batch.productId);
      return { ...batch, status: dto.status, ...blocked };
    });
  }

  /**
   * Thu hồi theo SỐ LÔ: mọi lô cùng (sản phẩm, số lô) trong phạm vi của người gọi — ADMIN khoá cả chuỗi trong một
   * lần, PM chỉ khoá được ở chi nhánh mình. Không lô nào khớp → 1600.
   * Giữ khoá số lô (`lockBatchNumbers`) nên lô cùng số được tạo đồng thời hoặc nằm trong lần thu hồi này, hoặc thừa
   * hưởng nó khi tạo (`StockIntakeService`). Các lô khớp bị khoá dòng: đổi trạng thái lẻ chạy xen giữa không lọt.
   */
  async recall(dto: RecallBatchRequest, actor: RequestActor) {
    const scope = resolveBranchScope(actor.user);
    const actorId = actor.user.userId;
    const now = new Date();

    return this.transactions.run(async (ctx) => {
      const { tx } = ctx;
      const key = { productId: dto.productId, batchNumber: dto.batchNumber };
      await this.batches.lockBatchNumbers(tx, [key]);
      const matched = await this.batches.lockByBatchNumber(tx, key, scope.kind === 'ALL' ? undefined : scope.branchId);
      if (!matched.length) {
        throw new ErrorException({ code: ErrorCode.RECORD_NOT_FOUND, message: 'Không có lô nào khớp để thu hồi' });
      }
      // Chỉ nâng mức chặn. Lô đã ở mức này hoặc cao hơn thì giữ nguyên — bấm lại không lỗi, không ghi gì.
      const targets = matched.filter((batch) => BLOCKING_RANK[batch.status] < BLOCKING_RANK[dto.status]);
      if (!targets.length) return { affected: 0, batches: [] };

      await tx.stockBatch.updateMany({
        where: { id: { in: targets.map((target) => target.id) } },
        data: {
          status: dto.status,
          blockedReason: dto.reason,
          blockedAt: now,
          blockedBy: actorId,
          updatedAt: now,
          updatedBy: actorId,
        },
      });
      await this.audit.record(
        tx,
        targets.map((target) => ({
          actorId,
          action: AuditAction.STATUS_CHANGE,
          entityType: AUDIT_ENTITY.STOCK_BATCH,
          entityId: target.id,
          branchId: target.branchId,
          before: { status: target.status },
          after: { status: dto.status },
          reason: dto.reason,
          ipAddress: actor.ip,
        })),
      );
      this.emitAfterCommit(
        ctx,
        targets.map((target) => target.branchId),
        dto.productId,
      );
      return {
        affected: targets.length,
        batches: targets.map((target) => ({ id: target.id, branchId: target.branchId })),
      };
    });
  }

  /**
   * Lượng bán được của chi nhánh đổi (lô vào/ra khỏi FEFO) mà không qua chứng từ nào → báo sau commit cho
   * cache/thông báo, mỗi chi nhánh một sự kiện.
   */
  private emitAfterCommit(ctx: InventoryTxContext, branchIds: readonly string[], productId: string): void {
    ctx.afterCommit(() => {
      for (const branchId of new Set(branchIds)) {
        this.events.emitStockChanged({
          branchId,
          productIds: [productId],
          refType: null,
          refId: null,
          occurredAt: new Date(),
        });
      }
    });
  }
}
