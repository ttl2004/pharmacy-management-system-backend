import { Injectable } from '@nestjs/common';
import { AuditAction, BatchStatus, StockMovementType, StockRefType } from '@prisma/client';
import { randomUUID } from 'crypto';
import { ErrorCode } from 'src/common/types/error-code';
import { toDateOnlyString } from 'src/common/utils/date-only.util';
import { CHAIN_WIDE_ROLES } from 'src/modules/feature-auth/permission/branch-scope';
import { AuditLogService } from 'src/providers/audit-log/audit-log.service';
import { inventoryError } from './inventory.error';
import type { InventoryTxContext } from './inventory-transactions';
import { AUDIT_ENTITY } from './inventory.constants';
import { IntakeBatch, StockBatchRepository } from './stock-batch.repository';
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

/** Rút lại đúng phần hàng một chứng từ đã đưa vào lô (huỷ phiếu nhập) — lấy từ chính bút toán nhập. */
export interface WithdrawLine {
  batchId: string;
  /** Dương, theo đơn vị cơ bản. */
  quantity: number;
  /** Giá vốn ghi trên bút toán nhập; bút toán nhập luôn có, `null` là dữ liệu hỏng. */
  unitCost: number | null;
  refItemId: string | null;
}

export interface WithdrawRequest extends Omit<ReturnRequest, 'lines'> {
  lines: readonly WithdrawLine[];
  /** Lô caller đã khoá (để kiểm "chưa xuất") — tồn trong đó là tồn TRƯỚC khi rút. */
  locked: readonly LockedBatch[];
}

/**
 * Đưa hàng vào lô — MỘT thuật toán cho cả xác nhận phiếu nhập và nhận điều chuyển:
 * khoá số lô → tạo lô còn thiếu → khoá mọi lô liên quan → kiểm hạn dùng / trạng thái → giá vốn bình quân → ghi sổ.
 *
 * Luật K3 nằm DUY NHẤT ở đây: cùng số lô khác hạn dùng → 1703; lô đang cách ly → 1704; cùng số lô khác giá →
 * gộp, giá vốn bình quân gia quyền. Lô bị thu hồi vẫn nhận hàng và giữ RECALLED; lô vừa tạo thừa hưởng thu hồi của
 * cùng số lô ở chi nhánh khác (`inheritRecalls`). Số câu lệnh cố định: khoá số lô (1) + tạo (1) + khoá lô (1) +
 * giá vốn (1) + sổ kho (2).
 * Lô trống chỉ từng nhận hàng từ phiếu đã huỷ thì được nhận hạn mới (sửa sai nhập liệu) — xem `reconcileExpiry`.
 * Caller phải đảm bảo mỗi (sản phẩm, số lô) chỉ xuất hiện một lần trong `lines`.
 */
@Injectable()
export class StockIntakeService {
  constructor(
    private readonly batches: StockBatchRepository,
    private readonly ledger: StockLedgerService,
    private readonly audit: AuditLogService,
  ) {}

  async intake(ctx: InventoryTxContext, request: IntakeRequest): Promise<IntakeResult> {
    const { tx } = ctx;
    if (!request.lines.length) return { batchIdByRefItem: new Map(), movements: [] };

    const keys = request.lines.map((line) => ({ productId: line.productId, batchNumber: line.batchNumber }));
    await this.batches.lockBatchNumbers(tx, keys);
    const newRows = request.lines.map((line) => ({
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
    }));
    await this.batches.insertSkipExisting(tx, newRows);
    const locked = await this.batches.lockByKey(tx, request.branchId, keys, CHAIN_WIDE_ROLES);
    const batchByKey = new Map(locked.map((batch) => [`${batch.productId}|${batch.batchNumber}`, batch]));
    await this.reconcileExpiry(tx, request, batchByKey);
    await this.inheritRecalls(tx, locked, new Set(newRows.map((row) => row.id)), request.actorId);

    const costs: { id: string; importPrice: number }[] = [];
    const batchIdByRefItem = new Map<string, string>();
    const entries = request.lines.map((line) => {
      const batch = batchByKey.get(`${line.productId}|${line.batchNumber}`);
      if (!batch) throw new Error(`Không khoá được lô ${line.batchNumber} vừa tạo`);
      // Lô thu hồi vẫn nhận hàng (tồn phải đúng thực tế) và không bán được; chỉ lô đang cách ly mới từ chối.
      if (batch.status === BatchStatus.QUARANTINE) {
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
   * Ngược của `intake`: rút phần hàng chứng từ đã đưa vào và trả giá vốn về như chưa từng nhập. Caller phải bảo đảm
   * lô chưa có hàng XUẤT ra kể từ lần nhập (K4) — khi đó giá bình quân chỉ là tổng giá trị chia tổng lượng, nên rút
   * ra là phép tính ngược chính xác (lệch tối đa vài đồng do làm tròn), kể cả khi lô đã nhận thêm hàng sau đó.
   * Số câu lệnh cố định: giá vốn (1) + sổ kho (2).
   */
  async withdraw(ctx: InventoryTxContext, request: WithdrawRequest): Promise<AppliedMovement[]> {
    if (!request.lines.length) return [];
    const batchById = new Map(request.locked.map((batch) => [batch.id, batch]));

    // Một lô có thể nhận nhiều dòng của cùng phiếu: gộp lượng và giá trị trước khi tính ngược.
    const removedByBatch = new Map<string, { quantity: number; value: number }>();
    for (const line of request.lines) {
      if (line.unitCost === null) throw new Error(`Bút toán nhập của lô ${line.batchId} thiếu giá vốn`);
      const removed = removedByBatch.get(line.batchId) ?? { quantity: 0, value: 0 };
      removed.quantity += line.quantity;
      removed.value += line.quantity * line.unitCost;
      removedByBatch.set(line.batchId, removed);
    }
    const costs = [...removedByBatch].map(([batchId, removed]) => {
      const batch = batchById.get(batchId);
      if (!batch) throw new Error(`Lô ${batchId} chưa được khoá trước khi rút hàng`);
      return { id: batchId, importPrice: costAfterWithdraw(batch.quantityOnHand, batch.importPrice, removed) };
    });
    await this.batches.updateCosts(ctx.tx, costs, request.actorId);

    return this.ledger.apply(
      ctx,
      request.lines.map((line) => ({
        batchId: line.batchId,
        type: request.type,
        quantity: -line.quantity,
        unitCost: line.unitCost,
        refType: request.refType,
        refId: request.refId,
        refItemId: line.refItemId,
        note: request.note,
      })),
      request.actorId,
      { preLocked: request.locked },
    );
  }

  /**
   * Thu hồi gắn với SỐ LÔ chứ không với từng dòng lô: lô VỪA TẠO ở chi nhánh này mà cùng số lô đã bị ADMIN thu hồi ở
   * chi nhánh khác (vd. nhận điều chuyển đang trên đường lúc thu hồi) thì cũng bị thu hồi, cùng lý do và người thu hồi.
   * Lô đã có từ trước giữ trạng thái của nó — thu hồi lô đó là quyết định riêng. Thêm 2 câu lệnh (đổi trạng thái +
   * nhật ký), chỉ khi có lô phải thu hồi.
   */
  private async inheritRecalls(
    tx: InventoryTxContext['tx'],
    locked: readonly IntakeBatch[],
    createdIds: ReadonlySet<string>,
    actorId: string,
  ): Promise<void> {
    const recalls = locked.flatMap((batch) =>
      createdIds.has(batch.id) && batch.recallReason && batch.recalledBy
        ? [{ batch, reason: batch.recallReason, recalledBy: batch.recalledBy }]
        : [],
    );
    if (!recalls.length) return;

    await this.batches.markRecalled(
      tx,
      recalls.map(({ batch, reason, recalledBy }) => ({ id: batch.id, reason, recalledBy })),
      actorId,
    );
    await this.audit.record(
      tx,
      recalls.map(({ batch, reason }) => ({
        actorId,
        action: AuditAction.STATUS_CHANGE,
        entityType: AUDIT_ENTITY.STOCK_BATCH,
        entityId: batch.id,
        branchId: batch.branchId,
        before: { status: batch.status },
        // Người nhận hàng không chủ động thu hồi: ghi rõ đây là thừa hưởng quyết định của ai.
        after: { status: BatchStatus.RECALLED, inheritedRecallBy: batch.recalledBy },
        reason,
      })),
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

/**
 * Ngược của `weightedAverageCost`: giá vốn sau khi rút `removed` (lượng + tổng giá trị lúc nhập) khỏi lô. Lô về 0 thì
 * giữ giá hiện tại — vô hại vì lần nhập kế tiếp vào lô trống lấy thẳng giá mới. Không âm (phòng sai số làm tròn).
 */
export function costAfterWithdraw(
  onHand: number,
  currentCost: number,
  removed: { quantity: number; value: number },
): number {
  const remaining = onHand - removed.quantity;
  if (remaining <= 0) return currentCost;
  return Math.max(0, Math.round((onHand * currentCost - removed.value) / remaining));
}
