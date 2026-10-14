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
 * Chỗ DUY NHẤT được thay đổi `stock_batches.quantityOnHand` và ghi `stock_movements`. Hai việc đó luôn đi chung
 * một transaction, nên sổ kho (nguồn chân lý) và tồn cache không thể lệch nhau. Không có API "sửa tồn" nào khác:
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
    }

    const deltaByBatch = new Map<string, number>();
    for (const entry of entries)
      deltaByBatch.set(entry.batchId, (deltaByBatch.get(entry.batchId) ?? 0) + entry.quantity);

    const locked = options.preLocked ?? (await this.repository.lockBatches(ctx.tx, [...deltaByBatch.keys()]));
    const batchById = new Map(locked.map((batch) => [batch.id, batch]));
    const missing = [...deltaByBatch.keys()].filter((id) => !batchById.has(id));
    if (missing.length) throw new Error(`Lô không tồn tại hoặc chưa được khoá: ${missing.join(', ')}`);

    // Lô có tổng delta = 0 (vd vừa +5 vừa -5) không cần UPDATE nhưng vẫn phải ghi đủ bút toán.
    const changed = [...deltaByBatch].filter(([, delta]) => delta !== 0);
    const updated = await this.repository.applyDeltas(
      ctx.tx,
      changed.map(([batchId, delta]) => ({ batchId, delta })),
      actorId,
    );
    if (updated.length !== changed.length) {
      const ok = new Set(updated.map((row) => row.id));
      const short = changed
        .filter(([id]) => !ok.has(id))
        .map(([id]) => batchById.get(id)?.batchNumber ?? id)
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

    this.scheduleStockChanged(ctx, applied);
    return applied;
  }

  private scheduleStockChanged(ctx: InventoryTxContext, applied: readonly AppliedMovement[]): void {
    const productsByBranch = new Map<string, Set<string>>();
    for (const movement of applied) {
      const products = productsByBranch.get(movement.branchId) ?? new Set<string>();
      products.add(movement.productId);
      productsByBranch.set(movement.branchId, products);
    }
    const { refType, refId } = applied[0];

    ctx.afterCommit(() => {
      const occurredAt = new Date();
      for (const [branchId, products] of productsByBranch) {
        this.events.emitStockChanged({ branchId, productIds: [...products], refType, refId, occurredAt });
      }
    });
  }
}
