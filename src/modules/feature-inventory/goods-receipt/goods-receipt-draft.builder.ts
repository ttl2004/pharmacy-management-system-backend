import { Injectable } from '@nestjs/common';
import { PaymentMethod, Prisma, RecordStatus } from '@prisma/client';
import { ErrorCode } from 'src/common/types/error-code';
import { daysBetweenDateOnly, parseDateOnly, todayInVietnam } from 'src/common/utils/date-only.util';
import { badRequest, invalidReference, inventoryError } from '../core/inventory.error';
import { MAX_DOCUMENT_LINES, NEAR_EXPIRY_WARNING_DAYS } from '../core/inventory.constants';
import { GoodsReceiptDraftFields } from './dtos/goods-receipt.request';
import { GoodsReceiptItemRequest } from './dtos/goods-receipt-item.request';
import { computeLine, computeTotals, ReceiptTotals } from './goods-receipt.calculator';
import { GoodsReceiptRepository } from './repositories/goods-receipt.repository';

export interface PreparedDraft {
  header: {
    supplierId: string;
    receivedAt: Date | null;
    receiverId: string | null;
    paymentMethod: PaymentMethod | null;
    supplierInvoiceNo: string | null;
    supplierInvoiceDate: Date | null;
    note: string | null;
  } & Omit<ReceiptTotals, 'expenses'> & { expenses: Prisma.InputJsonValue | typeof Prisma.DbNull };
  items: Omit<Prisma.GoodsReceiptItemCreateManyInput, 'receiptId' | 'createdBy'>[];
  warnings: string[];
}

/** Kiểm + tính toàn bộ phiếu nháp (đầu phiếu + dòng) trước khi ghi. Tách khỏi service để service gọn. */
@Injectable()
export class GoodsReceiptDraftBuilder {
  constructor(private readonly receipts: GoodsReceiptRepository) {}

  /** Mọi tra cứu tham chiếu là MỘT câu lệnh cho cả phiếu (không vòng lặp gọi DB). */
  async prepare(
    tx: Prisma.TransactionClient,
    branchId: string,
    dto: GoodsReceiptDraftFields,
    options: { requireActiveSupplier: boolean; defaultReceiverId?: string },
  ): Promise<PreparedDraft> {
    if (dto.items.length > MAX_DOCUMENT_LINES) {
      throw inventoryError(ErrorCode.DOCUMENT_LINE_LIMIT, `tối đa ${MAX_DOCUMENT_LINES} dòng`);
    }
    this.assertNoDuplicateBatchLines(dto.items);

    await this.assertBranchActive(tx, branchId);
    const supplier = await this.receipts.findSupplier(tx, dto.supplierId);
    if (!supplier) throw invalidReference('nhà cung cấp không tồn tại');
    if (options.requireActiveSupplier && supplier.status !== RecordStatus.ACTIVE) {
      throw inventoryError(ErrorCode.SUPPLIER_INACTIVE);
    }
    let receiverId = dto.receiverId ?? null;
    if (receiverId) {
      if (!(await this.receipts.isValidReceiver(tx, receiverId, branchId))) {
        throw invalidReference('người nhập không thuộc chi nhánh của phiếu hoặc không còn hoạt động');
      }
    } else if (
      options.defaultReceiverId &&
      (await this.receipts.isValidReceiver(tx, options.defaultReceiverId, branchId))
    ) {
      // Không chọn người nhập → mặc định là người lập phiếu (nếu hợp lệ làm người nhập), như mock FE.
      receiverId = options.defaultReceiverId;
    }

    const units = await this.receipts.findUnitsWithProduct(tx, [
      ...new Set(dto.items.map((item) => item.productUnitId)),
    ]);
    const unitById = new Map(units.map((unit) => [unit.id, unit]));
    const today = todayInVietnam();
    const warnings: string[] = [];

    const items = dto.items.map((item, index) => {
      const unit = unitById.get(item.productUnitId);
      if (!unit || unit.isDeleted || unit.productId !== item.productId) {
        throw invalidReference(`dòng ${index + 1}: đơn vị nhập không thuộc sản phẩm`);
      }
      if (
        unit.status !== RecordStatus.ACTIVE ||
        unit.product.isDeleted ||
        unit.product.status !== RecordStatus.ACTIVE
      ) {
        throw invalidReference(`dòng ${index + 1}: sản phẩm ${unit.product.code} hoặc đơn vị nhập đã ngừng kinh doanh`);
      }
      if (item.manufacturingDate && item.manufacturingDate >= item.expiryDate) {
        throw badRequest(`Dòng ${index + 1}: ngày sản xuất phải trước hạn dùng`);
      }
      const unitDiscount = item.unitDiscount ?? 0;
      if (unitDiscount > item.importPrice) {
        throw badRequest(`Dòng ${index + 1}: giảm giá mỗi đơn vị lớn hơn giá nhập`);
      }
      this.checkExpiry(item.batchNumber, item.expiryDate, today, warnings);

      const amounts = computeLine({
        quantity: item.quantity,
        conversionRate: unit.conversionRate,
        importPrice: item.importPrice,
        unitDiscount,
      });
      if (!amounts) throw badRequest(`Dòng ${index + 1}: số lượng quy đổi vượt giới hạn`);

      return {
        productId: item.productId,
        productUnitId: item.productUnitId,
        quantity: item.quantity,
        conversionRate: unit.conversionRate,
        baseQuantity: amounts.baseQuantity,
        importPrice: item.importPrice,
        unitDiscount,
        totalPrice: amounts.totalPrice,
        batchNumber: item.batchNumber,
        manufacturingDate: item.manufacturingDate ? parseDateOnly(item.manufacturingDate) : null,
        expiryDate: parseDateOnly(item.expiryDate),
        note: item.note?.trim() || null,
      };
    });

    const totals = computeTotals(
      items.map((item) => item.totalPrice),
      dto,
    );
    if (totals === 'DISCOUNT_EXCEEDS_SUBTOTAL') throw badRequest('Chiết khấu lớn hơn tiền hàng');
    if (totals === 'DISCOUNT_BOTH_KINDS') throw badRequest('Chỉ gửi một trong discountAmount hoặc discountPercent');
    if (totals === 'EXPENSE_VALUE_INVALID') throw badRequest('Giá trị chi phí không hợp lệ (VND phải nguyên, % tối đa 100)');
    if (totals === 'PAID_EXCEEDS_TOTAL') throw badRequest('Số đã trả lớn hơn tổng tiền phiếu');

    return {
      header: {
        supplierId: dto.supplierId,
        receivedAt: dto.receivedAt ? new Date(dto.receivedAt) : null,
        receiverId,
        paymentMethod: dto.paymentMethod ?? null,
        supplierInvoiceNo: dto.supplierInvoiceNo ?? null,
        supplierInvoiceDate: dto.supplierInvoiceDate ? parseDateOnly(dto.supplierInvoiceDate) : null,
        note: dto.note ?? null,
        ...totals,
        expenses: totals.expenses ? (totals.expenses as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
      },
      items,
      warnings,
    };
  }

  /** K7: hạn dùng <= hôm nay (giờ VN) → cấm; còn dưới 90 ngày → cảnh báo, vẫn cho nhập. */
  checkExpiry(batchNumber: string, expiry: string, today: string, warnings: string[]): void {
    const daysLeft = daysBetweenDateOnly(today, expiry);
    if (daysLeft <= 0) throw inventoryError(ErrorCode.BATCH_EXPIRED, `lô ${batchNumber} hết hạn ${expiry}`);
    if (daysLeft < NEAR_EXPIRY_WARNING_DAYS) {
      warnings.push(`Lô ${batchNumber} chỉ còn ${daysLeft} ngày sử dụng (hạn ${expiry})`);
    }
  }

  async assertBranchActive(tx: Prisma.TransactionClient, branchId: string): Promise<void> {
    const branch = await this.receipts.findBranch(tx, branchId);
    if (!branch) throw invalidReference('chi nhánh không tồn tại');
    if (branch.status !== RecordStatus.ACTIVE) throw inventoryError(ErrorCode.BRANCH_INACTIVE);
  }

  /** Một phiếu không được có hai dòng cùng sản phẩm + số lô: lô là một dòng tồn duy nhất, gộp số lượng vào một dòng. */
  private assertNoDuplicateBatchLines(items: readonly GoodsReceiptItemRequest[]): void {
    const seen = new Set<string>();
    for (const item of items) {
      const key = `${item.productId}|${item.batchNumber}`;
      if (seen.has(key)) throw badRequest(`Lô ${item.batchNumber} xuất hiện hai lần — gộp vào một dòng`);
      seen.add(key);
    }
  }
}
