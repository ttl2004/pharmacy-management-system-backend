import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { LockedBatch } from './stock-ledger.repository';

export interface NewBatchRow {
  id: string;
  branchId: string;
  productId: string;
  batchNumber: string;
  manufacturingDate: Date | null;
  expiryDate: Date;
  importPrice: number;
  supplierId: string | null;
  goodsReceiptItemId: string | null;
  createdBy: string;
}

/**
 * Tạo/gộp lô — dùng chung cho xác nhận phiếu nhập và nhận hàng điều chuyển (cả hai đều "đưa hàng vào một lô có
 * thể đã tồn tại"). Không đụng `quantityOnHand`: tồn chỉ đổi qua `StockLedgerService`.
 */
@Injectable()
export class StockBatchRepository {
  /**
   * Tạo lô chưa có; lô đã có (kể cả do transaction khác vừa tạo) thì bỏ qua nhờ unique (chi nhánh, sản phẩm, số lô).
   * Chèn theo thứ tự (sản phẩm, số lô): transaction đụng khoá unique mà transaction khác vừa chèn (chưa commit) phải
   * chờ — hai lần nhập tạo cùng hai lô mới theo thứ tự ngược nhau sẽ chờ nhau thành deadlock nếu không sắp xếp.
   */
  insertSkipExisting(tx: Prisma.TransactionClient, rows: readonly NewBatchRow[]) {
    if (!rows.length) return Promise.resolve({ count: 0 });
    const ordered = [...rows].sort((a, b) =>
      a.productId === b.productId ? compareText(a.batchNumber, b.batchNumber) : compareText(a.productId, b.productId),
    );
    return tx.stockBatch.createMany({ data: ordered, skipDuplicates: true });
  }

  /** Khoá các lô theo khoá tự nhiên, thứ tự `id` — cùng thứ tự khoá với `StockLedgerRepository.lockBatches`. */
  lockByKey(
    tx: Prisma.TransactionClient,
    branchId: string,
    keys: readonly { productId: string; batchNumber: string }[],
  ): Promise<LockedBatch[]> {
    if (!keys.length) return Promise.resolve([]);
    const pairs = Prisma.join(keys.map((key) => Prisma.sql`(${key.productId}::uuid, ${key.batchNumber})`));
    return tx.$queryRaw<LockedBatch[]>(Prisma.sql`
      SELECT "id", "branchId", "productId", "batchNumber", "expiryDate", "quantityOnHand", "reservedQuantity",
             "importPrice", "status"
      FROM "stock_batches"
      WHERE "branchId" = ${branchId}::uuid AND ("productId", "batchNumber") IN (${pairs}) AND "isDeleted" = false
      ORDER BY "id"
      FOR UPDATE`);
  }

  /** Ghi giá vốn bình quân mới cho nhiều lô trong MỘT câu lệnh. */
  async updateCosts(
    tx: Prisma.TransactionClient,
    rows: readonly { id: string; importPrice: number }[],
    actorId: string,
  ): Promise<void> {
    if (!rows.length) return;
    const values = Prisma.join(rows.map((row) => Prisma.sql`(${row.id}::uuid, ${row.importPrice}::int)`));
    await tx.$executeRaw(Prisma.sql`
      UPDATE "stock_batches" AS b
      SET "importPrice" = v."price", "updatedAt" = now(), "updatedBy" = ${actorId}::uuid
      FROM (VALUES ${values}) AS v("id", "price")
      WHERE b."id" = v."id"`);
  }
}

/** So sánh theo mã ký tự, không theo locale — mọi instance phải ra cùng một thứ tự. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
