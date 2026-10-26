import { Injectable } from '@nestjs/common';
import { Prisma, ReceiptStatus } from '@prisma/client';
import { documentErrors } from '../core/inventory.error';
import { SupplierDebtRepository } from '../supplier-debt/repositories/supplier-debt.repository';
import { GoodsReceiptRepository, ReceiptHead } from './repositories/goods-receipt.repository';

const errors = documentErrors('Phiếu nhập');

/**
 * Khoá đầu phiếu nhập trước khi đọc-rồi-ghi. LOCK ORDER của cả hệ thống công nợ: khoá NCC (`suppliers`) TRƯỚC, khoá
 * phiếu nhập (`goods_receipts`) SAU — lập phiếu chi và điều chỉnh nợ cũng đi theo thứ tự này nên không có vòng chờ.
 */
@Injectable()
export class GoodsReceiptLocker {
  constructor(
    private readonly receipts: GoodsReceiptRepository,
    private readonly debts: SupplierDebtRepository,
  ) {}

  /**
   * Khoá phiếu rồi trả đầu phiếu mới nhất. `supplierWhenConfirmed`: thao tác đổi công nợ của phiếu ĐÃ XÁC NHẬN
   * (huỷ phiếu, tăng số đã trả) → khoá NCC trước. Nhà cung cấp của phiếu đã xác nhận bất biến nên đọc không khoá
   * để biết NCC là an toàn. Nếu phiếu vừa chuyển sang CONFIRMED giữa hai lần đọc (chưa kịp khoá NCC) thì báo
   * "phiếu vừa được người khác xử lý" thay vì khoá ngược thứ tự.
   */
  async lock(
    tx: Prisma.TransactionClient,
    id: string,
    scopeWhere: { branchId?: string },
    options: { supplierWhenConfirmed?: boolean } = {},
  ): Promise<ReceiptHead> {
    let supplierLocked = false;
    if (options.supplierWhenConfirmed) {
      const peek = await this.receipts.findStatus(tx, id, scopeWhere);
      if (!peek) throw errors.notFound();
      if (peek.status === ReceiptStatus.CONFIRMED) {
        await this.debts.lockSupplier(tx, peek.supplierId);
        supplierLocked = true;
      }
    }
    const head = await this.receipts.findStatusForUpdate(tx, id, scopeWhere);
    if (!head) throw errors.notFound();
    if (options.supplierWhenConfirmed && head.status === ReceiptStatus.CONFIRMED && !supplierLocked) {
      throw errors.wrongState();
    }
    return head;
  }
}
