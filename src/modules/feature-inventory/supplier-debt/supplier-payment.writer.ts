import { Injectable } from '@nestjs/common';
import { PaymentMethod, Prisma, SupplierPaymentSource } from '@prisma/client';
import { ErrorCode } from 'src/common/types/error-code';
import type { AuditEntry } from 'src/providers/audit-log/audit-log.types';
import { DocumentCodeService } from '../core/document-code.service';
import { inventoryError } from '../core/inventory.error';
import { AUDIT_ENTITY } from '../core/inventory.constants';
import { PaidDelta, PaymentRow, SupplierPaymentRepository } from './repositories/supplier-payment.repository';

/** Ai làm — ghi vào `createdBy`/`cancelledBy` của mọi bản ghi mà writer động tới. */
export interface WriterActor {
  actorId: string;
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
 *
 * Writer KHÔNG tự ghi nhật ký: trả entry để caller gom vào lần `audit.record` duy nhất của transaction (xác nhận phiếu
 * nhập lập phiếu chi tự sinh rồi còn ghi dòng của chính phiếu nhập).
 */
@Injectable()
export class SupplierPaymentWriter {
  constructor(
    private readonly payments: SupplierPaymentRepository,
    private readonly codes: DocumentCodeService,
  ) {}

  /** Lập phiếu chi + phân bổ, cộng `paidAmount` các phiếu nhập (có điều kiện). Tổng tiền > còn nợ → 1714. */
  async create(
    tx: Prisma.TransactionClient,
    input: CreatePaymentInput,
    actor: WriterActor,
  ): Promise<{ id: string; code: string; amount: bigint; auditEntries: AuditEntry[] }> {
    const code = await this.codes.next(tx, 'SUPPLIER_PAYMENT');
    const { id, amount } = await this.payments.create(tx, { ...input, code, createdBy: actor.actorId });
    const receiptEntries = await this.applyDeltas(
      tx,
      input.allocations.map((row) => ({ receiptId: row.receiptId, delta: row.amount })),
      true,
      code,
    );
    const auditEntries: AuditEntry[] = [
      ...receiptEntries,
      {
        event: 'SUPPLIER_PAYMENT.CREATED',
        entityType: AUDIT_ENTITY.SUPPLIER_PAYMENT,
        entityId: id,
        entityLabel: code,
        branchIds: [input.branchId],
        amount,
        searchTerms: [code, ...receiptEntries.map((entry) => entry.entityLabel ?? '')].filter(Boolean),
        after: {
          code,
          supplierId: input.supplierId,
          source: input.source,
          method: input.method,
          amount: amount.toString(),
          allocations: input.allocations.map((row) => ({ receiptId: row.receiptId, amount: row.amount.toString() })),
        },
      },
    ];
    return { id, code, amount, auditEntries };
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

  /**
   * Huỷ phiếu chi: đánh dấu huỷ (có điều kiện) rồi hoàn lại `paidAmount` từng phiếu nhập. Đã huỷ → 1701.
   * Trả entry nhật ký (phiếu nhập được hoàn + chính phiếu chi) cho caller ghi.
   */
  async cancel(
    tx: Prisma.TransactionClient,
    payment: Pick<PaymentRow, 'id' | 'code' | 'branchId' | 'amount' | 'allocations'>,
    reason: string | null,
    actor: WriterActor,
  ): Promise<AuditEntry[]> {
    const changed = await this.payments.markCancelled(tx, payment.id, { cancelledBy: actor.actorId, reason });
    if (!changed) throw inventoryError(ErrorCode.INVALID_DOCUMENT_STATE, 'phiếu chi đã được huỷ trước đó');
    const receiptEntries = await this.applyDeltas(
      tx,
      payment.allocations.map((row) => ({ receiptId: row.receiptId, delta: -row.amount })),
      false,
      payment.code,
    );
    return [
      ...receiptEntries,
      {
        event: 'SUPPLIER_PAYMENT.CANCELLED',
        entityType: AUDIT_ENTITY.SUPPLIER_PAYMENT,
        entityId: payment.id,
        entityLabel: payment.code,
        branchIds: [payment.branchId],
        amount: payment.amount,
        searchTerms: [payment.code, ...payment.allocations.map((row) => row.receipt.code)],
        before: { status: 'COMPLETED' },
        after: { status: 'CANCELLED' },
        reason,
      },
    ];
  }

  /**
   * Gọi khi huỷ phiếu nhập đã xác nhận: còn phiếu chi LẬP TAY chưa huỷ → 1713 (liệt kê mã TTPN); phiếu chi RECEIPT
   * (tự sinh) được huỷ theo. Trả entry nhật ký của mọi phiếu chi bị huỷ theo.
   */
  async releaseForReceiptCancel(
    tx: Prisma.TransactionClient,
    receipt: { id: string; code: string },
    actor: WriterActor,
  ): Promise<AuditEntry[]> {
    const active = await this.payments.findActiveByReceipt(tx, receipt.id);
    const manual = active.filter((row) => row.source === SupplierPaymentSource.MANUAL);
    if (manual.length) {
      throw inventoryError(ErrorCode.RECEIPT_HAS_PAYMENTS, manual.map((row) => row.code).join(', '));
    }
    const entries: AuditEntry[] = [];
    for (const voucher of active) {
      const full = await this.payments.findById(voucher.id, tx);
      if (full) entries.push(...(await this.cancel(tx, full, `Huỷ theo phiếu nhập ${receipt.code}`, actor)));
    }
    return entries;
  }

  /**
   * Áp ± vào `paidAmount`; trả entry `GOODS_RECEIPT.PAYMENT_UPDATED` (amount = delta có dấu) cho từng phiếu nhập.
   * Thiếu dòng được sửa → điều kiện bị vi phạm.
   */
  private async applyDeltas(
    tx: Prisma.TransactionClient,
    deltas: readonly PaidDelta[],
    requireConfirmed: boolean,
    paymentCode: string,
  ): Promise<AuditEntry[]> {
    const updated = await this.payments.applyPaidDeltas(tx, deltas, requireConfirmed);
    if (updated.size !== deltas.length) {
      throw requireConfirmed
        ? inventoryError(ErrorCode.DEBT_EXCEEDED, 'phiếu nhập vừa được thanh toán hoặc thay đổi, hãy tải lại')
        : inventoryError(ErrorCode.INVALID_DOCUMENT_STATE, 'số đã trả của phiếu nhập đã thay đổi, hãy tải lại');
    }
    return deltas.map((delta): AuditEntry => {
      const after = updated.get(delta.receiptId)!;
      return {
        event: 'GOODS_RECEIPT.PAYMENT_UPDATED',
        entityType: AUDIT_ENTITY.GOODS_RECEIPT,
        entityId: delta.receiptId,
        entityLabel: after.code,
        branchIds: [after.branchId],
        amount: delta.delta,
        searchTerms: [after.code, paymentCode],
        before: { paidAmount: (after.paidAmount - delta.delta).toString() },
        after: { paidAmount: after.paidAmount.toString() },
      };
    });
  }
}
