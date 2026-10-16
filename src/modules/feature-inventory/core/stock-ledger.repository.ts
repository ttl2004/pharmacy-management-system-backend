import { Injectable } from '@nestjs/common';
import { BatchStatus, Prisma, StockMovementType, StockRefType } from '@prisma/client';

/** Một lô đã khoá `FOR UPDATE` — caller dùng để kiểm trạng thái/hạn dùng trước khi ghi sổ. */
export interface LockedBatch {
  id: string;
  branchId: string;
  productId: string;
  batchNumber: string;
  expiryDate: Date;
  quantityOnHand: number;
  reservedQuantity: number;
  importPrice: number;
  status: BatchStatus;
}

/** Lô vừa đổi phần giữ — đủ để báo sự kiện tồn kho mà không phải đọc lại lô. */
export interface ReservedBatch {
  id: string;
  branchId: string;
  productId: string;
  reservedQuantity: number;
}

export interface MovementRow {
  branchId: string;
  productId: string;
  batchId: string;
  type: StockMovementType;
  quantity: number;
  balanceAfter: number;
  unitCost: number | null;
  refType: StockRefType;
  refId: string;
  refItemId: string | null;
  note: string | null;
  createdBy: string;
}

/**
 * SQL của sổ kho. Mỗi hàm là MỘT câu lệnh bất kể số lô — đó là điều kiện để xác nhận phiếu N dòng không timeout
 * khi mỗi câu lệnh tốn ~100 ms. Chỉ `StockLedgerService` được gọi file này.
 */
@Injectable()
export class StockLedgerRepository {
  /**
   * Khoá các lô theo thứ tự `id` tăng dần. Hai transaction cùng đụng lô {A, B} luôn khoá A trước B nên không thể
   * chờ vòng nhau (deadlock). Lô không tồn tại thì không có trong kết quả — caller tự đối chiếu.
   */
  async lockBatches(tx: Prisma.TransactionClient, batchIds: readonly string[]): Promise<LockedBatch[]> {
    if (!batchIds.length) return [];
    const ids = Prisma.join(batchIds.map((id) => Prisma.sql`${id}::uuid`));
    return tx.$queryRaw<LockedBatch[]>(Prisma.sql`
      SELECT "id", "branchId", "productId", "batchNumber", "expiryDate", "quantityOnHand", "reservedQuantity",
             "importPrice", "status"
      FROM "stock_batches"
      WHERE "id" IN (${ids}) AND "isDeleted" = false
      ORDER BY "id"
      FOR UPDATE`);
  }

  /**
   * Cộng `delta` vào tồn và `reservedDelta` vào phần đang giữ cho đơn online của từng lô trong MỘT câu lệnh, có điều
   * kiện: phần giữ mới không âm và tồn mới không thấp hơn phần giữ mới. Xuất hàng của đơn đã giữ (`reservedDelta` âm)
   * phải đi chung câu lệnh này — trừ tồn trước rồi mới nhả phần giữ thì chính đơn đó bị chặn vì "đụng phần đang giữ".
   * Lô không thoả điều kiện thì không bị sửa và không có trong kết quả trả về — caller so số dòng để biết lô nào thiếu
   * hàng. Postgres đánh giá lại điều kiện trên dòng mới nhất khi phải chờ khoá, nên hai request cùng trừ một lô không
   * bao giờ cùng thành công vượt tồn.
   */
  async applyDeltas(
    tx: Prisma.TransactionClient,
    deltas: readonly { batchId: string; delta: number; reservedDelta?: number }[],
    actorId: string,
  ): Promise<{ id: string; quantityOnHand: number }[]> {
    if (!deltas.length) return [];
    const values = Prisma.join(
      deltas.map((item) => Prisma.sql`(${item.batchId}::uuid, ${item.delta}::int, ${item.reservedDelta ?? 0}::int)`),
    );
    return tx.$queryRaw<{ id: string; quantityOnHand: number }[]>(Prisma.sql`
      UPDATE "stock_batches" AS b
      SET "quantityOnHand" = b."quantityOnHand" + v."delta",
          "reservedQuantity" = b."reservedQuantity" + v."reservedDelta",
          "updatedAt" = now(),
          "updatedBy" = ${actorId}::uuid
      FROM (VALUES ${values}) AS v("id", "delta", "reservedDelta")
      WHERE b."id" = v."id"
        AND b."reservedQuantity" + v."reservedDelta" >= 0
        AND b."quantityOnHand" + v."delta" >= b."reservedQuantity" + v."reservedDelta"
      RETURNING b."id", b."quantityOnHand"`);
  }

  /**
   * Giữ (`delta` dương) hoặc nhả (`delta` âm) hàng cho đơn online — MỘT câu lệnh, không đổi tồn, không ghi sổ kho.
   * Điều kiện như `applyDeltas`: phần giữ nằm trong [0, tồn]. Lô không thoả không có trong kết quả. Caller phải khoá
   * lô trước bằng `lockBatches` (thứ tự `id`) — câu UPDATE này không khoá dòng theo thứ tự cố định.
   */
  async applyReservations(
    tx: Prisma.TransactionClient,
    deltas: readonly { batchId: string; delta: number }[],
    actorId: string,
  ): Promise<ReservedBatch[]> {
    if (!deltas.length) return [];
    const values = Prisma.join(deltas.map((item) => Prisma.sql`(${item.batchId}::uuid, ${item.delta}::int)`));
    return tx.$queryRaw<ReservedBatch[]>(Prisma.sql`
      UPDATE "stock_batches" AS b
      SET "reservedQuantity" = b."reservedQuantity" + v."delta",
          "updatedAt" = now(),
          "updatedBy" = ${actorId}::uuid
      FROM (VALUES ${values}) AS v("id", "delta")
      WHERE b."id" = v."id" AND b."isDeleted" = false
        AND b."reservedQuantity" + v."delta" BETWEEN 0 AND b."quantityOnHand"
      RETURNING b."id", b."branchId", b."productId", b."reservedQuantity"`);
  }

  async insertMovements(tx: Prisma.TransactionClient, rows: readonly MovementRow[]): Promise<void> {
    if (!rows.length) return;
    await tx.stockMovement.createMany({ data: [...rows] });
  }
}
