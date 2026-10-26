import { Injectable } from '@nestjs/common';
import { BatchStatus, StockMovementType, StockRefType } from '@prisma/client';
import { ErrorCode } from 'src/common/types/error-code';
import { daysBetweenDateOnly, toDateOnlyString, todayInVietnam } from 'src/common/utils/date-only.util';
import type { InventoryTxContext } from 'src/modules/feature-inventory/core/inventory-transactions';
import { inventoryError } from 'src/modules/feature-inventory/core/inventory.error';
import { StockAllocationService } from 'src/modules/feature-inventory/core/stock-allocation.service';
import { StockIntakeService } from 'src/modules/feature-inventory/core/stock-intake.service';
import type { LockedBatch } from 'src/modules/feature-inventory/core/stock-ledger.repository';
import { ReservationRef, StockLedgerService } from 'src/modules/feature-inventory/core/stock-ledger.service';
import { OrderStockRepository } from './order-stock.repository';

export interface ReserveItem {
  orderItemId: string;
  productId: string;
  /** Theo đơn vị cơ bản — chính là số sẽ bị trừ khỏi kho. */
  baseQuantity: number;
}

export interface ReserveRequest {
  orderId: string;
  branchId: string;
  actorId: string;
  items: readonly ReserveItem[];
}

const orderRef = (orderId: string): ReservationRef => ({ refType: StockRefType.ORDER, refId: orderId });

/** Lô đã giữ vẫn phải bán được lúc trừ kho: có thể đã bị khoá/thu hồi hoặc qua hạn trong lúc đơn chờ. */
function assertStillSellable(batch: LockedBatch, today: string): void {
  if (batch.status !== BatchStatus.AVAILABLE) {
    throw inventoryError(
      ErrorCode.BATCH_NOT_AVAILABLE,
      `lô ${batch.batchNumber} đang ${batch.status} — sửa đơn để chọn lô khác`,
    );
  }
  if (daysBetweenDateOnly(today, toDateOnlyString(batch.expiryDate)) <= 0) {
    throw inventoryError(ErrorCode.BATCH_NOT_AVAILABLE, `lô ${batch.batchNumber} đã hết hạn — sửa đơn để chọn lô khác`);
  }
}

/**
 * Vòng đời kho của MỘT đơn hàng: giữ (tạo đơn) → trừ (hàng rời cửa hàng) hoặc nhả (huỷ). Chỉ gọi `StockAllocationService` và
 * `StockLedgerService` — module bán hàng không tự đụng tồn. `order_item_batches` là danh sách "đã giữ ở lô nào, bao nhiêu",
 * nên trừ và nhả luôn đúng lô đã giữ.
 */
@Injectable()
export class OrderStockService {
  constructor(
    private readonly allocator: StockAllocationService,
    private readonly ledger: StockLedgerService,
    private readonly repository: OrderStockRepository,
    private readonly intake: StockIntakeService,
  ) {}

  /** Chọn lô FEFO + giữ hàng + ghi phân bổ: 3 câu lệnh cho cả đơn. Thiếu hàng → 1700 (caller rollback cả đơn). */
  async reserve(ctx: InventoryTxContext, request: ReserveRequest, today: string = todayInVietnam()): Promise<void> {
    const { allocations, locked } = await this.allocator.allocateFefo(
      ctx,
      request.branchId,
      request.items.map((item) => ({ productId: item.productId, quantity: item.baseQuantity })),
      today,
    );
    await this.ledger.reserve(
      ctx,
      allocations.map((part) => ({ batchId: part.batchId, quantity: part.quantity })),
      orderRef(request.orderId),
      request.actorId,
      { preLocked: locked },
    );
    await this.repository.insertAllocations(
      ctx.tx,
      allocations.map((part) => ({
        orderItemId: request.items[part.lineIndex].orderItemId,
        batchId: part.batchId,
        quantity: part.quantity,
        // Giá vốn tạm lúc giữ; chốt lại bằng giá vốn hiện tại của lô lúc trừ kho (`consume`).
        unitCost: part.unitCost,
      })),
    );
  }

  /** Huỷ đơn: nhả toàn bộ phần đang giữ. Phân bổ giữ lại làm lịch sử "đơn từng giữ hàng ở đâu". */
  async release(ctx: InventoryTxContext, orderId: string, actorId: string): Promise<void> {
    const rows = await this.repository.findAllocations(ctx.tx, orderId);
    await this.ledger.release(
      ctx,
      rows.map((row) => ({ batchId: row.batchId, quantity: row.quantity })),
      orderRef(orderId),
      actorId,
    );
  }

  /**
   * Huỷ hoá đơn ĐÃ THU: hàng quay về đúng các lô đã bán (`RETURN_IN`) với giá vốn đã chốt lúc bán — bình quân lại giá
   * vốn lô qua `returnToBatches`. Phân bổ giữ nguyên làm lịch sử.
   */
  async restock(ctx: InventoryTxContext, orderId: string, actorId: string, note: string): Promise<void> {
    const rows = await this.repository.findAllocations(ctx.tx, orderId);
    await this.intake.returnToBatches(ctx, {
      type: StockMovementType.RETURN_IN,
      refType: StockRefType.ORDER,
      refId: orderId,
      actorId,
      note,
      lines: rows.map((row) => ({ batchId: row.batchId, quantity: row.quantity, unitCost: row.unitCost, refItemId: row.id })),
    });
  }

  /** Sửa đơn PENDING: nhả rồi xoá phân bổ — caller sẽ chọn lô lại cho danh sách dòng mới. */
  async discard(ctx: InventoryTxContext, orderId: string, actorId: string): Promise<void> {
    await this.release(ctx, orderId, actorId);
    await this.repository.deleteAllocations(ctx.tx, orderId);
  }

  /**
   * Hàng rời cửa hàng: trừ kho từ phần đã giữ (`SALE`, `fromReserved`), chốt giá vốn bằng giá vốn hiện tại của lô — lô có thể
   * đã nhập thêm hàng giá khác trong lúc đơn chờ. 5 câu lệnh cho cả đơn.
   */
  async consume(
    ctx: InventoryTxContext,
    orderId: string,
    actorId: string,
    today: string = todayInVietnam(),
  ): Promise<void> {
    const rows = await this.repository.findAllocations(ctx.tx, orderId);
    if (!rows.length) throw new Error(`Đơn ${orderId} không có phân bổ lô để trừ kho`);

    const locked = await this.ledger.lockBatches(
      ctx,
      rows.map((row) => row.batchId),
    );
    const batchById = new Map(locked.map((batch) => [batch.id, batch]));
    const batchOf = (batchId: string): LockedBatch => {
      const batch = batchById.get(batchId);
      if (!batch) throw new Error(`Lô ${batchId} của đơn ${orderId} không còn tồn tại`);
      return batch;
    };
    for (const row of rows) assertStillSellable(batchOf(row.batchId), today);

    await this.repository.setUnitCosts(
      ctx.tx,
      rows.map((row) => ({ id: row.id, unitCost: batchOf(row.batchId).importPrice })),
    );
    await this.ledger.apply(
      ctx,
      rows.map((row) => ({
        batchId: row.batchId,
        type: StockMovementType.SALE,
        quantity: -row.quantity,
        unitCost: batchOf(row.batchId).importPrice,
        refType: StockRefType.ORDER,
        refId: orderId,
        refItemId: row.id,
        fromReserved: true,
      })),
      actorId,
      { preLocked: locked },
    );
  }
}
