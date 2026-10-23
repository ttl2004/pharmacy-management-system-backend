import { Injectable } from '@nestjs/common';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';
import { isInBranchScope, resolveBranchScope, scopedBranchFilter } from 'src/modules/feature-auth/permission/branch-scope';
import { LedgerQuery, OpenReceiptsQuery } from './dtos/supplier-debt.query';
import { SupplierDebtRepository } from './repositories/supplier-debt.repository';
import { buildLedger } from './supplier-debt-ledger.builder';

const supplierNotFound = () =>
  new ErrorException({ code: ErrorCode.RECORD_NOT_FOUND, message: 'Nhà cung cấp không tồn tại' });

/** Đọc công nợ NCC trong phạm vi chi nhánh của người gọi: sổ nợ, phiếu còn nợ, lịch sử thanh toán của phiếu nhập. */
@Injectable()
export class SupplierDebtLedgerService {
  constructor(private readonly debts: SupplierDebtRepository) {}

  /** Mới nhất trước. Lọc `kind` SAU khi cộng dồn nên `balanceAfter` từng dòng vẫn đúng như sổ đầy đủ. */
  async ledger(supplierId: string, query: LedgerQuery, actor: RequestActor) {
    const scope = resolveBranchScope(actor.user);
    if (!(await this.debts.supplierExists(supplierId))) throw supplierNotFound();
    const branchId = scope.kind === 'BRANCH' ? scope.branchId : undefined;

    const [receipts, payments, adjustments] = await Promise.all([
      this.debts.findLedgerReceipts(supplierId, branchId),
      this.debts.findLedgerPayments(supplierId),
      this.debts.findLedgerAdjustments(supplierId),
    ]);
    const rows = buildLedger({
      receipts,
      payments,
      adjustments,
      inScope: (id) => isInBranchScope(scope, id),
    }).filter((row) => !query.kind || row.kind === query.kind);

    const start = (query.page - 1) * query.limit;
    return {
      hits: rows.slice(start, start + query.limit),
      total: rows.length,
      page: query.page,
      totalPages: Math.ceil(rows.length / query.limit),
      limit: query.limit,
    };
  }

  /** Phiếu còn nợ (cũ trước) + `payCap` = mức trả tối đa thật + `debt` của chi nhánh đang xem. */
  async openReceipts(supplierId: string, query: OpenReceiptsQuery, actor: RequestActor) {
    const scope = resolveBranchScope(actor.user);
    if (!(await this.debts.supplierExists(supplierId))) throw supplierNotFound();
    // PM/nhân viên: luôn chi nhánh mình (chi nhánh khác → 1506). ADMIN: chi nhánh đã chọn, bỏ trống = toàn chuỗi.
    const branchId = scopedBranchFilter(scope, query.branchId);

    const [rows, debt] = await Promise.all([
      this.debts.findOpenReceipts(supplierId, branchId),
      this.debts.debtOf(supplierId, branchId),
    ]);
    const items = rows.map((r) => ({
      id: r.id,
      code: r.code,
      receivedAt: r.receivedAt ?? r.confirmedAt,
      branch: { id: r.branchId, name: r.branchName },
      totalAmount: Number(r.totalAmount),
      paidAmount: Number(r.paidAmount),
      remaining: Number(r.totalAmount - r.paidAmount),
    }));
    const remainingSum = items.reduce((sum, r) => sum + r.remaining, 0);
    const payCap = Math.max(0, Math.min(remainingSum, Number(debt.scoped), Number(debt.chain)));
    // `debt` = nợ của đúng chi nhánh đang xem (phiếu nhập + điều chỉnh của chi nhánh) — số dialog điều chỉnh dùng làm `expectedDebtBefore`.
    return { items, payCap, debt: Number(debt.scoped) };
  }

  /** Từng lần trả của một phiếu nhập (kể cả đã huỷ). Phiếu ngoài phạm vi = không tồn tại. */
  async receiptPayments(receiptId: string, actor: RequestActor) {
    const scope = resolveBranchScope(actor.user);
    const receipt = await this.debts.findReceiptInScope(receiptId, scope.kind === 'BRANCH' ? scope.branchId : undefined);
    if (!receipt) {
      throw new ErrorException({ code: ErrorCode.RECORD_NOT_FOUND, message: 'Phiếu nhập không tồn tại' });
    }
    const rows = await this.debts.findReceiptPayments(receiptId);
    return rows.map(({ amount, payment }) => ({
      id: payment.id,
      code: payment.code,
      paidAt: payment.paidAt,
      method: payment.method,
      source: payment.source,
      amount: Number(amount),
      status: payment.cancelledAt ? 'CANCELLED' : 'COMPLETED',
      createdByUser: payment.createdByUser,
    }));
  }
}
