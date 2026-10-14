import { Injectable } from '@nestjs/common';
import { AuditAction, BatchStatus, Prisma } from '@prisma/client';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';
import { resolveBranchScope } from 'src/modules/feature-auth/permission/branch-scope';
import { AuditLogService } from 'src/providers/audit-log/audit-log.service';
import { InventoryEvents } from '../core/inventory-events';
import { branchWhere } from '../core/inventory-scope';
import { InventoryTransactions, InventoryTxContext } from '../core/inventory-transactions';
import { AUDIT_ENTITY } from '../core/inventory.constants';
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
    private readonly events: InventoryEvents,
    private readonly audit: AuditLogService,
  ) {}

  async setStatus(id: string, dto: UpdateBatchStatusRequest, actor: RequestActor) {
    // Khoá/thu hồi bắt buộc lý do (DB cũng có CHECK); mở khoá thì xoá lý do cũ — lịch sử nằm ở nhật ký.
    const isBlocking = dto.status !== BatchStatus.AVAILABLE;
    if (isBlocking && !dto.reason) {
      throw new ErrorException({ code: ErrorCode.HTTP_BAD_REQUEST, message: 'Khoá hoặc thu hồi lô phải có lý do' });
    }
    const blockedReason = isBlocking ? (dto.reason ?? null) : null;
    const actorId = actor.user.userId;
    const now = new Date();

    return this.transactions.run(async (ctx) => {
      const { tx } = ctx;
      const batch = await tx.stockBatch.findFirst({
        where: { id, isDeleted: false, ...branchWhere(resolveBranchScope(actor.user)) },
        select: BATCH_STATUS_SELECT,
      });
      if (!batch) throw new ErrorException({ code: ErrorCode.RECORD_NOT_FOUND, message: 'Lô hàng không tồn tại' });
      // Đã ở đúng trạng thái: không ghi gì, không phát sự kiện (bấm lại không sinh nhật ký rác).
      if (batch.status === dto.status) return batch;

      const updated = await tx.stockBatch.update({
        where: { id },
        data: {
          status: dto.status,
          blockedReason,
          blockedAt: isBlocking ? now : null,
          blockedBy: isBlocking ? actorId : null,
          updatedAt: now,
          updatedBy: actorId,
        },
        select: BATCH_STATUS_SELECT,
      });
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
      return updated;
    });
  }

  /**
   * Thu hồi theo SỐ LÔ: mọi lô cùng (sản phẩm, số lô) trong phạm vi của người gọi — ADMIN khoá cả chuỗi trong một
   * lần, PM chỉ khoá được ở chi nhánh mình. Không lô nào khớp → 1600.
   */
  async recall(dto: RecallBatchRequest, actor: RequestActor) {
    const actorId = actor.user.userId;
    const now = new Date();

    return this.transactions.run(async (ctx) => {
      const { tx } = ctx;
      const matched = await tx.stockBatch.findMany({
        where: {
          productId: dto.productId,
          batchNumber: dto.batchNumber,
          isDeleted: false,
          ...branchWhere(resolveBranchScope(actor.user)),
        },
        select: { id: true, branchId: true, status: true },
        orderBy: { id: 'asc' },
      });
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
