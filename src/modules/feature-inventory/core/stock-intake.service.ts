import { Injectable } from '@nestjs/common';
import { BatchStatus, StockMovementType, StockRefType } from '@prisma/client';
import { randomUUID } from 'crypto';
import { ErrorCode } from 'src/common/types/error-code';
import { toDateOnlyString } from 'src/common/utils/date-only.util';
import { inventoryError } from './inventory.error';
import type { InventoryTxContext } from './inventory-transactions';
import { StockBatchRepository } from './stock-batch.repository';
import type { LockedBatch } from './stock-ledger.repository';
import { AppliedMovement, StockLedgerService } from './stock-ledger.service';

/** Một dòng hàng đưa vào kho, số lượng theo đơn vị cơ bản. */
export interface IntakeLine {
  productId: string;
  batchNumber: string;
  manufacturingDate: Date | null;
  expiryDate: Date;
  quantity: number;
  /** Giá vốn / đơn vị cơ bản của lần đưa vào này. */
  unitCost: number;
  /** Chỉ dùng khi lô được TẠO MỚI: NCC lần nhập đầu, dòng phiếu nhập đầu tiên. */
  supplierId: string | null;
  goodsReceiptItemId: string | null;
  /** Id dòng chứng từ, ghi vào `stock_movements.refItemId`. */
  refItemId: string;
}

export interface IntakeRequest {
  branchId: string;
  type: typeof StockMovementType.IMPORT | typeof StockMovementType.TRANSFER_IN;
  refType: StockRefType;
  refId: string;
  lines: readonly IntakeLine[];
  actorId: string;
}

export interface IntakeResult {
  /** `refItemId` → id lô nhận hàng (để điều chuyển ghi `toBatchId`). */
  batchIdByRefItem: Map<string, string>;
  movements: AppliedMovement[];
}

/** Một dòng hàng quay về ĐÚNG lô cũ (đã biết id), số lượng theo đơn vị cơ bản. */
export interface ReturnLine {
  batchId: string;
  quantity: number;
  /** Giá vốn / đơn vị cơ bản của phần hàng quay về (giá đã chốt lúc hàng rời lô). */
  unitCost: number;
  refItemId: string;
}

export interface ReturnRequest {
  type: StockMovementType;
  refType: StockRefType;
  refId: string;
  lines: readonly ReturnLine[];
  actorId: string;
  note: string;
}

/**
 * Đưa hàng vào lô — MỘT thuật toán cho cả xác nhận phiếu nhập và nhận điều chuyển:
 * tạo lô còn thiếu → khoá mọi lô liên quan → kiểm hạn dùng / trạng thái → giá vốn bình quân → ghi sổ.
 *
 * Luật K3 nằm DUY NHẤT ở đây: cùng số lô khác hạn dùng → 1703; lô đang khoá/thu hồi → 1704; cùng số lô khác giá →
 * gộp, giá vốn bình quân gia quyền. Số câu lệnh cố định: tạo (1) + khoá (1) + giá vốn (1) + sổ kho (2).
 * Lô trống chỉ từng nhận hàng từ phiếu đã huỷ thì được nhận hạn mới (sửa sai nhập liệu) — xem `reconcileExpiry`.
 * Caller phải đảm bảo mỗi (sản phẩm, số lô) chỉ xuất hiện một lần trong `lines`.
 */
@Injectable()
export class StockIntakeService {
  constructor(
    private readonly batches: StockBatchRepository,
    private readonly ledger: StockLedgerService,
  ) {}

  async intake(ctx: InventoryTxContext, request: IntakeRequest): Promise<IntakeResult> {
    const { tx } = ctx;
    if (!request.lines.length) return { batchIdByRefItem: new Map(), movements: [] };

    await this.batches.insertSkipExisting(
      tx,
      request.lines.map((line) => ({
        id: randomUUID(),
        branchId: request.branchId,
        productId: line.productId,
        batchNumber: line.batchNumber,
        manufacturingDate: line.manufacturingDate,
        expiryDate: line.expiryDate,
        importPrice: line.unitCost,
        supplierId: line.supplierId,
        goodsReceiptItemId: line.goodsReceiptItemId,
        createdBy: request.actorId,
      })),
    );
    const locked = await this.batches.lockByKey(
      tx,
      request.branchId,
      request.lines.map((line) => ({ productId: line.productId, batchNumber: line.batchNumber })),
    );
    const batchByKey = new Map(locked.map((batch) => [`${batch.productId}|${batch.batchNumber}`, batch]));
    await this.reconcileExpiry(tx, request, batchByKey);

    const costs: { id: string; importPrice: number }[] = [];
    const batchIdByRefItem = new Map<string, string>();
    const entries = request.lines.map((line) => {
      const batch = batchByKey.get(`${line.productId}|${line.batchNumber}`);
      if (!batch) throw new Error(`Không khoá được lô ${line.batchNumber} vừa tạo`);
      if (batch.status !== BatchStatus.AVAILABLE) {
        throw inventoryError(ErrorCode.BATCH_NOT_AVAILABLE, `lô ${line.batchNumber} đang ${batch.status}`);
      }
      costs.push({
        id: batch.id,
        importPrice: weightedAverageCost(batch.quantityOnHand, batch.importPrice, line.quantity, line.unitCost),
      });
      batchIdByRefItem.set(line.refItemId, batch.id);
      return {
        batchId: batch.id,
        type: request.type,
        quantity: line.quantity,
        unitCost: line.unitCost,
        refType: request.refType,
        refId: request.refId,
        refItemId: line.refItemId,
      };
    });

    await this.batches.updateCosts(tx, costs, request.actorId);
    const movements = await this.ledger.apply(ctx, entries, request.actorId, { preLocked: locked });
    return { batchIdByRefItem, movements };
  }

  /**
   * Hàng quay về đúng lô nó đã rời (vd. huỷ điều chuyển đang trên đường). Cũng là một lần "đưa thêm hàng vào lô" nên
   * giá vốn phải bình quân lại: trong lúc hàng đi vắng, lô có thể đã nhận thêm hàng giá khác. Không kiểm trạng thái hay
   * hạn dùng của lô — hàng của chính lô đó luôn phải về sổ, kể cả khi lô vừa bị khoá/thu hồi.
   * Số câu lệnh cố định: khoá (1) + giá vốn (1) + sổ kho (2).
   */
  async returnToBatches(ctx: InventoryTxContext, request: ReturnRequest): Promise<AppliedMovement[]> {
    if (!request.lines.length) return [];
    const batchIds = request.lines.map((line) => line.batchId);
    const locked = await this.ledger.lockBatches(ctx, batchIds);
    const batchById = new Map(locked.map((batch) => [batch.id, batch]));

    const costs = request.lines.map((line) => {
      const batch = batchById.get(line.batchId);
      if (!batch) throw new Error(`Không khoá được lô ${line.batchId} để hoàn hàng`);
      return {
        id: batch.id,
        importPrice: weightedAverageCost(batch.quantityOnHand, batch.importPrice, line.quantity, line.unitCost),
      };
    });
    await this.batches.updateCosts(ctx.tx, costs, request.actorId);

    return this.ledger.apply(
      ctx,
      request.lines.map((line) => ({
        batchId: line.batchId,
        type: request.type,
        quantity: line.quantity,
        unitCost: line.unitCost,
        refType: request.refType,
        refId: request.refId,
        refItemId: line.refItemId,
        note: request.note,
      })),
      request.actorId,
      { preLocked: locked },
    );
  }

  /**
   * K3 — cùng số lô khác hạn dùng → 1703. Ngoại lệ duy nhất là sửa sai nhập liệu: lô đang trống và CHỈ từng nhận hàng
   * từ phiếu nhập (mọi phiếu đó đã huỷ, tồn về 0) thì hạn cũ chưa từng "có thật" — nhận hạn/NSX của lần nhập này.
   * Lô từng bán, chuyển hay điều chỉnh giữ nguyên hạn đã ghi. Thêm tối đa 2 câu lệnh, chỉ khi có dòng lệch hạn.
   */
  private async reconcileExpiry(
    tx: InventoryTxContext['tx'],
    request: IntakeRequest,
    batchByKey: Map<string, LockedBatch>,
  ): Promise<void> {
    const mismatched = request.lines.flatMap((line) => {
      const batch = batchByKey.get(`${line.productId}|${line.batchNumber}`);
      return batch && toDateOnlyString(batch.expiryDate) !== toDateOnlyString(line.expiryDate) ? [{ line, batch }] : [];
    });
    if (!mismatched.length) return;

    const reject = ({ line, batch }: (typeof mismatched)[number]) =>
      inventoryError(
        ErrorCode.BATCH_EXPIRY_MISMATCH,
        `lô ${line.batchNumber} đang có hạn ${toDateOnlyString(batch.expiryDate)}`,
      );
    const stocked = mismatched.find(({ batch }) => batch.quantityOnHand > 0);
    if (stocked) throw reject(stocked);

    const used = await this.batches.findWithNonImportMovements(
      tx,
      mismatched.map(({ batch }) => batch.id),
    );
    const established = mismatched.find(({ batch }) => used.has(batch.id));
    if (established) throw reject(established);

    await this.batches.resetDates(
      tx,
      mismatched.map(({ line, batch }) => ({
        id: batch.id,
        expiryDate: toDateOnlyString(line.expiryDate),
        manufacturingDate: line.manufacturingDate ? toDateOnlyString(line.manufacturingDate) : null,
      })),
      request.actorId,
    );
  }
}

/**
 * K3: đưa thêm hàng vào lô đang có → giá vốn bình quân gia quyền, làm tròn về đồng. Lô đang trống (tồn 0) thì giá
 * mới là giá của lần đưa vào này.
 */
export function weightedAverageCost(onHand: number, currentCost: number, addQuantity: number, addCost: number): number {
  const total = onHand + addQuantity;
  if (total <= 0) return addCost;
  return Math.round((onHand * currentCost + addQuantity * addCost) / total);
}
