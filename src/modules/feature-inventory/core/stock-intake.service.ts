import { Injectable } from '@nestjs/common';
import { BatchStatus, StockMovementType, StockRefType } from '@prisma/client';
import { randomUUID } from 'crypto';
import { ErrorCode } from 'src/common/types/error-code';
import { toDateOnlyString } from 'src/common/utils/date-only.util';
import { inventoryError } from './inventory.error';
import type { InventoryTxContext } from './inventory-transactions';
import { StockBatchRepository } from './stock-batch.repository';
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

/**
 * Đưa hàng vào lô — MỘT thuật toán cho cả xác nhận phiếu nhập và nhận điều chuyển:
 * tạo lô còn thiếu → khoá mọi lô liên quan → kiểm hạn dùng / trạng thái → giá vốn bình quân → ghi sổ.
 *
 * Luật K3 nằm DUY NHẤT ở đây: cùng số lô khác hạn dùng → 1703; lô đang khoá/thu hồi → 1704; cùng số lô khác giá →
 * gộp, giá vốn bình quân gia quyền. Số câu lệnh cố định: tạo (1) + khoá (1) + giá vốn (1) + sổ kho (2).
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

    const costs: { id: string; importPrice: number }[] = [];
    const batchIdByRefItem = new Map<string, string>();
    const entries = request.lines.map((line) => {
      const batch = batchByKey.get(`${line.productId}|${line.batchNumber}`);
      if (!batch) throw new Error(`Không khoá được lô ${line.batchNumber} vừa tạo`);
      if (toDateOnlyString(batch.expiryDate) !== toDateOnlyString(line.expiryDate)) {
        throw inventoryError(
          ErrorCode.BATCH_EXPIRY_MISMATCH,
          `lô ${line.batchNumber} đang có hạn ${toDateOnlyString(batch.expiryDate)}`,
        );
      }
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
