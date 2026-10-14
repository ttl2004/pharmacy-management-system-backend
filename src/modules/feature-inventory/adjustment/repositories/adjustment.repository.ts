import { Injectable } from '@nestjs/common';
import { AdjustmentType, Prisma, ReceiptStatus } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';

const USER_BRIEF = { select: { id: true, fullName: true } } as const;

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

  findBatches(tx: Prisma.TransactionClient, ids: readonly string[]) {
    return tx.stockBatch.findMany({
      where: { id: { in: [...ids] }, isDeleted: false },
      select: { id: true, branchId: true, productId: true, batchNumber: true, quantityOnHand: true },
    });
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
