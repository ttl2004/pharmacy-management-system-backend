import { Injectable } from '@nestjs/common';
import { BatchStatus, Prisma, StockMovementType } from '@prisma/client';
import { lockAdvisoryKeys } from 'src/common/databases/advisory-lock';
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

export interface BatchKey {
  productId: string;
  batchNumber: string;
}

/** Lô đã khoá khi đưa hàng vào, kèm quyết định thu hồi của cùng số lô ở chi nhánh khác (`null` nếu không có). */
export interface IntakeBatch extends LockedBatch {
  recallReason: string | null;
  recalledBy: string | null;
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

  /**
   * Khoá SỐ LÔ (sản phẩm, số lô) trên toàn chuỗi, giữ tới hết transaction — advisory lock, không khoá dòng nào.
   * Thu hồi theo số lô và đưa hàng vào lô cùng giữ khoá này, nên chạy nối tiếp nhau: hoặc thu hồi thấy lô vừa tạo,
   * hoặc lô tạo sau thấy quyết định thu hồi. Khoá dòng không làm được việc đó vì lô chưa tạo thì chưa có dòng để khoá.
   */
  lockBatchNumbers(tx: Prisma.TransactionClient, keys: readonly BatchKey[]): Promise<void> {
    return lockAdvisoryKeys(
      tx,
      keys.map((key) => `stock-batch:${key.productId}|${key.batchNumber}`),
    );
  }

  /**
   * Khoá các lô của chi nhánh theo khoá tự nhiên, thứ tự `id` — cùng thứ tự khoá với `StockLedgerRepository.lockBatches`.
   * Kèm quyết định thu hồi của cùng số lô ở chi nhánh KHÁC (nếu có) để lô vừa tạo thừa hưởng — MỘT câu lệnh. Chỉ
   * quyết định của người có phạm vi toàn chuỗi (`chainWideRoles`) mới lan sang chi nhánh khác: thu hồi của quản lý
   * chi nhánh chỉ có hiệu lực ở chi nhánh đó (luật phạm vi chi nhánh).
   */
  lockByKey(
    tx: Prisma.TransactionClient,
    branchId: string,
    keys: readonly BatchKey[],
    chainWideRoles: readonly string[],
  ): Promise<IntakeBatch[]> {
    if (!keys.length) return Promise.resolve([]);
    const pairs = Prisma.join(keys.map((key) => Prisma.sql`(${key.productId}::uuid, ${key.batchNumber})`));
    return tx.$queryRaw<IntakeBatch[]>(Prisma.sql`
      SELECT b."id", b."branchId", b."productId", b."batchNumber", b."expiryDate", b."quantityOnHand",
             b."reservedQuantity", b."importPrice", b."status",
             r."blockedReason" AS "recallReason", r."blockedBy" AS "recalledBy"
      FROM "stock_batches" AS b
      LEFT JOIN LATERAL (
        SELECT s."blockedReason", s."blockedBy"
        FROM "stock_batches" AS s
        JOIN "users" AS u ON u."id" = s."blockedBy"
        JOIN "roles" AS ro ON ro."id" = u."roleId"
        WHERE s."productId" = b."productId" AND s."batchNumber" = b."batchNumber" AND s."id" <> b."id"
          AND s."status" = 'RECALLED' AND s."isDeleted" = false
          AND ro."code" IN (${Prisma.join([...chainWideRoles])})
        ORDER BY s."blockedAt" DESC
        LIMIT 1
      ) AS r ON true
      WHERE b."branchId" = ${branchId}::uuid AND (b."productId", b."batchNumber") IN (${pairs})
        AND b."isDeleted" = false
      ORDER BY b."id"
      FOR UPDATE OF b`);
  }

  /** Khoá mọi lô của một số lô (trong một chi nhánh, hoặc cả chuỗi khi `branchId` trống), thứ tự `id`. */
  lockByBatchNumber(
    tx: Prisma.TransactionClient,
    key: BatchKey,
    branchId: string | undefined,
  ): Promise<{ id: string; branchId: string; status: BatchStatus }[]> {
    const inBranch = branchId ? Prisma.sql`AND "branchId" = ${branchId}::uuid` : Prisma.empty;
    return tx.$queryRaw(Prisma.sql`
      SELECT "id", "branchId", "status"
      FROM "stock_batches"
      WHERE "productId" = ${key.productId}::uuid AND "batchNumber" = ${key.batchNumber} AND "isDeleted" = false
        ${inBranch}
      ORDER BY "id"
      FOR UPDATE`);
  }

  /**
   * Khoá các lô BÁN ĐƯỢC của những sản phẩm này ở một chi nhánh: AVAILABLE, còn hạn sau `today` (`YYYY-MM-DD` giờ
   * VN — lô hết hạn đúng hôm nay là đã hết hạn), còn hàng chưa giữ. Thứ tự khoá `id`, cùng thứ tự với
   * `StockLedgerRepository.lockBatches`; thứ tự FEFO do caller tự sắp. MỘT câu lệnh cho cả đơn.
   */
  lockSellable(
    tx: Prisma.TransactionClient,
    branchId: string,
    productIds: readonly string[],
    today: string,
  ): Promise<LockedBatch[]> {
    if (!productIds.length) return Promise.resolve([]);
    const ids = Prisma.join(productIds.map((id) => Prisma.sql`${id}::uuid`));
    return tx.$queryRaw<LockedBatch[]>(Prisma.sql`
      SELECT "id", "branchId", "productId", "batchNumber", "expiryDate", "quantityOnHand", "reservedQuantity",
             "importPrice", "status"
      FROM "stock_batches"
      WHERE "branchId" = ${branchId}::uuid AND "productId" IN (${ids})
        AND "status" = 'AVAILABLE' AND "expiryDate" > ${today}::date
        AND "quantityOnHand" > "reservedQuantity" AND "isDeleted" = false
      ORDER BY "id"
      FOR UPDATE`);
  }

  /** Như `lockSellable` nhưng KHÔNG khoá — chỉ để xem trước FEFO (không giữ hàng). */
  findSellable(
    tx: Prisma.TransactionClient,
    branchId: string,
    productIds: readonly string[],
    today: string,
  ): Promise<LockedBatch[]> {
    if (!productIds.length) return Promise.resolve([]);
    const ids = Prisma.join(productIds.map((id) => Prisma.sql`${id}::uuid`));
    return tx.$queryRaw<LockedBatch[]>(Prisma.sql`
      SELECT "id", "branchId", "productId", "batchNumber", "expiryDate", "quantityOnHand", "reservedQuantity",
             "importPrice", "status"
      FROM "stock_batches"
      WHERE "branchId" = ${branchId}::uuid AND "productId" IN (${ids})
        AND "status" = 'AVAILABLE' AND "expiryDate" > ${today}::date
        AND "quantityOnHand" > "reservedQuantity" AND "isDeleted" = false`);
  }

  /** Đưa lô vào trạng thái thu hồi theo quyết định đã có (lý do, người thu hồi) — MỘT câu lệnh. */
  async markRecalled(
    tx: Prisma.TransactionClient,
    rows: readonly { id: string; reason: string; recalledBy: string }[],
    actorId: string,
  ): Promise<void> {
    if (!rows.length) return;
    const values = Prisma.join(
      rows.map((row) => Prisma.sql`(${row.id}::uuid, ${row.reason}, ${row.recalledBy}::uuid)`),
    );
    await tx.$executeRaw(Prisma.sql`
      UPDATE "stock_batches" AS b
      SET "status" = 'RECALLED', "blockedReason" = v."reason", "blockedBy" = v."recalledBy", "blockedAt" = now(),
          "updatedAt" = now(), "updatedBy" = ${actorId}::uuid
      FROM (VALUES ${values}) AS v("id", "reason", "recalledBy")
      WHERE b."id" = v."id"`);
  }

  /** Lô từng có bút toán KHÁC nhập hàng (bán, chuyển, điều chỉnh…) — hạn dùng của các lô này đã được dùng thật. */
  async findWithNonImportMovements(tx: Prisma.TransactionClient, batchIds: readonly string[]): Promise<Set<string>> {
    if (!batchIds.length) return new Set();
    const rows = await tx.stockMovement.findMany({
      where: { batchId: { in: [...batchIds] }, type: { not: StockMovementType.IMPORT } },
      select: { batchId: true },
      distinct: ['batchId'],
    });
    return new Set(rows.map((row) => row.batchId));
  }

  /** Ghi lại hạn dùng / NSX (chuỗi `YYYY-MM-DD`) cho nhiều lô trong MỘT câu lệnh — chỉ dùng để sửa sai nhập liệu. */
  async resetDates(
    tx: Prisma.TransactionClient,
    rows: readonly { id: string; expiryDate: string; manufacturingDate: string | null }[],
    actorId: string,
  ): Promise<void> {
    if (!rows.length) return;
    const values = Prisma.join(
      rows.map((row) => Prisma.sql`(${row.id}::uuid, ${row.expiryDate}::date, ${row.manufacturingDate}::date)`),
    );
    await tx.$executeRaw(Prisma.sql`
      UPDATE "stock_batches" AS b
      SET "expiryDate" = v."expiry", "manufacturingDate" = v."mfg", "updatedAt" = now(), "updatedBy" = ${actorId}::uuid
      FROM (VALUES ${values}) AS v("id", "expiry", "mfg")
      WHERE b."id" = v."id"`);
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
