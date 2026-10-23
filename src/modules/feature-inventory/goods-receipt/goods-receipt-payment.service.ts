import { Injectable } from '@nestjs/common';
import { AuditAction, PaymentMethod, Prisma, ReceiptStatus, SupplierPaymentSource } from '@prisma/client';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthRole } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';
import { resolveBranchScope } from 'src/modules/feature-auth/permission/branch-scope';
import { permissionError } from 'src/modules/feature-auth/permission/permission.error';
import { PermissionService } from 'src/modules/feature-auth/permission/permission.service';
import { AuditLogService } from 'src/providers/audit-log/audit-log.service';
import { badRequest, documentErrors } from '../core/inventory.error';
import { branchWhere } from '../core/inventory-scope';
import { InventoryTransactions } from '../core/inventory-transactions';
import { AUDIT_ENTITY } from '../core/inventory.constants';
import { SupplierDebtRepository } from '../supplier-debt/repositories/supplier-debt.repository';
import { assertPaymentWithinDebt } from '../supplier-debt/supplier-debt-guards';
import { SupplierPaymentWriter } from '../supplier-debt/supplier-payment.writer';
import { UpdateReceiptPaymentRequest } from './dtos/goods-receipt.request';
import { GoodsReceiptLocker } from './goods-receipt-locker';
import { paymentStatusOf } from './goods-receipt.calculator';
import { GoodsReceiptDetail, GoodsReceiptRepository } from './repositories/goods-receipt.repository';

const errors = documentErrors('Phiếu nhập');

/** `PATCH /goods-receipt/:id/payment` — số "đã trả NCC" của phiếu nháp / phiếu đã xác nhận. */
@Injectable()
export class GoodsReceiptPaymentService {
  constructor(
    private readonly receipts: GoodsReceiptRepository,
    private readonly locker: GoodsReceiptLocker,
    private readonly debts: SupplierDebtRepository,
    private readonly supplierPayments: SupplierPaymentWriter,
    private readonly permissions: PermissionService,
    private readonly transactions: InventoryTransactions,
    private readonly audit: AuditLogService,
  ) {}

  /** Cập nhật số đã trả NCC (tổng, không phải số trả thêm). Lịch sử từng lần đổi nằm ở `audit_logs`. */
  async updatePayment(id: string, dto: UpdateReceiptPaymentRequest, actor: RequestActor): Promise<GoodsReceiptDetail> {
    const scope = resolveBranchScope(actor.user);
    const actorId = actor.user.userId;

    return this.transactions.run(async ({ tx }) => {
      // Khoá phiếu (và NCC nếu đã xác nhận): số "đã trả" đọc được là số thật, hai request không cùng lập phiếu chi.
      const head = await this.locker.lock(tx, id, branchWhere(scope), { supplierWhenConfirmed: true });
      if (head.status === ReceiptStatus.CANCELLED) throw errors.wrongState(head.status);

      const paidAmount = BigInt(dto.paidAmount);
      if (paidAmount > head.totalAmount) throw badRequest('Số đã trả lớn hơn tổng tiền phiếu');
      const paymentStatus = paymentStatusOf(paidAmount, head.totalAmount);

      if (head.status === ReceiptStatus.CONFIRMED) {
        // paidAmount là bộ đệm của Σ phân bổ: tăng = lập phiếu chi cho phần chênh; giảm phải huỷ phiếu chi.
        if (paidAmount < head.paidAmount) {
          throw badRequest('Muốn giảm số đã trả, hãy huỷ phiếu chi tương ứng');
        }
        if (paidAmount > head.paidAmount) {
          // Lập phiếu chi = ghi công nợ → cần cả `supplier-debt:write` và chịu cùng trần nợ như POST /supplier-payment.
          await this.assertCanWriteDebt(actor);
          const delta = paidAmount - head.paidAmount;
          await assertPaymentWithinDebt(this.debts, tx, scope, head.supplierId, delta);
          await this.supplierPayments.createForReceipt(
            tx,
            head,
            delta,
            {
              method: PaymentMethod.CASH,
              // RECEIPT: phiếu chi tự sinh gắn với phiếu nhập, huỷ phiếu nhập thì huỷ theo (không chặn bằng 1713).
              source: SupplierPaymentSource.RECEIPT,
              note: `Bổ sung thanh toán phiếu nhập ${head.code}`,
            },
            { actorId, ip: actor.ip },
          );
        }
        return this.mustFind(tx, id);
      }

      // Nháp: chỉ ghi số liệu; transition CHỈ từ DRAFT (phiếu vừa xác nhận thì paidAmount phải đi qua phiếu chi).
      const changed = await this.receipts.transition(tx, id, ReceiptStatus.DRAFT, {
        paidAmount,
        paymentStatus,
        updatedAt: new Date(),
        updatedBy: actorId,
      });
      if (!changed) throw errors.wrongState();

      if (paidAmount !== head.paidAmount) {
        await this.audit.record(tx, [
          {
            actorId,
            action: AuditAction.UPDATE,
            entityType: AUDIT_ENTITY.GOODS_RECEIPT,
            entityId: id,
            branchId: head.branchId,
            before: { paidAmount: head.paidAmount.toString() },
            after: { paidAmount: paidAmount.toString(), paymentStatus },
            ipAddress: actor.ip,
          },
        ]);
      }
      return this.mustFind(tx, id);
    });
  }

  private async assertCanWriteDebt(actor: RequestActor): Promise<void> {
    const role = actor.user.role;
    if (role === AuthRole.SUPER_ADMIN) return;
    if (!(await this.permissions.getGrantedCodes(role)).has('supplier-debt:write')) {
      throw permissionError(ErrorCode.PERMISSION_DENIED);
    }
  }

  private async mustFind(tx: Prisma.TransactionClient, id: string): Promise<GoodsReceiptDetail> {
    const receipt = await this.receipts.findDetail(id, {}, tx);
    if (!receipt) throw errors.notFound();
    return receipt;
  }
}
