import { Injectable } from '@nestjs/common';
import { AuditAction } from '@prisma/client';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';
import { assertBranchInScope, resolveBranchScope } from 'src/modules/feature-auth/permission/branch-scope';
import { AuditLogService } from 'src/providers/audit-log/audit-log.service';
import { DocumentCodeService } from '../core/document-code.service';
import { AUDIT_ENTITY } from '../core/inventory.constants';
import { badRequest, invalidReference, inventoryError } from '../core/inventory.error';
import { InventoryTransactions } from '../core/inventory-transactions';
import { resolveWriteBranch } from '../core/inventory-scope';
import { CreateSupplierDebtAdjustmentRequest } from './dtos/supplier-debt-adjustment.request';
import { CancelDebtDocumentRequest } from './dtos/supplier-payment.request';
import { assertBranchDebtNotNegative } from './supplier-debt-guards';
import { AdjustmentRow, SupplierDebtAdjustmentRepository } from './repositories/supplier-debt-adjustment.repository';
import { SupplierDebtRepository } from './repositories/supplier-debt.repository';

const FUTURE_TOLERANCE_MS = 60_000;

const notFound = () =>
  new ErrorException({ code: ErrorCode.RECORD_NOT_FOUND, message: 'Phiếu điều chỉnh nợ không tồn tại' });

function present(row: AdjustmentRow) {
  const { cancelledAt, debtBefore, debtAfter, delta, ...rest } = row;
  return {
    ...rest,
    debtBefore: Number(debtBefore),
    debtAfter: Number(debtAfter),
    delta: Number(delta),
    status: cancelledAt ? 'CANCELLED' : 'COMPLETED',
    cancelledAt,
  };
}

/**
 * Điều chỉnh công nợ NCC (Q6): ai có `supplier-debt:write` cũng lập/huỷ được; nhân viên chi nhánh bị ép về chi nhánh
 * mình (1506 nếu chỉ định khác), ADMIN phải gửi `branchId` (phải là chi nhánh còn hoạt động, sai → 1602). Số liệu theo
 * CHI NHÁNH: `debtBefore` = nợ của chi nhánh đó (phiếu nhập + điều chỉnh của chi nhánh), không phải nợ toàn chuỗi.
 * Lock order chung của module công nợ: khoá NCC (`lockSupplier`) trước, khoá phiếu nhập sau — không bao giờ ngược lại.
 */
@Injectable()
export class SupplierDebtAdjustmentService {
  constructor(
    private readonly adjustments: SupplierDebtAdjustmentRepository,
    private readonly debts: SupplierDebtRepository,
    private readonly codes: DocumentCodeService,
    private readonly transactions: InventoryTransactions,
    private readonly audit: AuditLogService,
  ) {}

  async create(dto: CreateSupplierDebtAdjustmentRequest, actor: RequestActor) {
    const scope = resolveBranchScope(actor.user);
    const branchId = resolveWriteBranch(scope, dto.branchId, 'Cần chọn chi nhánh điều chỉnh (branchId)');
    const adjustedAt = new Date(dto.adjustedAt);
    if (adjustedAt.getTime() > Date.now() + FUTURE_TOLERANCE_MS) {
      throw badRequest('Ngày điều chỉnh không được ở tương lai');
    }
    const actorId = actor.user.userId;

    return this.transactions.run(async ({ tx }) => {
      // Khoá NCC: hai điều chỉnh cùng lúc xếp hàng, mỗi cái thấy nợ đã gồm cái trước.
      if (!(await this.debts.lockSupplier(tx, dto.supplierId))) throw invalidReference('nhà cung cấp không tồn tại');
      if (!(await this.debts.branchUsable(tx, branchId))) {
        throw invalidReference('chi nhánh không tồn tại hoặc đã ngừng hoạt động');
      }
      // Nợ của đúng chi nhánh này; số người dùng đã thấy phải còn khớp (đã khoá NCC nên không ai chen vào nữa).
      const { scoped: current } = await this.debts.debtOf(dto.supplierId, branchId, tx);
      if (current !== BigInt(dto.expectedDebtBefore)) throw inventoryError(ErrorCode.DEBT_CHANGED);
      const debtAfter = BigInt(dto.debtAfter);
      if (debtAfter === current) throw badRequest('Giá trị nợ không đổi');

      const code = await this.codes.next(tx, 'SUPPLIER_DEBT_ADJUSTMENT');
      const { id } = await this.adjustments.create(tx, {
        code,
        supplierId: dto.supplierId,
        branchId,
        adjustedAt,
        debtBefore: current,
        debtAfter,
        delta: debtAfter - current,
        note: dto.note.trim(),
        createdBy: actorId,
      });
      await this.audit.record(tx, [
        {
          actorId,
          action: AuditAction.CREATE,
          entityType: AUDIT_ENTITY.SUPPLIER_DEBT_ADJUSTMENT,
          entityId: id,
          branchId,
          after: {
            code,
            supplierId: dto.supplierId,
            debtBefore: current.toString(),
            debtAfter: debtAfter.toString(),
            delta: (debtAfter - current).toString(),
          },
          ipAddress: actor.ip,
        },
      ]);
      return present((await this.adjustments.findById(id, tx))!);
    });
  }

  /** Phiếu thuộc chi nhánh ngoài phạm vi → 1506. */
  async getDetail(id: string, actor: RequestActor) {
    const scope = resolveBranchScope(actor.user);
    const row = await this.adjustments.findById(id);
    if (!row) throw notFound();
    assertBranchInScope(scope, row.branchId);
    return present(row);
  }

  async cancel(id: string, dto: CancelDebtDocumentRequest, actor: RequestActor) {
    const scope = resolveBranchScope(actor.user);
    const actorId = actor.user.userId;
    const reason = dto.reason?.trim() || null;

    return this.transactions.run(async ({ tx }) => {
      const row = await this.adjustments.findById(id, tx);
      if (!row) throw notFound();
      assertBranchInScope(scope, row.branchId);

      // Khoá NCC (supplierId bất biến): huỷ xếp hàng cùng điều chỉnh/phiếu chi của NCC này, kiểm nợ sau huỷ không chen.
      await this.debts.lockSupplier(tx, row.supplierId);

      const changed = await this.adjustments.markCancelled(tx, id, { cancelledBy: actorId, reason });
      if (!changed) throw inventoryError(ErrorCode.INVALID_DOCUMENT_STATE, 'phiếu điều chỉnh đã được huỷ trước đó');
      await assertBranchDebtNotNegative(this.debts, tx, row.supplierId, row.branchId, 'Huỷ phiếu điều chỉnh');
      await this.audit.record(tx, [
        {
          actorId,
          action: AuditAction.STATUS_CHANGE,
          entityType: AUDIT_ENTITY.SUPPLIER_DEBT_ADJUSTMENT,
          entityId: id,
          branchId: row.branchId,
          before: { status: 'COMPLETED' },
          after: { status: 'CANCELLED' },
          reason,
          ipAddress: actor.ip,
        },
      ]);
      return present((await this.adjustments.findById(id, tx))!);
    });
  }
}
