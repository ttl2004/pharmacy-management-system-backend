import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/** Một dòng `order_item_batches` — phần hàng một dòng đơn đang giữ (hoặc đã trừ) ở một lô. */
export interface ReservedAllocation {
  id: string;
  orderItemId: string;
  batchId: string;
  quantity: number;
  unitCost: number;
}

/** Đọc/ghi `order_item_batches`. Chỉ `OrderStockService` dùng; không đụng tồn kho. */
@Injectable()
export class OrderStockRepository {
  /** Mọi phân bổ của một đơn, thứ tự cố định theo id — một câu lệnh. */
  findAllocations(tx: Prisma.TransactionClient, orderId: string): Promise<ReservedAllocation[]> {
    return tx.orderItemBatch.findMany({
      where: { orderItem: { orderId } },
      select: { id: true, orderItemId: true, batchId: true, quantity: true, unitCost: true },
      orderBy: { id: 'asc' },
    });
  }

  insertAllocations(tx: Prisma.TransactionClient, rows: Prisma.OrderItemBatchCreateManyInput[]) {
    return tx.orderItemBatch.createMany({ data: rows });
  }

  /** Chỉ dùng khi sửa đơn PENDING: phân bổ chưa bị sổ kho trỏ tới nên xoá được. */
  deleteAllocations(tx: Prisma.TransactionClient, orderId: string) {
    return tx.orderItemBatch.deleteMany({ where: { orderItem: { orderId } } });
  }

  /** Chốt giá vốn lúc trừ kho — MỘT câu lệnh cho cả đơn. */
  async setUnitCosts(tx: Prisma.TransactionClient, rows: readonly { id: string; unitCost: number }[]): Promise<void> {
    if (!rows.length) return;
    const values = Prisma.join(rows.map((row) => Prisma.sql`(${row.id}::uuid, ${row.unitCost}::int)`));
    await tx.$executeRaw(Prisma.sql`
      UPDATE "order_item_batches" AS a
      SET "unitCost" = v."unitCost"
      FROM (VALUES ${values}) AS v("id", "unitCost")
      WHERE a."id" = v."id"`);
  }
}
