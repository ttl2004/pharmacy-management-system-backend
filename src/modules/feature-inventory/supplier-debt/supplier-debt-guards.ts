import { Prisma } from '@prisma/client';
import { ErrorCode } from 'src/common/types/error-code';
import type { BranchScope } from 'src/modules/feature-auth/permission/branch-scope';
import { inventoryError } from '../core/inventory.error';
import { SupplierDebtRepository } from './repositories/supplier-debt.repository';

/**
 * Gọi SAU khi đã ghi (trong transaction, đã `lockSupplier`): nợ của chi nhánh không được âm. Huỷ điều chỉnh / huỷ phiếu
 * nhập có thể làm tổng nợ âm khi trước đó đã có điều chỉnh giảm — quăng lỗi để rollback cả thao tác.
 */
export async function assertBranchDebtNotNegative(
  debts: SupplierDebtRepository,
  tx: Prisma.TransactionClient,
  supplierId: string,
  branchId: string,
  action: string,
): Promise<void> {
  const { scoped } = await debts.debtOf(supplierId, branchId, tx);
  if (scoped < 0n) {
    throw inventoryError(
      ErrorCode.DEBT_EXCEEDED,
      `${action} sẽ làm công nợ nhà cung cấp tại chi nhánh bị âm (${Number(scoped).toLocaleString('vi-VN')}) — huỷ các điều chỉnh nợ liên quan trước`,
    );
  }
}

const money = (value: bigint | number) => Number(value).toLocaleString('vi-VN');

/**
 * Trần chi trả (dùng chung cho `POST /supplier-payment` và `PATCH /goods-receipt/:id/payment`): tổng trả không vượt nợ
 * trong phạm vi người trả lẫn nợ toàn chuỗi (điều chỉnh có thể đã giảm nợ). Gọi sau `lockSupplier`.
 */
export async function assertPaymentWithinDebt(
  debts: SupplierDebtRepository,
  tx: Prisma.TransactionClient,
  scope: BranchScope,
  supplierId: string,
  total: bigint,
): Promise<void> {
  const debt = await debts.debtOf(supplierId, scope.kind === 'BRANCH' ? scope.branchId : undefined, tx);
  if (total > debt.scoped) {
    const cap = debt.scoped > 0n ? debt.scoped : 0n;
    throw inventoryError(ErrorCode.DEBT_EXCEEDED, `tổng trả ${money(total)} vượt nợ hiện tại ${money(cap)}`);
  }
  if (total > debt.chain) {
    throw inventoryError(
      ErrorCode.DEBT_EXCEEDED,
      'nợ nhà cung cấp đã được điều chỉnh giảm ở cấp chuỗi, số trả vượt nợ thực tế — liên hệ chủ nhà thuốc',
    );
  }
}
