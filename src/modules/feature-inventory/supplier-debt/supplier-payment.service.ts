import { Injectable } from '@nestjs/common';
import { ReceiptStatus, SupplierPaymentSource } from '@prisma/client';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { AuthRole } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';
import {
  assertBranchInScope,
  BranchScope,
  isInBranchScope,
  resolveBranchScope,
} from 'src/modules/feature-auth/permission/branch-scope';
import { PermissionService } from 'src/modules/feature-auth/permission/permission.service';
import { badRequest, inventoryError, invalidReference } from '../core/inventory.error';
import { InventoryTransactions } from '../core/inventory-transactions';
import { resolveWriteBranch } from '../core/inventory-scope';
import { CancelDebtDocumentRequest, CreateSupplierPaymentRequest } from './dtos/supplier-payment.request';
import { PaymentRow, SupplierPaymentRepository } from './repositories/supplier-payment.repository';
import { SupplierDebtRepository } from './repositories/supplier-debt.repository';
import { assertPaymentWithinDebt } from './supplier-debt-guards';
import { SupplierPaymentWriter } from './supplier-payment.writer';

/** Cho lệch đồng hồ client: `paidAt` được vượt hiện tại tối đa chừng này (như mock). */
const FUTURE_TOLERANCE_MS = 60_000;

const money = (value: bigint | number) => Number(value).toLocaleString('vi-VN');

/** Chi nhánh liên quan tới phiếu chi: nơi chi tiền + chi nhánh của các phiếu nhập được phân bổ. */
function branchesOf(row: Pick<PaymentRow, 'branchId' | 'allocations'>): string[] {
  return [...new Set([row.branchId, ...row.allocations.map((a) => a.receipt.branchId)])];
}

function present(row: PaymentRow, canCancel: boolean) {
  const { cancelledAt, amount, allocations, ...rest } = row;
  return {
    ...rest,
    amount: Number(amount),
    status: cancelledAt ? 'CANCELLED' : 'COMPLETED',
    cancelledAt,
    allocations: allocations.map((a) => ({
      receiptId: a.receiptId,
      amount: Number(a.amount),
      receipt: { id: a.receipt.id, code: a.receipt.code },
    })),
    canCancel,
  };
}

const notFound = () => new ErrorException({ code: ErrorCode.RECORD_NOT_FOUND, message: 'Phiếu chi không tồn tại' });

@Injectable()
export class SupplierPaymentService {
  constructor(
    private readonly payments: SupplierPaymentRepository,
    private readonly debts: SupplierDebtRepository,
    private readonly writer: SupplierPaymentWriter,
    private readonly transactions: InventoryTransactions,
    private readonly permissions: PermissionService,
  ) {}

  /** Lập phiếu chi phân bổ vào nhiều phiếu nhập của MỘT NCC; sai một dòng là rollback cả phiếu. */
  async create(dto: CreateSupplierPaymentRequest, actor: RequestActor) {
    const scope = resolveBranchScope(actor.user);
    const branchId = resolveWriteBranch(scope, dto.branchId, 'Cần chọn chi nhánh chi tiền (branchId)');
    const paidAt = new Date(dto.paidAt);
    if (paidAt.getTime() > Date.now() + FUTURE_TOLERANCE_MS) {
      throw badRequest('Thời gian thanh toán không được ở tương lai');
    }
    const ids = dto.allocations.map((row) => row.receiptId);
    if (new Set(ids).size !== ids.length) throw invalidReference('một phiếu nhập chỉ được phân bổ một lần');

    return this.transactions.run(async ({ tx }) => {
      // Lock order: khoá NCC TRƯỚC (xếp hàng cùng điều chỉnh nợ/huỷ), phiếu nhập khoá sau khi cộng paidAmount.
      if (!(await this.debts.lockSupplier(tx, dto.supplierId))) throw invalidReference('nhà cung cấp không tồn tại');
      if (!(await this.debts.branchUsable(tx, branchId))) {
        throw invalidReference('chi nhánh không tồn tại hoặc đã ngừng hoạt động');
      }

      const receipts = new Map((await this.debts.findReceiptsForAllocation(tx, ids)).map((r) => [r.id, r]));
      for (const line of dto.allocations) {
        const receipt = receipts.get(line.receiptId);
        if (
          !receipt ||
          receipt.status !== ReceiptStatus.CONFIRMED ||
          receipt.supplierId !== dto.supplierId ||
          !isInBranchScope(scope, receipt.branchId)
        ) {
          throw invalidReference('có phiếu nhập không hợp lệ để phân bổ (chưa xác nhận, khác NCC hoặc ngoài phạm vi)');
        }
        const remaining = receipt.totalAmount - receipt.paidAmount;
        if (BigInt(line.amount) > remaining) {
          throw inventoryError(ErrorCode.DEBT_EXCEEDED, `phiếu ${receipt.code} chỉ còn nợ ${money(remaining)}`);
        }
      }

      // Kiểm cả nợ trong phạm vi người trả lẫn nợ toàn chuỗi (dùng chung với PATCH /goods-receipt/:id/payment).
      const total = dto.allocations.reduce((sum, row) => sum + BigInt(row.amount), 0n);
      await assertPaymentWithinDebt(this.debts, tx, scope, dto.supplierId, total);

      const created = await this.writer.create(
        tx,
        {
          supplierId: dto.supplierId,
          branchId,
          paidAt,
          method: dto.method,
          note: dto.note?.trim() || null,
          source: SupplierPaymentSource.MANUAL,
          allocations: dto.allocations.map((row) => ({ receiptId: row.receiptId, amount: BigInt(row.amount) })),
        },
        { actorId: actor.user.userId, ip: actor.ip },
      );
      const row = (await this.payments.findById(created.id, tx))!;
      return present(row, await this.canCancel(row, scope, actor));
    });
  }

  /** Xem được nếu thấy ít nhất một chi nhánh liên quan; ngoài phạm vi = không tồn tại (BS-05). */
  async getDetail(id: string, actor: RequestActor) {
    const scope = resolveBranchScope(actor.user);
    const row = await this.payments.findById(id);
    if (!row || !branchesOf(row).some((b) => isInBranchScope(scope, b))) throw notFound();
    return present(row, await this.canCancel(row, scope, actor));
  }

  /** Huỷ cần quyền trên MỌI chi nhánh liên quan (huỷ làm nợ tăng lại ở mọi phiếu được phân bổ) — không → 1506. */
  async cancel(id: string, dto: CancelDebtDocumentRequest, actor: RequestActor) {
    const scope = resolveBranchScope(actor.user);
    return this.transactions.run(async ({ tx }) => {
      const row = await this.payments.findById(id, tx);
      if (!row || !branchesOf(row).some((b) => isInBranchScope(scope, b))) throw notFound();
      for (const branchId of branchesOf(row)) assertBranchInScope(scope, branchId);

      await this.writer.cancel(tx, row, dto.reason?.trim() || null, { actorId: actor.user.userId, ip: actor.ip });
      const after = (await this.payments.findById(id, tx))!;
      return present(after, false);
    });
  }

  private async canCancel(row: PaymentRow, scope: BranchScope, actor: RequestActor): Promise<boolean> {
    if (row.cancelledAt) return false;
    if (!branchesOf(row).every((b) => isInBranchScope(scope, b))) return false;
    const role = actor.user.role;
    return role === AuthRole.SUPER_ADMIN || (await this.permissions.getGrantedCodes(role)).has('supplier-debt:write');
  }
}
