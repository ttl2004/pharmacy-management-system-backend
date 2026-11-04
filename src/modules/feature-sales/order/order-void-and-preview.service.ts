import { Injectable } from '@nestjs/common';
import {
  OrderChannel,
  OrderStatus,
  PaymentKind,
  PaymentMethod,
  PaymentStatus,
  TransactionStatus,
} from '@prisma/client';
import { badRequest } from 'src/modules/feature-inventory/core/inventory.error';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { toDateOnlyString } from 'src/common/utils/date-only.util';
import { resolveBranchScope } from 'src/modules/feature-auth/permission/branch-scope';
import { branchWhere, resolveWriteBranch } from 'src/modules/feature-inventory/core/inventory-scope';
import { InventoryTransactions } from 'src/modules/feature-inventory/core/inventory-transactions';
import { StockAllocationService } from 'src/modules/feature-inventory/core/stock-allocation.service';
import { PriceBookService } from 'src/modules/feature-catalog/price-book/price-book.service';
import { auditActorOf } from 'src/providers/audit-log/audit-actor';
import { AuditLogService } from 'src/providers/audit-log/audit-log.service';
import type { AuditEntry } from 'src/providers/audit-log/audit-log.types';
import { bookPriceOf, buildOrderLines, toBookPricing } from '../core/order-lines';
import { OrderStockService } from '../core/order-stock.service';
import { SALES_AUDIT_ENTITY } from '../core/sales.constants';
import { orderErrors } from '../core/sales.error';
import { PreviewAllocationRequest, VoidPaidOrderRequest } from './dtos/order.request';
import { OrderDetail, OrderRepository } from './repositories/order.repository';

/**
 * Thao tác sau bán của đơn tại quầy (như mock):
 * - Huỷ hoá đơn ĐÃ THU: COMPLETED → CANCELLED, tiền về REFUNDED, hàng quay về đúng lô đã bán (`RETURN_IN`).
 * - Xem trước lô FEFO cho giỏ hàng — chỉ đọc, không giữ hàng.
 */
@Injectable()
export class OrderVoidAndPreviewService {
  constructor(
    private readonly orders: OrderRepository,
    private readonly transactions: InventoryTransactions,
    private readonly stock: OrderStockService,
    private readonly allocator: StockAllocationService,
    private readonly audit: AuditLogService,
    private readonly priceBooks: PriceBookService,
  ) {}

  /** Chiếm đơn bằng cập nhật có điều kiện COMPLETED trước khi đụng kho — bấm đúp → 1701. */
  async voidPaid(id: string, dto: VoidPaidOrderRequest, actor: RequestActor): Promise<OrderDetail> {
    const scope = resolveBranchScope(actor.user);
    const actorId = actor.user.userId;
    const now = new Date();

    return this.transactions.run(async (ctx) => {
      const { tx } = ctx;
      const head = await this.orders.findHead(tx, id, branchWhere(scope));
      if (!head) throw orderErrors.notFound();
      if (head.channel !== OrderChannel.POS || head.status !== OrderStatus.COMPLETED) {
        throw orderErrors.wrongState(head.status);
      }
      // Kiểm tiền hoàn TRƯỚC khi chiếm đơn và trả hàng về kho: lỗi thì không đụng gì.
      const refund = this.refundOf(head.totalAmount, dto);
      const claimed = await this.orders.claim(
        tx,
        id,
        { status: OrderStatus.COMPLETED, channel: OrderChannel.POS },
        {
          status: OrderStatus.CANCELLED,
          paymentStatus: PaymentStatus.REFUNDED,
          cancelReason: dto.reason,
          cancelledAt: now,
          updatedAt: now,
          updatedBy: actorId,
        },
      );
      if (!claimed) throw orderErrors.wrongState();
      await this.stock.restock(ctx, id, actorId, `Huỷ hoá đơn: ${dto.reason}`);
      if (refund) {
        await this.orders.createPayment(tx, {
          orderId: id,
          kind: PaymentKind.REFUND,
          method: refund.method,
          amount: refund.amount,
          status: TransactionStatus.SUCCESS,
          paidAt: now,
          updatedAt: now,
          note: dto.reason,
          createdBy: actorId,
        });
      }

      // Cả hai dòng mang lý do huỷ của người thao tác (bắt buộc) và cùng nhãn/từ khoá = mã đơn (D8).
      const common = {
        entityType: SALES_AUDIT_ENTITY.ORDER,
        entityId: id,
        entityLabel: head.code,
        branchIds: [head.branchId],
        searchTerms: [head.code],
        amount: head.totalAmount,
        reason: dto.reason,
      };
      const entries: AuditEntry[] = [
        {
          event: 'ORDER.VOID_PAID',
          ...common,
          before: { status: OrderStatus.COMPLETED, paymentStatus: PaymentStatus.PAID },
          after: { status: OrderStatus.CANCELLED, paymentStatus: PaymentStatus.REFUNDED },
        },
      ];
      // Đơn 0đ không có lượt thu nào (xem `payPos`) nên không có tiền để hoàn.
      if (refund) {
        // Hoàn ít hơn tổng mà hàng vẫn về kho đủ → nổi bật (severity 2) để quản lý soát.
        const partial = refund.amount < head.totalAmount;
        entries.push({
          event: 'PAYMENT.REFUNDED',
          ...common,
          amount: refund.amount,
          severity: partial ? 2 : 1,
          after: { paymentStatus: PaymentStatus.REFUNDED, refundedAmount: refund.amount.toString() },
          metadata: {
            totalAmount: head.totalAmount.toString(),
            refundAmount: refund.amount.toString(),
            ...(partial ? { partialRefund: true } : {}),
          },
        });
      }
      await this.audit.record(tx, auditActorOf(actor), entries);
      const order = await this.orders.findDetail(id, {}, tx);
      if (!order) throw orderErrors.notFound();
      return order;
    });
  }

  /** Đơn > 0đ: `0 < refundAmount ≤ tổng` + hình thức hoàn; đơn 0đ: không được gửi tiền hoàn. */
  private refundOf(total: bigint, dto: VoidPaidOrderRequest): { amount: bigint; method: PaymentMethod } | null {
    if (total === 0n) {
      if (dto.refundAmount) throw badRequest('Đơn 0đ không có tiền để hoàn');
      return null;
    }
    if (!dto.refundAmount || dto.refundAmount <= 0) throw badRequest('Cần nhập số tiền đã hoàn cho khách (lớn hơn 0)');
    const amount = BigInt(dto.refundAmount);
    if (amount > total) throw badRequest('Số tiền hoàn không được vượt tổng hoá đơn');
    if (!dto.refundMethod) throw badRequest('Cần chọn hình thức hoàn tiền');
    return { amount, method: dto.refundMethod };
  }

  /**
   * Lô FEFO dự kiến cho từng dòng giỏ: `{productUnitId, productId, baseQuantity, allocations[{batchId, batchNumber,
   * expiryDate, quantity}], availableQuantity, shortfall}`. Dòng không bán được → 1801 như lúc lập đơn.
   */
  async preview(dto: PreviewAllocationRequest, actor: RequestActor) {
    const branchId = resolveWriteBranch(resolveBranchScope(actor.user), dto.branchId);
    return this.transactions.run(async (ctx) => {
      const units = await this.orders.findSellableUnits(
        ctx.tx,
        dto.items.map((i) => i.productUnitId),
      );
      // Bảng giá không dùng được -> 1802; hàng ngoài bảng BLOCK -> 1803 như lúc lập đơn.
      const book = dto.priceBookId
        ? toBookPricing(await this.priceBooks.getUsableBook(dto.priceBookId, branchId, actor.user.userId))
        : undefined;
      const lines = buildOrderLines(dto.items, units, book);
      const { allocations, shortages, batches } = await this.allocator.previewFefo(
        ctx,
        branchId,
        lines.map((l) => ({ productId: l.productId, quantity: l.baseQuantity })),
      );
      const batchById = new Map(batches.map((b) => [b.id, b]));
      const freeOf = (productId: string) =>
        batches
          .filter((b) => b.productId === productId)
          .reduce((sum, b) => sum + b.quantityOnHand - b.reservedQuantity, 0);
      return lines.map((line, index) => ({
        productUnitId: line.productUnitId,
        productId: line.productId,
        baseQuantity: line.baseQuantity,
        unitPrice: line.unitPrice,
        bookPrice: bookPriceOf(book, line.productUnitId),
        outOfBook: !!book && bookPriceOf(book, line.productUnitId) === null,
        allocations: allocations
          .filter((a) => a.lineIndex === index)
          .map((a) => {
            const batch = batchById.get(a.batchId);
            return {
              batchId: a.batchId,
              batchNumber: batch?.batchNumber ?? '',
              expiryDate: batch ? toDateOnlyString(batch.expiryDate) : null,
              quantity: a.quantity,
            };
          }),
        availableQuantity: freeOf(line.productId),
        shortfall: shortages[index] ?? 0,
      }));
    });
  }
}
