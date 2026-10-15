import { Injectable } from '@nestjs/common';
import { AdjustmentType, Prisma, ReceiptStatus } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';

const USER_BRIEF = { select: { id: true, fullName: true } } as const;

/** Lô dùng để lập dòng phiếu nháp. */
export interface DraftBatch {
  id: string;
  productId: string;
  quantityOnHand: number;
}

const ADJUSTMENT_LIST_SELECT = {
  id: true,
  code: true,
  type: true,
  status: true,
  reason: true,
  confirmedAt: true,
  cancelledAt: true,
  createdAt: true,
  updatedAt: true,
  branch: { select: { id: true, code: true, name: true } },
  supplier: { select: { id: true, code: true, name: true } },
  _count: { select: { items: { where: { isDeleted: false } } } },
} satisfies Prisma.StockAdjustmentSelect;

const ADJUSTMENT_DETAIL_SELECT = {
  ...ADJUSTMENT_LIST_SELECT,
  branchId: true,
  note: true,
  cancelReason: true,
  createdByUser: USER_BRIEF,
  confirmedByUser: USER_BRIEF,
  cancelledByUser: USER_BRIEF,
  items: {
    where: { isDeleted: false },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      systemQuantity: true,
      actualQuantity: true,
      quantity: true,
      unitCost: true,
      reason: true,
      product: { select: { id: true, code: true, name: true } },
      batch: { select: { id: true, batchNumber: true, expiryDate: true, status: true } },
    },
  },
} satisfies Prisma.StockAdjustmentSelect;

export type AdjustmentDetail = Prisma.StockAdjustmentGetPayload<{ select: typeof ADJUSTMENT_DETAIL_SELECT }>;

export interface AdjustmentHead {
  id: string;
  status: ReceiptStatus;
  type: AdjustmentType;
  branchId: string;
}

@Injectable()
export class AdjustmentRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findPage(where: Prisma.StockAdjustmentWhereInput, page: number, limit: number) {
    const fullWhere = { ...where, isDeleted: false };
    const [hits, total] = await Promise.all([
      this.prisma.stockAdjustment.findMany({
        where: fullWhere,
        select: ADJUSTMENT_LIST_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
        skip: (page - 1) * limit,
      }),
      this.prisma.stockAdjustment.count({ where: fullWhere }),
    ]);
    return { hits, total, page, totalPages: Math.ceil(total / limit), limit };
  }

  findDetail(id: string, scopeWhere: { branchId?: string }, client: Prisma.TransactionClient = this.prisma) {
    return client.stockAdjustment.findFirst({
      where: { id, isDeleted: false, ...scopeWhere },
      select: ADJUSTMENT_DETAIL_SELECT,
    });
  }

  findHead(
    tx: Prisma.TransactionClient,
    id: string,
    scopeWhere: { branchId?: string },
  ): Promise<AdjustmentHead | null> {
    return tx.stockAdjustment.findFirst({
      where: { id, isDeleted: false, ...scopeWhere },
      select: { id: true, status: true, type: true, branchId: true },
    });
  }

  findBranch(tx: Prisma.TransactionClient, id: string) {
    return tx.branch.findFirst({ where: { id, isDeleted: false }, select: { id: true, status: true } });
  }

  findSupplier(tx: Prisma.TransactionClient, id: string) {
    return tx.supplier.findFirst({ where: { id, isDeleted: false }, select: { id: true } });
  }

  /** Lô của chi nhánh — lô chi nhánh khác coi như không tồn tại. */
  findBatches(tx: Prisma.TransactionClient, branchId: string, ids: readonly string[]): Promise<DraftBatch[]> {
    return tx.stockBatch.findMany({
      where: { id: { in: [...ids] }, branchId, isDeleted: false },
      select: { id: true, productId: true, quantityOnHand: true },
    });
  }

  /**
   * Như `findBatches` nhưng khoá `FOR UPDATE` (thứ tự `id`, như mọi chỗ khoá lô): hai lần lập phiếu kiểm kê cùng lô
   * chạy nối tiếp. Lọc chi nhánh ngay trong câu khoá — không ai giữ được khoá lô của chi nhánh khác.
   */
  lockBatches(tx: Prisma.TransactionClient, branchId: string, ids: readonly string[]): Promise<DraftBatch[]> {
    if (!ids.length) return Promise.resolve([]);
    return tx.$queryRaw<DraftBatch[]>(Prisma.sql`
      SELECT "id", "productId", "quantityOnHand"
      FROM "stock_batches"
      WHERE "id" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
        AND "branchId" = ${branchId}::uuid AND "isDeleted" = false
      ORDER BY "id"
      FOR UPDATE`);
  }

  /** Một dòng kiểm kê thuộc phiếu nháp đang giữ một trong các lô (nếu có). */
  async findPendingStockTake(tx: Prisma.TransactionClient, batchIds: readonly string[]) {
    const item = await tx.stockAdjustmentItem.findFirst({
      where: {
        batchId: { in: [...batchIds] },
        isDeleted: false,
        adjustment: { type: AdjustmentType.STOCK_TAKE, status: ReceiptStatus.DRAFT, isDeleted: false },
      },
      select: { batch: { select: { batchNumber: true } }, adjustment: { select: { code: true } } },
    });
    return item ? { batchNumber: item.batch.batchNumber, code: item.adjustment.code } : null;
  }

  createHeader(tx: Prisma.TransactionClient, data: Prisma.StockAdjustmentUncheckedCreateInput) {
    return tx.stockAdjustment.create({ data, select: { id: true } });
  }

  createItems(tx: Prisma.TransactionClient, rows: Prisma.StockAdjustmentItemCreateManyInput[]) {
    return tx.stockAdjustmentItem.createMany({ data: rows });
  }

  async transition(
    tx: Prisma.TransactionClient,
    id: string,
    from: ReceiptStatus,
    data: Prisma.StockAdjustmentUncheckedUpdateManyInput,
  ): Promise<number> {
    const result = await tx.stockAdjustment.updateMany({ where: { id, isDeleted: false, status: from }, data });
    return result.count;
  }

  findItems(tx: Prisma.TransactionClient, adjustmentId: string) {
    return tx.stockAdjustmentItem.findMany({
      where: { adjustmentId, isDeleted: false },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, batchId: true, systemQuantity: true, actualQuantity: true, quantity: true, reason: true },
    });
  }

  /** Chốt giá vốn từng dòng (giá lô lúc xác nhận) — MỘT câu lệnh. */
  async freezeUnitCosts(
    tx: Prisma.TransactionClient,
    rows: readonly { id: string; unitCost: number }[],
    actorId: string,
  ): Promise<void> {
    if (!rows.length) return;
    const values = Prisma.join(rows.map((row) => Prisma.sql`(${row.id}::uuid, ${row.unitCost}::int)`));
    await tx.$executeRaw(Prisma.sql`
      UPDATE "stock_adjustment_items" AS i
      SET "unitCost" = v."cost", "updatedAt" = now(), "updatedBy" = ${actorId}::uuid
      FROM (VALUES ${values}) AS v("id", "cost")
      WHERE i."id" = v."id"`);
  }
}
