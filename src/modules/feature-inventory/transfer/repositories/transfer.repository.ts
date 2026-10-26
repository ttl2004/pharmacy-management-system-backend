import { Injectable } from '@nestjs/common';
import { Prisma, RecordStatus, StockMovementType, StockRefType, TransferStatus } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';

const BRANCH_BRIEF = { select: { id: true, code: true, name: true } } as const;
const USER_BRIEF = { select: { id: true, fullName: true } } as const;

const TRANSFER_LIST_SELECT = {
  id: true,
  code: true,
  status: true,
  shippedAt: true,
  receivedAt: true,
  cancelledAt: true,
  createdAt: true,
  updatedAt: true,
  fromBranch: BRANCH_BRIEF,
  toBranch: BRANCH_BRIEF,
  _count: { select: { items: { where: { isDeleted: false } } } },
} satisfies Prisma.StockTransferSelect;

const TRANSFER_DETAIL_SELECT = {
  ...TRANSFER_LIST_SELECT,
  fromBranchId: true,
  toBranchId: true,
  note: true,
  cancelReason: true,
  createdByUser: USER_BRIEF,
  shippedByUser: USER_BRIEF,
  receivedByUser: USER_BRIEF,
  cancelledByUser: USER_BRIEF,
  items: {
    where: { isDeleted: false },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      quantity: true,
      note: true,
      receivedQuantity: true,
      varianceReason: true,
      batchId: true,
      toBatchId: true,
      product: { select: { id: true, code: true, name: true } },
      batch: { select: { id: true, batchNumber: true, expiryDate: true } },
    },
  },
} satisfies Prisma.StockTransferSelect;

export type TransferSummary = Prisma.StockTransferGetPayload<{ select: typeof TRANSFER_LIST_SELECT }>;
export type TransferDetail = Prisma.StockTransferGetPayload<{ select: typeof TRANSFER_DETAIL_SELECT }>;

export interface TransferHead {
  id: string;
  status: TransferStatus;
  fromBranchId: string;
  toBranchId: string;
}

/** Dòng phiếu kèm thông tin lô gửi — đủ để tạo/gộp lô ở chi nhánh nhận (cùng số lô, hạn, NCC gốc). */
export type TransferItemWithBatch = Prisma.StockTransferItemGetPayload<{
  select: {
    id: true;
    quantity: true;
    batchId: true;
    productId: true;
    batch: { select: { batchNumber: true; manufacturingDate: true; expiryDate: true; supplierId: true } };
  };
}>;

@Injectable()
export class TransferRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Chi nhánh nhận được hàng: mọi chi nhánh đang hoạt động (không theo phạm vi người gọi — PM gửi đi chi nhánh khác). */
  findActiveBranches(): Promise<{ id: string; code: string; name: string }[]> {
    return this.prisma.branch.findMany({
      where: { isDeleted: false, status: RecordStatus.ACTIVE },
      orderBy: { code: 'asc' },
      select: { id: true, code: true, name: true },
    });
  }

  async findPage(where: Prisma.StockTransferWhereInput, page: number, limit: number) {
    const fullWhere = { AND: [where, { isDeleted: false }] };
    const [hits, total] = await Promise.all([
      this.prisma.stockTransfer.findMany({
        where: fullWhere,
        select: TRANSFER_LIST_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
        skip: (page - 1) * limit,
      }),
      this.prisma.stockTransfer.count({ where: fullWhere }),
    ]);
    return { hits, total, page, totalPages: Math.ceil(total / limit), limit };
  }

  findDetail(id: string, scopeWhere: Prisma.StockTransferWhereInput, client: Prisma.TransactionClient = this.prisma) {
    return client.stockTransfer.findFirst({
      where: { AND: [{ id, isDeleted: false }, scopeWhere] },
      select: TRANSFER_DETAIL_SELECT,
    });
  }

  /** Nhiều phiếu kèm dòng (hàng đi đường) — trần 500 phiếu, cũ trước. */
  findDetails(where: Prisma.StockTransferWhereInput): Promise<TransferDetail[]> {
    return this.prisma.stockTransfer.findMany({
      where: { AND: [where, { isDeleted: false }] },
      select: TRANSFER_DETAIL_SELECT,
      orderBy: [{ shippedAt: 'asc' }, { id: 'asc' }],
      take: 500,
    });
  }

  findHead(
    tx: Prisma.TransactionClient,
    id: string,
    scopeWhere: Prisma.StockTransferWhereInput,
  ): Promise<TransferHead | null> {
    return tx.stockTransfer.findFirst({
      where: { AND: [{ id, isDeleted: false }, scopeWhere] },
      select: { id: true, status: true, fromBranchId: true, toBranchId: true },
    });
  }

  findBranches(tx: Prisma.TransactionClient, ids: readonly string[]) {
    return tx.branch.findMany({
      where: { id: { in: [...ids] }, isDeleted: false },
      select: { id: true, status: true },
    });
  }

  /** Lô gửi đi — một câu lệnh cho cả phiếu. */
  findBatches(tx: Prisma.TransactionClient, ids: readonly string[]) {
    return tx.stockBatch.findMany({
      where: { id: { in: [...ids] }, isDeleted: false },
      select: {
        id: true,
        branchId: true,
        productId: true,
        batchNumber: true,
        expiryDate: true,
        status: true,
        quantityOnHand: true,
        reservedQuantity: true,
      },
    });
  }

  createHeader(tx: Prisma.TransactionClient, data: Prisma.StockTransferUncheckedCreateInput) {
    return tx.stockTransfer.create({ data, select: { id: true } });
  }

  createItems(tx: Prisma.TransactionClient, rows: Prisma.StockTransferItemCreateManyInput[]) {
    return tx.stockTransferItem.createMany({ data: rows });
  }

  /** Ghi số thực nhận + lý do lệch từng dòng lúc nhận. */
  async setReceived(
    tx: Prisma.TransactionClient,
    rows: readonly { itemId: string; receivedQuantity: number; varianceReason: string | null }[],
    actorId: string,
  ) {
    for (const row of rows) {
      await tx.stockTransferItem.update({
        where: { id: row.itemId },
        data: { receivedQuantity: row.receivedQuantity, varianceReason: row.varianceReason, updatedBy: actorId, updatedAt: new Date() },
      });
    }
  }

  /** Sửa phiếu PENDING: dòng chưa có bút toán tham chiếu (chỉ ghi lúc gửi) → xoá hẳn rồi ghi lại. */
  async replaceItems(tx: Prisma.TransactionClient, transferId: string, rows: Prisma.StockTransferItemCreateManyInput[]) {
    await tx.stockTransferItem.deleteMany({ where: { transferId } });
    await tx.stockTransferItem.createMany({ data: rows });
  }

  /** Chuyển trạng thái có điều kiện — 0 nghĩa là phiếu đã bị người khác xử lý trước. */
  async transition(
    tx: Prisma.TransactionClient,
    id: string,
    from: TransferStatus,
    data: Prisma.StockTransferUncheckedUpdateManyInput,
  ): Promise<number> {
    const result = await tx.stockTransfer.updateMany({ where: { id, isDeleted: false, status: from }, data });
    return result.count;
  }

  findItems(tx: Prisma.TransactionClient, transferId: string): Promise<TransferItemWithBatch[]> {
    return tx.stockTransferItem.findMany({
      where: { transferId, isDeleted: false },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        quantity: true,
        batchId: true,
        productId: true,
        batch: { select: { batchNumber: true, manufacturingDate: true, expiryDate: true, supplierId: true } },
      },
    });
  }

  /** Giá vốn đã chốt lúc xuất (theo dòng phiếu) — chi nhánh nhận dùng đúng giá này, không đọc lại lô gửi. */
  async findShipCosts(tx: Prisma.TransactionClient, transferId: string): Promise<Map<string, number | null>> {
    const rows = await tx.stockMovement.findMany({
      where: { refType: StockRefType.STOCK_TRANSFER, refId: transferId, type: StockMovementType.TRANSFER_OUT },
      select: { refItemId: true, unitCost: true },
    });
    return new Map(rows.map((row) => [row.refItemId as string, row.unitCost]));
  }

  /** Ghi lô nhận vào từng dòng — MỘT câu lệnh. */
  async setToBatchIds(
    tx: Prisma.TransactionClient,
    rows: readonly { itemId: string; toBatchId: string }[],
    actorId: string,
  ) {
    if (!rows.length) return;
    const values = Prisma.join(rows.map((row) => Prisma.sql`(${row.itemId}::uuid, ${row.toBatchId}::uuid)`));
    await tx.$executeRaw(Prisma.sql`
      UPDATE "stock_transfer_items" AS i
      SET "toBatchId" = v."toBatchId", "updatedAt" = now(), "updatedBy" = ${actorId}::uuid
      FROM (VALUES ${values}) AS v("id", "toBatchId")
      WHERE i."id" = v."id"`);
  }
}
