import { Injectable } from '@nestjs/common';
import { StockMovementType, StockRefType } from '@prisma/client';
import { ErrorCode } from 'src/common/types/error-code';
import { InventoryEvents } from './inventory-events';
import { inventoryError } from './inventory.error';
import type { InventoryTxContext } from './inventory-transactions';
import { LockedBatch, MovementRow, StockLedgerRepository } from './stock-ledger.repository';

/** Một bút toán caller muốn ghi. Chi nhánh và sản phẩm lấy từ chính lô, caller không tự khai (tránh khai lệch). */
export interface LedgerEntry {
  batchId: string;
  type: StockMovementType;
  /** Delta có dấu theo đơn vị cơ bản: nhập dương, xuất âm. Khác 0. */
  quantity: number;
  unitCost: number | null;
  refType: StockRefType;
  refId: string;
  refItemId?: string | null;
  note?: string | null;
  /**
   * Hàng xuất ra từ phần đã giữ cho đơn online: phần giữ của lô giảm đúng bằng lượng xuất, trong cùng câu lệnh trừ
   * tồn. Chỉ dùng cho bút toán xuất (`quantity` âm).
   */
  fromReserved?: boolean;
}

/** Một dòng giữ/nhả hàng: `quantity` dương theo đơn vị cơ bản. */
export interface ReservationLine {
  batchId: string;
  quantity: number;
}

/** Chứng từ gây ra việc giữ/nhả — đi theo sự kiện tồn kho. */
export interface ReservationRef {
  refType: StockRefType;
  refId: string;
}

export interface AppliedMovement extends LedgerEntry {
  branchId: string;
  productId: string;
  balanceAfter: number;
}

export interface ApplyOptions {
  /** Lô caller đã khoá bằng `lockBatches` trong cùng transaction — bỏ qua bước khoá lại (đỡ một lượt DB). */
  preLocked?: readonly LockedBatch[];
}

/**
 * Chỗ DUY NHẤT được thay đổi `stock_batches.quantityOnHand`, `reservedQuantity` và ghi `stock_movements`. Tồn và
 * sổ luôn đi chung một transaction, nên sổ kho (nguồn chân lý) và tồn cache không thể lệch nhau. Không có API "sửa tồn" nào khác:
 * sai thì ghi bút toán điều chỉnh.
 *
 * Mỗi lần `apply` tốn đúng 3 câu lệnh (khoá lô, cập nhật tồn, ghi sổ) bất kể số bút toán.
 *
 * Ledger KHÔNG kiểm trạng thái lô (khoá/thu hồi) hay hạn dùng: huỷ lô bị thu hồi hay đảo phiếu nhập vẫn phải
 * ghi được vào lô RECALLED. Luật "được xuất lô nào" thuộc về nghiệp vụ gọi tới — xem `lockBatches`.
 */
@Injectable()
export class StockLedgerService {
  constructor(
    private readonly repository: StockLedgerRepository,
    private readonly events: InventoryEvents,
  ) {}

  /** Khoá lô theo thứ tự id để kiểm trạng thái/tồn trước khi ghi; truyền kết quả vào `apply` qua `preLocked`. */
  lockBatches(ctx: InventoryTxContext, batchIds: readonly string[]): Promise<LockedBatch[]> {
    return this.repository.lockBatches(ctx.tx, [...new Set(batchIds)]);
  }

  async apply(
    ctx: InventoryTxContext,
    entries: readonly LedgerEntry[],
    actorId: string,
    options: ApplyOptions = {},
  ): Promise<AppliedMovement[]> {
    if (!entries.length) return [];
    for (const entry of entries) {
      if (!Number.isInteger(entry.quantity) || entry.quantity === 0) {
        throw new Error(`Bút toán kho phải là số nguyên khác 0 (lô ${entry.batchId}, ${entry.quantity})`);
      }
      if (entry.fromReserved && entry.quantity > 0) {
        throw new Error(`Chỉ bút toán xuất mới lấy từ phần đã giữ (lô ${entry.batchId})`);
      }
    }

    const deltaByBatch = new Map<string, number>();
    const reservedDeltaByBatch = new Map<string, number>();
    for (const entry of entries) {
      deltaByBatch.set(entry.batchId, (deltaByBatch.get(entry.batchId) ?? 0) + entry.quantity);
      if (entry.fromReserved) {
        reservedDeltaByBatch.set(entry.batchId, (reservedDeltaByBatch.get(entry.batchId) ?? 0) + entry.quantity);
      }
    }

    const locked = options.preLocked ?? (await this.repository.lockBatches(ctx.tx, [...deltaByBatch.keys()]));
    const batchById = new Map(locked.map((batch) => [batch.id, batch]));
    const missing = [...deltaByBatch.keys()].filter((id) => !batchById.has(id));
    if (missing.length) throw new Error(`Lô không tồn tại hoặc chưa được khoá: ${missing.join(', ')}`);

    // Lô có tổng delta = 0 (vd vừa +5 vừa -5) và không đụng phần giữ thì không cần UPDATE, nhưng vẫn ghi đủ bút toán.
    const changed = [...deltaByBatch]
      .map(([batchId, delta]) => ({ batchId, delta, reservedDelta: reservedDeltaByBatch.get(batchId) ?? 0 }))
      .filter((item) => item.delta !== 0 || item.reservedDelta !== 0);
    const updated = await this.repository.applyDeltas(ctx.tx, changed, actorId);
    if (updated.length !== changed.length) {
      const ok = new Set(updated.map((row) => row.id));
      const short = changed
        .filter((item) => !ok.has(item.batchId))
        .map((item) => batchById.get(item.batchId)?.batchNumber ?? item.batchId)
        .join(', ');
      throw inventoryError(ErrorCode.INSUFFICIENT_STOCK, `lô ${short}`);
    }

    const finalById = new Map(updated.map((row) => [row.id, row.quantityOnHand]));
    // Số dư chạy theo thứ tự bút toán: điểm xuất phát = tồn cuối − tổng delta của lô.
    const runningById = new Map(
      [...deltaByBatch].map(([id, delta]) => [id, (finalById.get(id) ?? batchById.get(id)!.quantityOnHand) - delta]),
    );

    const applied: AppliedMovement[] = entries.map((entry) => {
      const batch = batchById.get(entry.batchId)!;
      const balanceAfter = runningById.get(entry.batchId)! + entry.quantity;
      runningById.set(entry.batchId, balanceAfter);
      return { ...entry, branchId: batch.branchId, productId: batch.productId, balanceAfter };
    });

    await this.repository.insertMovements(
      ctx.tx,
      applied.map((movement): MovementRow => ({
        branchId: movement.branchId,
        productId: movement.productId,
        batchId: movement.batchId,
        type: movement.type,
        quantity: movement.quantity,
        balanceAfter: movement.balanceAfter,
        unitCost: movement.unitCost,
        refType: movement.refType,
        refId: movement.refId,
        refItemId: movement.refItemId ?? null,
        note: movement.note ?? null,
        createdBy: actorId,
      })),
    );

    this.scheduleStockChanged(ctx, applied, applied[0]);
    return applied;
  }

  /**
   * Giữ hàng cho đơn online: lượng bán được giảm, tồn không đổi, không ghi sổ kho — khoá lô (bỏ qua nếu `preLocked`)
   * + MỘT câu UPDATE. Lô không đủ `tồn − đang giữ` → 1700. Như `apply`, không kiểm trạng thái/hạn dùng: chọn lô nào
   * là việc của caller (`StockAllocationService.allocateFefo`, kết quả khoá của nó truyền vào `preLocked`).
   */
  async reserve(
    ctx: InventoryTxContext,
    lines: readonly ReservationLine[],
    ref: ReservationRef,
    actorId: string,
    options: ApplyOptions = {},
  ): Promise<void> {
    const failed = await this.changeReservations(ctx, lines, 1, actorId, ref, options);
    if (failed.length) {
      throw inventoryError(ErrorCode.INSUFFICIENT_STOCK, `không giữ đủ hàng ở lô ${failed.join(', ')}`);
    }
  }

  /**
   * Nhả phần đã giữ (huỷ đơn, đơn quá hạn thanh toán). Nhả nhiều hơn phần đang giữ là lỗi lập trình — đơn chỉ nhả
   * đúng lượng nó đã giữ. Xuất hàng của đơn đã giữ KHÔNG đi qua đây mà qua `apply` với `fromReserved`.
   */
  async release(
    ctx: InventoryTxContext,
    lines: readonly ReservationLine[],
    ref: ReservationRef,
    actorId: string,
    options: ApplyOptions = {},
  ): Promise<void> {
    const failed = await this.changeReservations(ctx, lines, -1, actorId, ref, options);
    if (failed.length) {
      throw new Error(`Nhả nhiều hơn phần đang giữ ở lô ${failed.join(', ')} (${ref.refType} ${ref.refId})`);
    }
  }

  /** Trả về số lô của những lô không đổi được phần giữ (rỗng = thành công). */
  private async changeReservations(
    ctx: InventoryTxContext,
    lines: readonly ReservationLine[],
    sign: 1 | -1,
    actorId: string,
    ref: ReservationRef,
    options: ApplyOptions,
  ): Promise<string[]> {
    if (!lines.length) return [];
    const quantityByBatch = new Map<string, number>();
    for (const line of lines) {
      if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
        throw new Error(`Số lượng giữ hàng phải là số nguyên dương (lô ${line.batchId}, ${line.quantity})`);
      }
      // Gộp theo lô: một câu UPDATE không sửa được một dòng hai lần.
      quantityByBatch.set(line.batchId, (quantityByBatch.get(line.batchId) ?? 0) + line.quantity);
    }

    // Khoá trước theo thứ tự `id` như `apply`: UPDATE ... FROM VALUES không khoá dòng theo thứ tự cố định.
    const locked = options.preLocked ?? (await this.repository.lockBatches(ctx.tx, [...quantityByBatch.keys()]));
    const batchById = new Map(locked.map((batch) => [batch.id, batch]));
    const missing = [...quantityByBatch.keys()].filter((id) => !batchById.has(id));
    if (missing.length) throw new Error(`Lô không tồn tại hoặc chưa được khoá: ${missing.join(', ')}`);

    const updated = await this.repository.applyReservations(
      ctx.tx,
      [...quantityByBatch].map(([batchId, quantity]) => ({ batchId, delta: sign * quantity })),
      actorId,
    );
    if (updated.length !== quantityByBatch.size) {
      const ok = new Set(updated.map((row) => row.id));
      return [...quantityByBatch.keys()].filter((id) => !ok.has(id)).map((id) => batchById.get(id)!.batchNumber);
    }

    this.scheduleStockChanged(ctx, updated, ref);
    return [];
  }

  private scheduleStockChanged(
    ctx: InventoryTxContext,
    rows: readonly { branchId: string; productId: string }[],
    ref: ReservationRef,
  ): void {
    if (!rows.length) return;
    const productsByBranch = new Map<string, Set<string>>();
    for (const row of rows) {
      const products = productsByBranch.get(row.branchId) ?? new Set<string>();
      products.add(row.productId);
      productsByBranch.set(row.branchId, products);
    }
    const { refType, refId } = ref;

    ctx.afterCommit(() => {
      const occurredAt = new Date();
      for (const [branchId, products] of productsByBranch) {
        this.events.emitStockChanged({ branchId, productIds: [...products], refType, refId, occurredAt });
      }
    });
  }
}
