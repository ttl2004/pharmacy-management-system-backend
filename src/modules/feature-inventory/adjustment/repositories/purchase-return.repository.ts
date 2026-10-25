import { Injectable } from '@nestjs/common';
import { AdjustmentType, Prisma, ReceiptStatus, StockRefType } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';

/** Phiếu nhập gốc đủ để trả theo phiếu: dòng nhập + bản chụp chi phí. */
const RETURN_RECEIPT_SELECT = {
  id: true,
  code: true,
  branchId: true,
  supplierId: true,
  status: true,
  subtotalAmount: true,
  discountAmount: true,
  expenses: true,
  supplier: { select: { id: true, name: true } },
  items: {
    where: { isDeleted: false },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      productId: true,
      batchNumber: true,
      expiryDate: true,
      baseQuantity: true,
      product: {
        select: {
          code: true,
          name: true,
          units: { where: { isDeleted: false, isBaseUnit: true }, select: { unit: { select: { name: true } } }, take: 1 },
        },
      },
    },
  },
} satisfies Prisma.GoodsReceiptSelect;

export type ReturnReceipt = Prisma.GoodsReceiptGetPayload<{ select: typeof RETURN_RECEIPT_SELECT }>;

/** Bản chụp chi phí hoàn lại trên phiếu trả (JSONB). */
export interface RefundExpenseSnapshot {
  code: string;
  name: string;
  receivedAmount: number;
  amount: number;
}

/** Đọc dữ liệu trả hàng theo phiếu nhập (không ghi). Nhận `client` để chạy trong transaction của người gọi. */
@Injectable()
export class PurchaseReturnRepository {
  constructor(private readonly prisma: PrismaService) {}

  findReceipt(id: string, client: Prisma.TransactionClient = this.prisma): Promise<ReturnReceipt | null> {
    return client.goodsReceipt.findFirst({ where: { id, isDeleted: false }, select: RETURN_RECEIPT_SELECT });
  }

  /** SL đã trả (đơn vị cơ bản) theo dòng phiếu nhập, chỉ tính phiếu trả ĐÃ XÁC NHẬN; `excludeId` = phiếu đang xét. */
  async returnedByReceiptItem(
    receiptItemIds: readonly string[],
    excludeId: string | undefined,
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<Map<string, number>> {
    if (!receiptItemIds.length) return new Map();
    const rows = await client.stockAdjustmentItem.groupBy({
      by: ['goodsReceiptItemId'],
      where: {
        goodsReceiptItemId: { in: [...receiptItemIds] },
        isDeleted: false,
        adjustment: {
          type: AdjustmentType.RETURN_TO_SUPPLIER,
          status: ReceiptStatus.CONFIRMED,
          isDeleted: false,
          ...(excludeId ? { id: { not: excludeId } } : {}),
        },
      },
      _sum: { quantity: true },
    });
    // Dòng trả lưu delta âm.
    return new Map(rows.map((row) => [row.goodsReceiptItemId as string, -(row._sum.quantity ?? 0)]));
  }

  /** Chi phí đã hoàn theo `code` ở các phiếu trả ĐÃ XÁC NHẬN của cùng phiếu nhập. */
  async refundedByCode(
    receiptId: string,
    excludeId: string | undefined,
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<Map<string, number>> {
    const rows = await client.stockAdjustment.findMany({
      where: {
        goodsReceiptId: receiptId,
        type: AdjustmentType.RETURN_TO_SUPPLIER,
        status: ReceiptStatus.CONFIRMED,
        isDeleted: false,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { refundExpenses: true },
    });
    const out = new Map<string, number>();
    for (const row of rows) {
      for (const e of (row.refundExpenses as RefundExpenseSnapshot[] | null) ?? []) {
        out.set(e.code, (out.get(e.code) ?? 0) + e.amount);
      }
    }
    return out;
  }

  /** Lô ở chi nhánh phiếu nhập theo (sản phẩm, số lô) — lô nhập có thể đã gộp với lô cùng số từ trước. */
  findReceiptBatches(branchId: string, keys: readonly { productId: string; batchNumber: string }[]) {
    // Không trả sớm `Promise.resolve([])` — kiểu suy ra thành `never[]` làm hỏng kiểu của nơi gọi; `OR: []` của Prisma đã ra rỗng.
    return this.prisma.stockBatch.findMany({
      where: { branchId, isDeleted: false, OR: keys.map((k) => ({ productId: k.productId, batchNumber: k.batchNumber })) },
      select: { id: true, productId: true, batchNumber: true, quantityOnHand: true, reservedQuantity: true, importPrice: true },
    });
  }

  /** Giá vốn / đơn vị cơ bản đã phân bổ của từng dòng nhập (bút toán nhập kho lúc xác nhận). */
  async receiptItemCosts(receiptId: string): Promise<Map<string, number>> {
    const rows = await this.prisma.stockMovement.findMany({
      where: { refType: StockRefType.GOODS_RECEIPT, refId: receiptId, quantity: { gt: 0 } },
      select: { refItemId: true, unitCost: true },
    });
    return new Map(rows.filter((r) => r.refItemId && r.unitCost !== null).map((r) => [r.refItemId as string, r.unitCost as number]));
  }
}
