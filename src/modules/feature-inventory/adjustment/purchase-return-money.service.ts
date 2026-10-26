import { Injectable } from '@nestjs/common';
import { PaymentMethod, Prisma, ReceiptStatus } from '@prisma/client';
import { badRequest, invalidReference } from '../core/inventory.error';
import { percentOf, type ExpenseSnapshot } from '../goods-receipt/goods-receipt.calculator';
import type { AdjustmentItemRequest, CreateAdjustmentRequest } from './dtos/adjustment.request';
import type { DraftBatch } from './repositories/adjustment.repository';
import {
  PurchaseReturnRepository,
  type RefundExpenseSnapshot,
  type ReturnReceipt,
} from './repositories/purchase-return.repository';

type MoneyDto = Pick<
  CreateAdjustmentRequest,
  'goodsReceiptId' | 'discountAmount' | 'discountPercent' | 'refundExpenses' | 'supplierPaid' | 'paymentMethod' | 'items'
>;

/** Một dòng trả: lô đã đọc + số đưa ra (dương) + phần tiền gửi lên. */
export interface ReturnLineInput {
  batch: DraftBatch;
  quantity: number;
  item: AdjustmentItemRequest;
}

/** Cột tiền ghi lên header phiếu (create/update dùng chung). */
export interface ReturnMoneyHeader {
  goodsReceiptId: string | null;
  goodsAmount: bigint;
  discountAmount: bigint;
  discountPercent: number | null;
  refundExpenseAmount: bigint;
  refundExpenses: Prisma.InputJsonValue | typeof Prisma.DbNull;
  totalAmount: bigint;
  supplierPaid: bigint;
  paymentMethod: PaymentMethod | null;
}

/** Header tiền của phiếu không phải trả NCC — về 0 / null. */
export const NO_RETURN_MONEY: ReturnMoneyHeader = {
  goodsReceiptId: null,
  goodsAmount: 0n,
  discountAmount: 0n,
  discountPercent: null,
  refundExpenseAmount: 0n,
  refundExpenses: Prisma.DbNull,
  totalAmount: 0n,
  supplierPaid: 0n,
  paymentMethod: null,
};

/**
 * Tiền phiếu trả NCC (như mock `purchaseReturnAmounts`): tiền hàng = Σ SL × giá trả; giảm giá VND hoặc % (≤ tiền hàng);
 * chi phí hoàn lại chỉ khi trả theo phiếu nhập (≤ phần chưa hoàn của chi phí NCC trên phiếu gốc); NCC cần trả =
 * hàng − giảm + hoàn; tiền NCC trả ≤ cần trả. Trả theo phiếu nhập: mỗi dòng phải trỏ dòng nhập cùng sản phẩm + số lô,
 * tổng trả (kể cả phiếu đã xác nhận khác) ≤ SL nhập.
 */
@Injectable()
export class PurchaseReturnMoneyService {
  constructor(private readonly returns: PurchaseReturnRepository) {}

  /**
   * Trả theo phiếu nhập: từng dòng nhập + đã trả (phiếu trả đã xác nhận) + tồn lô hiện tại → còn trả được =
   * max(0, min(nhập − đã trả, tồn khả dụng)); chi phí NCC của phiếu gốc + phần còn hoàn được. PM chỉ xem phiếu chi nhánh mình.
   */
  async returnable(receiptId: string, ownBranchId: string | undefined) {
    const receipt = await this.returns.findReceipt(receiptId);
    if (!receipt || (ownBranchId && receipt.branchId !== ownBranchId)) throw invalidReference('phiếu nhập không tồn tại');
    if (receipt.status !== ReceiptStatus.CONFIRMED) throw badRequest('Chỉ trả theo phiếu nhập đã nhập kho');
    const [returned, refunded, costs, batches] = await Promise.all([
      this.returns.returnedByReceiptItem(receipt.items.map((i) => i.id), undefined),
      this.returns.refundedByCode(receipt.id, undefined),
      this.returns.receiptItemCosts(receipt.id),
      this.returns.findReceiptBatches(receipt.branchId, receipt.items),
    ]);
    const batchOf = (productId: string, batchNumber: string) =>
      batches.find((b) => b.productId === productId && b.batchNumber === batchNumber);
    return {
      receiptId: receipt.id,
      receiptCode: receipt.code,
      branchId: receipt.branchId,
      supplierId: receipt.supplierId,
      supplierName: receipt.supplier.name,
      // Mẫu số chia tỷ lệ chi phí hoàn lại (như mock: tiền hàng phiếu gốc).
      goodsAmount: receipt.subtotalAmount,
      lines: receipt.items.map((item) => {
        const batch = batchOf(item.productId, item.batchNumber);
        const lotStock = batch ? batch.quantityOnHand - batch.reservedQuantity : 0;
        const done = returned.get(item.id) ?? 0;
        return {
          goodsReceiptItemId: item.id,
          productId: item.productId,
          productCode: item.product.code,
          productName: item.product.name,
          unitName: item.product.units[0]?.unit.name ?? '',
          batchId: batch?.id ?? null,
          batchNumber: item.batchNumber,
          expiryDate: item.expiryDate,
          unitCost: costs.get(item.id) ?? batch?.importPrice ?? 0,
          received: item.baseQuantity,
          returned: done,
          lotStock,
          maxReturnable: batch ? Math.max(0, Math.min(item.baseQuantity - done, lotStock)) : 0,
        };
      }),
      expenses: ((receipt.expenses as ExpenseSnapshot[] | null) ?? [])
        .filter((e) => e.kind === 'SUPPLIER')
        .map((e) => ({
          code: e.code,
          name: e.name,
          receivedAmount: e.amount,
          remaining: Math.max(0, e.amount - (refunded.get(e.code) ?? 0)),
        })),
    };
  }

  /** Phiếu không phải trả NCC mà gửi trường tiền → 400 (không âm thầm bỏ qua). */
  assertNoMoney(dto: MoneyDto): void {
    const headerSent =
      dto.goodsReceiptId !== undefined || dto.discountAmount !== undefined || dto.discountPercent !== undefined ||
      (dto.refundExpenses?.length ?? 0) > 0 || dto.supplierPaid !== undefined || dto.paymentMethod !== undefined;
    const lineSent = dto.items.some((i) => i.returnPrice !== undefined || i.goodsReceiptItemId !== undefined);
    if (headerSent || lineSent) throw badRequest('Giá trả, giảm giá, tiền NCC trả chỉ dùng cho phiếu trả hàng nhập');
  }

  /** Tính + kiểm tiền phiếu trả lúc lưu nháp. `excludeId` = phiếu đang sửa (không tự tính vào "đã trả"). */
  async build(
    tx: Prisma.TransactionClient,
    input: { dto: MoneyDto; branchId: string; supplierId: string; excludeId?: string; lines: readonly ReturnLineInput[] },
  ): Promise<{ header: ReturnMoneyHeader; lineMoney: Map<string, { returnPrice: number; goodsReceiptItemId: string | null }> }> {
    const { dto } = input;
    const receipt = dto.goodsReceiptId ? await this.loadReceipt(tx, dto.goodsReceiptId, input.branchId, input.supplierId) : null;
    if (!receipt && input.lines.some((l) => l.item.goodsReceiptItemId)) {
      throw badRequest('Dòng trả theo phiếu nhập phải kèm goodsReceiptId');
    }
    if (!receipt && dto.refundExpenses?.length) throw badRequest('Chi phí nhập hoàn lại chỉ có khi trả theo phiếu nhập');
    if (receipt) await this.assertWithinReceived(tx, receipt, input.lines, input.excludeId);

    const lineMoney = new Map(
      input.lines.map((l) => [
        l.batch.id,
        { returnPrice: l.item.returnPrice ?? l.batch.importPrice, goodsReceiptItemId: l.item.goodsReceiptItemId ?? null },
      ]),
    );
    const goodsAmount = input.lines.reduce(
      (sum, l) => sum + BigInt(l.quantity) * BigInt(lineMoney.get(l.batch.id)?.returnPrice ?? 0),
      0n,
    );

    const hasPercent = dto.discountPercent !== undefined;
    if (hasPercent && (dto.discountAmount ?? 0) > 0) throw badRequest('Chỉ chọn giảm giá theo VND hoặc theo %');
    const discountAmount = hasPercent ? percentOf(goodsAmount, dto.discountPercent as number) : BigInt(dto.discountAmount ?? 0);
    if (discountAmount > goodsAmount) throw badRequest('Giảm giá vượt tổng tiền hàng');

    const refunds = receipt ? await this.refundSnapshots(tx, receipt, dto.refundExpenses ?? [], input.excludeId) : [];
    const refundExpenseAmount = refunds.reduce((sum, e) => sum + BigInt(e.amount), 0n);
    const totalAmount = goodsAmount - discountAmount + refundExpenseAmount;
    const supplierPaid = BigInt(dto.supplierPaid ?? 0);
    if (supplierPaid > totalAmount) throw badRequest('Tiền NCC trả vượt số NCC cần trả');

    return {
      header: {
        goodsReceiptId: receipt?.id ?? null,
        goodsAmount,
        discountAmount,
        discountPercent: hasPercent ? (dto.discountPercent as number) : null,
        refundExpenseAmount,
        refundExpenses: refunds.length ? (refunds as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
        totalAmount,
        supplierPaid,
        // Có tiền hoàn thì mặc định tiền mặt (như mock `payMethod` mặc định 'cash').
        paymentMethod: dto.paymentMethod ?? (supplierPaid > 0n ? PaymentMethod.CASH : null),
      },
      lineMoney,
    };
  }

  /**
   * Khoá NCC của phiếu trả (lock order chung: NCC → phiếu nhập → lô) — xác nhận/huỷ phiếu trả đổi công nợ nên xếp hàng
   * cùng phiếu chi / điều chỉnh nợ (các bên đó tính `debtBefore` dưới khoá NCC).
   */
  async lockSupplierOf(tx: Prisma.TransactionClient, adjustmentId: string): Promise<void> {
    await tx.$queryRaw(Prisma.sql`
      SELECT s."id" FROM "suppliers" s JOIN "stock_adjustments" a ON a."supplierId" = s."id"
      WHERE a."id" = ${adjustmentId}::uuid FOR UPDATE OF s`);
  }

  /**
   * Lúc xác nhận: kiểm lại trần SL và chi phí hoàn vì phiếu trả khác của cùng phiếu nhập có thể đã xác nhận sau khi
   * lưu nháp. Khoá phiếu nhập trước để hai lần xác nhận cùng phiếu nhập chạy nối tiếp.
   */
  async recheckOnConfirm(
    tx: Prisma.TransactionClient,
    adjustmentId: string,
    receiptId: string,
    items: readonly { goodsReceiptItemId: string | null; quantity: number }[],
    refundExpenses: Prisma.JsonValue,
  ): Promise<void> {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "goods_receipts" WHERE "id" = ${receiptId}::uuid FOR UPDATE`);
    const receipt = await this.returns.findReceipt(receiptId, tx);
    if (!receipt || receipt.status !== ReceiptStatus.CONFIRMED) throw badRequest('Phiếu nhập gốc không còn ở trạng thái đã nhập');
    const wanted = new Map<string, number>();
    for (const item of items) {
      if (item.goodsReceiptItemId) wanted.set(item.goodsReceiptItemId, (wanted.get(item.goodsReceiptItemId) ?? 0) - item.quantity);
    }
    await this.assertQuantities(tx, receipt, wanted, adjustmentId);
    const saved = (refundExpenses as RefundExpenseSnapshot[] | null) ?? [];
    await this.refundSnapshots(tx, receipt, saved, adjustmentId);
  }

  private async loadReceipt(tx: Prisma.TransactionClient, id: string, branchId: string, supplierId: string) {
    const receipt = await this.returns.findReceipt(id, tx);
    if (!receipt) throw invalidReference('phiếu nhập không tồn tại');
    if (receipt.branchId !== branchId) throw invalidReference('phiếu nhập thuộc chi nhánh khác');
    if (receipt.supplierId !== supplierId) throw badRequest('Phiếu nhập của nhà cung cấp khác');
    if (receipt.status !== ReceiptStatus.CONFIRMED) throw badRequest('Chỉ trả theo phiếu nhập đã nhập kho');
    return receipt;
  }

  /** Mỗi dòng trỏ đúng dòng nhập (cùng sản phẩm + số lô); gộp SL theo dòng nhập rồi so trần. */
  private async assertWithinReceived(
    tx: Prisma.TransactionClient,
    receipt: ReturnReceipt,
    lines: readonly ReturnLineInput[],
    excludeId: string | undefined,
  ): Promise<void> {
    const byId = new Map(receipt.items.map((i) => [i.id, i]));
    const wanted = new Map<string, number>();
    lines.forEach((l, index) => {
      const receiptItemId = l.item.goodsReceiptItemId;
      if (!receiptItemId) throw badRequest(`Dòng ${index + 1}: trả theo phiếu nhập phải chọn dòng nhập gốc`);
      const source = byId.get(receiptItemId);
      if (!source || source.productId !== l.batch.productId || source.batchNumber !== l.batch.batchNumber) {
        throw invalidReference(`dòng ${index + 1}: lô không khớp dòng phiếu nhập gốc`);
      }
      wanted.set(receiptItemId, (wanted.get(receiptItemId) ?? 0) + l.quantity);
    });
    await this.assertQuantities(tx, receipt, wanted, excludeId);
  }

  private async assertQuantities(
    tx: Prisma.TransactionClient,
    receipt: ReturnReceipt,
    wanted: Map<string, number>,
    excludeId: string | undefined,
  ): Promise<void> {
    const returned = await this.returns.returnedByReceiptItem([...wanted.keys()], excludeId, tx);
    for (const item of receipt.items) {
      const qty = wanted.get(item.id);
      if (qty === undefined) continue;
      const left = item.baseQuantity - (returned.get(item.id) ?? 0);
      if (qty > left) {
        throw badRequest(`${item.product.name} lô ${item.batchNumber}: trả ${qty} vượt số còn trả được (${Math.max(left, 0)})`);
      }
    }
  }

  /** Chi phí hoàn: theo `code` của chi phí NCC trên phiếu gốc, ≤ phần chưa hoàn ở các phiếu trả đã xác nhận khác. */
  private async refundSnapshots(
    tx: Prisma.TransactionClient,
    receipt: ReturnReceipt,
    requested: readonly { code: string; amount: number }[],
    excludeId: string | undefined,
  ): Promise<RefundExpenseSnapshot[]> {
    if (!requested.length) return [];
    const sources = ((receipt.expenses as ExpenseSnapshot[] | null) ?? []).filter((e) => e.kind === 'SUPPLIER');
    const refunded = await this.returns.refundedByCode(receipt.id, excludeId, tx);
    const seen = new Set<string>();
    return requested.map((r) => {
      if (seen.has(r.code)) throw badRequest(`Chi phí ${r.code} bị lặp`);
      seen.add(r.code);
      const source = sources.find((e) => e.code === r.code);
      if (!source) throw invalidReference(`chi phí ${r.code} không có trên phiếu nhập gốc`);
      const remaining = source.amount - (refunded.get(r.code) ?? 0);
      if (r.amount > remaining) throw badRequest(`${source.name}: hoàn ${r.amount} vượt phần còn hoàn được (${Math.max(remaining, 0)})`);
      return { code: source.code, name: source.name, receivedAmount: source.amount, amount: r.amount };
    });
  }
}
