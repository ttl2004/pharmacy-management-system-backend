import { Injectable } from '@nestjs/common';
import { todayInVietnam } from 'src/common/utils/date-only.util';
import { ErrorCode } from 'src/common/types/error-code';
import type { InventoryTxContext } from './inventory-transactions';
import { inventoryError } from './inventory.error';
import { StockBatchRepository } from './stock-batch.repository';
import type { LockedBatch } from './stock-ledger.repository';

/** Một dòng cần xuất: `quantity` dương theo đơn vị cơ bản. */
export interface AllocationLine {
  productId: string;
  quantity: number;
}

/** Một phần của dòng lấy từ một lô. Một dòng có thể tách ra nhiều lô; `lineIndex` trỏ về dòng gốc. */
export interface BatchAllocation {
  lineIndex: number;
  productId: string;
  batchId: string;
  quantity: number;
  /** Giá vốn của lô lúc chọn — ghi vào bút toán xuất. */
  unitCost: number;
}

export interface FefoResult {
  allocations: BatchAllocation[];
  /** Các lô đã khoá — truyền vào `preLocked` của `StockLedgerService.apply`/`reserve` để khỏi khoá lại. */
  locked: LockedBatch[];
}

/**
 * Chọn lô xuất theo FEFO (hết hạn trước, xuất trước) cho bán hàng — người bán không tự chọn lô. Chỉ chọn và khoá,
 * không đổi tồn: caller ghi sổ (`apply`) hoặc giữ hàng (`reserve`) bằng kết quả trả về trong cùng transaction.
 */
@Injectable()
export class StockAllocationService {
  constructor(private readonly batches: StockBatchRepository) {}

  async allocateFefo(
    ctx: InventoryTxContext,
    branchId: string,
    lines: readonly AllocationLine[],
    today: string = todayInVietnam(),
  ): Promise<FefoResult> {
    if (!lines.length) return { allocations: [], locked: [] };
    const productIds = [...new Set(lines.map((line) => line.productId))];
    const locked = await this.batches.lockSellable(ctx.tx, branchId, productIds, today);
    return { allocations: pickFefo(locked, lines), locked };
  }

  /**
   * Xem trước FEFO cho giỏ hàng: cùng luật chọn lô với `allocateFefo` nhưng không khoá, không giữ hàng và không ném khi
   * thiếu — trả lượng thiếu từng dòng để màn hình cảnh báo. Kết quả thật có thể khác nếu tồn đổi trước lúc lập đơn.
   */
  async previewFefo(
    ctx: InventoryTxContext,
    branchId: string,
    lines: readonly AllocationLine[],
    today: string = todayInVietnam(),
  ): Promise<{ allocations: BatchAllocation[]; shortages: number[]; batches: LockedBatch[] }> {
    if (!lines.length) return { allocations: [], shortages: [], batches: [] };
    const productIds = [...new Set(lines.map((line) => line.productId))];
    const batches = await this.batches.findSellable(ctx.tx, branchId, productIds, today);
    return { ...planFefo(batches, lines), batches };
  }
}

/**
 * Phần thuần của FEFO: lô hạn gần nhất trước, cùng hạn thì theo `id` cho kết quả ổn định. Nhiều dòng cùng sản phẩm
 * dùng chung lượng còn lại của lô. `batches` phải là lô bán được (đã lọc trạng thái/hạn dùng). Thiếu hàng → 1700.
 */
export function pickFefo(batches: readonly LockedBatch[], lines: readonly AllocationLine[]): BatchAllocation[] {
  const { allocations, shortages } = planFefo(batches, lines);
  const short = shortages.findIndex((remaining) => remaining > 0);
  if (short >= 0) {
    throw inventoryError(
      ErrorCode.INSUFFICIENT_STOCK,
      `dòng ${short + 1} thiếu ${shortages[short]} (đơn vị cơ bản) so với lượng bán được`,
    );
  }
  return allocations;
}

/** Chọn lô FEFO không ném khi thiếu: `shortages[i]` = lượng dòng i còn thiếu (0 = đủ). */
export function planFefo(
  batches: readonly LockedBatch[],
  lines: readonly AllocationLine[],
): { allocations: BatchAllocation[]; shortages: number[] } {
  const byProduct = new Map<string, { batch: LockedBatch; free: number }[]>();
  const ordered = [...batches].sort(
    (a, b) => a.expiryDate.getTime() - b.expiryDate.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  for (const batch of ordered) {
    const free = batch.quantityOnHand - batch.reservedQuantity;
    if (free <= 0) continue;
    const list = byProduct.get(batch.productId) ?? [];
    list.push({ batch, free });
    byProduct.set(batch.productId, list);
  }

  const allocations: BatchAllocation[] = [];
  const shortages: number[] = [];
  lines.forEach((line, lineIndex) => {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new Error(`Số lượng xuất phải là số nguyên dương (dòng ${lineIndex + 1}, ${line.quantity})`);
    }
    let remaining = line.quantity;
    for (const slot of byProduct.get(line.productId) ?? []) {
      if (remaining === 0) break;
      const take = Math.min(slot.free, remaining);
      if (take === 0) continue;
      slot.free -= take;
      remaining -= take;
      allocations.push({
        lineIndex,
        productId: line.productId,
        batchId: slot.batch.id,
        quantity: take,
        unitCost: slot.batch.importPrice,
      });
    }
    shortages.push(remaining);
  });
  return { allocations, shortages };
}
