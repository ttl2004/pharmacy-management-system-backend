import { Injectable } from '@nestjs/common';
import { AuditAction, PaymentMethod, Prisma, SupplierPaymentSource } from '@prisma/client';
import { ErrorCode } from 'src/common/types/error-code';
import { AuditLogService } from 'src/providers/audit-log/audit-log.service';
import { DocumentCodeService } from '../core/document-code.service';
import { inventoryError } from '../core/inventory.error';
import { AUDIT_ENTITY } from '../core/inventory.constants';
import { PaidDelta, PaymentRow, SupplierPaymentRepository } from './repositories/supplier-payment.repository';

/** Ai làm + từ đâu — ghi vào nhật ký của mọi bản ghi mà writer động tới. */
export interface WriterActor {
  actorId: string;
  ip?: string | null;
}

export interface CreatePaymentInput {
  supplierId: string;
  branchId: string;
  paidAt: Date;
  method: PaymentMethod;
  note: string | null;
  source: SupplierPaymentSource;
  allocations: readonly { receiptId: string; amount: bigint }[];
}

/**
 * Chỗ DUY NHẤT ghi phiếu chi + đổi `GoodsReceipt.paidAmount`. Mọi hàm nhận `tx` của người gọi để phiếu chi, phân bổ,
 * bộ đệm `paidAmount` và nhật ký cùng commit hoặc cùng rollback. Bất biến: phiếu CONFIRMED có
 * `paidAmount = Σ phân bổ của phiếu chi chưa huỷ`.
 */
@Injectable()
export class SupplierPaymentWriter {
  constructor(
    private readonly payments: SupplierPaymentRepository,
    private readonly codes: DocumentCodeService,
    private readonly audit: AuditLogService,
  ) {}

  /** Lập phiếu chi + phân bổ, cộng `paidAmount` các phiếu nhập (có điều kiện). Tổng tiền > còn nợ → 1714. */
  async create(
    tx: Prisma.TransactionClient,
    input: CreatePaymentInput,
    actor: WriterActor,
  ): Promise<{ id: string; code: string; amount: bigint }> {
    const code = await this.codes.next(tx, 'SUPPLIER_PAYMENT');
    const { id, amount } = await this.payments.create(tx, { ...input, code, createdBy: actor.actorId });
    await this.applyDeltas(
      tx,
      input.allocations.map((row) => ({ receiptId: row.receiptId, delta: row.amount })),
      true,
      actor,
    );
    await this.audit.record(tx, [
      {
        actorId: actor.actorId,
        action: AuditAction.CREATE,
        entityType: AUDIT_ENTITY.SUPPLIER_PAYMENT,
        entityId: id,
        branchId: input.branchId,
        after: {
          code,
          supplierId: input.supplierId,
          source: input.source,
          method: input.method,
          amount: amount.toString(),
          allocations: input.allocations.map((row) => ({ receiptId: row.receiptId, amount: row.amount.toString() })),
        },
        ipAddress: actor.ip,
      },
    ]);
    return { id, code, amount };
  }

  /** Phiếu chi tự sinh khi xác nhận phiếu nhập / tăng "đã trả": phân bổ trọn `amount` vào chính phiếu đó. */
  createForReceipt(
    tx: Prisma.TransactionClient,
    receipt: { id: string; code: string; supplierId: string; branchId: string },
    amount: bigint,
    options: { method: PaymentMethod; source: SupplierPaymentSource; note: string },
    actor: WriterActor,
  ) {
    return this.create(
      tx,
      {
        supplierId: receipt.supplierId,
        branchId: receipt.branchId,
        paidAt: new Date(),
        method: options.method,
        note: options.note,
        source: options.source,
        allocations: [{ receiptId: receipt.id, amount }],
      },
      actor,
    );
  }

  /** Huỷ phiếu chi: đánh dấu huỷ (có điều kiện) rồi hoàn lại `paidAmount` từng phiếu nhập. Đã huỷ → 1701. */
  async cancel(
    tx: Prisma.TransactionClient,
    payment: Pick<PaymentRow, 'id' | 'code' | 'branchId' | 'allocations'>,
    reason: string | null,
    actor: WriterActor,
  ): Promise<void> {
    const changed = await this.payments.markCancelled(tx, payment.id, { cancelledBy: actor.actorId, reason });
    if (!changed) throw inventoryError(ErrorCode.INVALID_DOCUMENT_STATE, 'phiếu chi đã được huỷ trước đó');
    await this.applyDeltas(
      tx,
      payment.allocations.map((row) => ({ receiptId: row.receiptId, delta: -row.amount })),
      false,
      actor,
    );
    await this.audit.record(tx, [
      {
        actorId: actor.actorId,
        action: AuditAction.STATUS_CHANGE,
        entityType: AUDIT_ENTITY.SUPPLIER_PAYMENT,
        entityId: payment.id,
        branchId: payment.branchId,
        before: { status: 'COMPLETED' },
        after: { status: 'CANCELLED' },
        reason: reason ?? undefined,
        ipAddress: actor.ip,
      },
    ]);
  }

  /**
   * Gọi khi huỷ phiếu nhập đã xác nhận: còn phiếu chi LẬP TAY chưa huỷ → 1713 (liệt kê mã TTPN); phiếu chi RECEIPT
   * (tự sinh) được huỷ theo.
   */
  async releaseForReceiptCancel(
    tx: Prisma.TransactionClient,
    receipt: { id: string; code: string },
    actor: WriterActor,
  ): Promise<void> {
    const active = await this.payments.findActiveByReceipt(tx, receipt.id);
    const manual = active.filter((row) => row.source === SupplierPaymentSource.MANUAL);
    if (manual.length) {
      throw inventoryError(ErrorCode.RECEIPT_HAS_PAYMENTS, manual.map((row) => row.code).join(', '));
    }
    for (const voucher of active) {
      const full = await this.payments.findById(voucher.id, tx);
      if (full) await this.cancel(tx, full, `Huỷ theo phiếu nhập ${receipt.code}`, actor);
    }
  }

  /** Áp ± vào `paidAmount` và ghi nhật ký `goods_receipts` UPDATE. Thiếu dòng được sửa → điều kiện bị vi phạm. */
  private async applyDeltas(
    tx: Prisma.TransactionClient,
    deltas: readonly PaidDelta[],
    requireConfirmed: boolean,
    actor: WriterActor,
  ): Promise<void> {
    const updated = await this.payments.applyPaidDeltas(tx, deltas, requireConfirmed);
    if (updated.size !== deltas.length) {
      throw requireConfirmed
        ? inventoryError(ErrorCode.DEBT_EXCEEDED, 'phiếu nhập vừa được thanh toán hoặc thay đổi, hãy tải lại')
        : inventoryError(ErrorCode.INVALID_DOCUMENT_STATE, 'số đã trả của phiếu nhập đã thay đổi, hãy tải lại');
    }
    await this.audit.record(
      tx,
      deltas.map((delta) => {
        const after = updated.get(delta.receiptId)!;
        return {
          actorId: actor.actorId,
          action: AuditAction.UPDATE,
          entityType: AUDIT_ENTITY.GOODS_RECEIPT,
          entityId: delta.receiptId,
          branchId: after.branchId,
          before: { paidAmount: (after.paidAmount - delta.delta).toString() },
          after: { paidAmount: after.paidAmount.toString() },
          ipAddress: actor.ip,
        };
      }),
    );
  }
}
