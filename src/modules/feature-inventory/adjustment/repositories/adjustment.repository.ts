import { Injectable } from '@nestjs/common';
import { AdjustmentType, Prisma, ReceiptStatus } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';

const USER_BRIEF = { select: { id: true, fullName: true } } as const;

/** Người dùng nội bộ đang làm việc (không SUPER_ADMIN/CUSTOMER). */
const STAFF_WHERE = {
  isDeleted: false,
  status: 'ACTIVE',
  role: { code: { notIn: ['SUPER_ADMIN', 'CUSTOMER'] } },
} satisfies Prisma.UserWhereInput;

/** Lô dùng để lập dòng phiếu nháp. */
export interface DraftBatch {
  id: string;
  productId: string;
  quantityOnHand: number;
  /** Trả NCC theo phiếu nhập: khớp dòng phiếu nhập gốc (cùng sản phẩm + số lô). */
  batchNumber: string;
  /** Giá trả lại mặc định khi không gửi. */
  importPrice: number;
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
  documentDate: true,
  isFavourite: true,
  note: true,
  branch: { select: { id: true, code: true, name: true } },
  supplier: { select: { id: true, code: true, name: true } },
  createdByUser: USER_BRIEF,
  handler: USER_BRIEF,
  receiver: USER_BRIEF,
  internalUseType: { select: { id: true, name: true } },
  // Tiền phiếu trả NCC (loại khác = 0/null).
  goodsReceipt: { select: { id: true, code: true } },
  goodsAmount: true,
  discountAmount: true,
  discountPercent: true,
  refundExpenseAmount: true,
  totalAmount: true,
  supplierPaid: true,
  paymentMethod: true,
  _count: { select: { items: { where: { isDeleted: false } } } },
} satisfies Prisma.StockAdjustmentSelect;

const ADJUSTMENT_DETAIL_SELECT = {
  ...ADJUSTMENT_LIST_SELECT,
  branchId: true,
  cancelReason: true,
  confirmedByUser: USER_BRIEF,
  cancelledByUser: USER_BRIEF,
  refundExpenses: true,
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
      returnPrice: true,
      goodsReceiptItemId: true,
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
  /** Trả NCC theo phiếu nhập: kiểm lại trần lúc xác nhận. */
  goodsReceiptId: string | null;
  refundExpenses: Prisma.JsonValue;
}

@Injectable()
export class AdjustmentRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findPage(
    where: Prisma.StockAdjustmentWhereInput,
    page: number,
    limit: number,
    orderBy: Prisma.StockAdjustmentOrderByWithRelationInput[] = [{ createdAt: 'desc' }],
  ) {
    const fullWhere = { ...where, isDeleted: false };
    const [hits, total] = await Promise.all([
      this.prisma.stockAdjustment.findMany({
        where: fullWhere,
        select: ADJUSTMENT_LIST_SELECT,
        orderBy: [...orderBy, { id: 'desc' }],
        take: limit,
        skip: (page - 1) * limit,
      }),
      this.prisma.stockAdjustment.count({ where: fullWhere }),
    ]);
    return { hits, total, page, totalPages: Math.ceil(total / limit), limit };
  }

  /** Dòng tổng danh sách trả NCC: Σ tiền + Σ SL trả của mọi phiếu khớp lọc, không tính phiếu huỷ. */
  async returnSummary(where: Prisma.StockAdjustmentWhereInput) {
    const live: Prisma.StockAdjustmentWhereInput = {
      AND: [where, { isDeleted: false, status: { not: ReceiptStatus.CANCELLED } }],
    };
    const [money, qty] = await Promise.all([
      this.prisma.stockAdjustment.aggregate({
        where: live,
        _sum: { goodsAmount: true, discountAmount: true, refundExpenseAmount: true, totalAmount: true, supplierPaid: true },
      }),
      this.prisma.stockAdjustmentItem.aggregate({ where: { isDeleted: false, adjustment: live }, _sum: { quantity: true } }),
    ]);
    return {
      goodsAmount: money._sum.goodsAmount ?? 0n,
      discount: money._sum.discountAmount ?? 0n,
      refundExpense: money._sum.refundExpenseAmount ?? 0n,
      totalAmount: money._sum.totalAmount ?? 0n,
      supplierPaid: money._sum.supplierPaid ?? 0n,
      // Dòng trả lưu delta âm.
      totalQty: -(qty._sum.quantity ?? 0),
    };
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
      select: { id: true, status: true, type: true, branchId: true, goodsReceiptId: true, refundExpenses: true },
    });
  }

  findBranch(tx: Prisma.TransactionClient, id: string) {
    return tx.branch.findFirst({ where: { id, isDeleted: false }, select: { id: true, status: true } });
  }

  findSupplier(tx: Prisma.TransactionClient, id: string) {
    return tx.supplier.findFirst({ where: { id, isDeleted: false }, select: { id: true } });
  }

  /** Nhân sự chọn được làm người xuất/trả/nhận: nhân viên đang làm của chi nhánh + ADMIN (như người nhập hàng). */
  findStaffCandidates(branchId?: string) {
    return this.prisma.user.findMany({
      where: { ...STAFF_WHERE, ...(branchId ? { OR: [{ branchId }, { role: { code: 'ADMIN' } }] } : {}) },
      select: { id: true, fullName: true },
      orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
    });
  }

  async isValidStaff(tx: Prisma.TransactionClient, userId: string, branchId: string): Promise<boolean> {
    const found = await tx.user.findFirst({
      where: { id: userId, ...STAFF_WHERE, OR: [{ branchId }, { role: { code: 'ADMIN' } }] },
      select: { id: true },
    });
    return Boolean(found);
  }

  findInternalUseType(tx: Prisma.TransactionClient, id: string) {
    return tx.internalUseType.findFirst({ where: { id, isDeleted: false }, select: { id: true } });
  }

  /** Đặt cờ sao; trả số dòng ghi (0 = không thấy trong phạm vi). */
  async setFavourite(id: string, scopeWhere: { branchId?: string }, isFavourite: boolean): Promise<number> {
    const res = await this.prisma.stockAdjustment.updateMany({
      where: { id, isDeleted: false, ...scopeWhere },
      data: { isFavourite },
    });
    return res.count;
  }

  /** Lô của chi nhánh — lô chi nhánh khác coi như không tồn tại. */
  findBatches(tx: Prisma.TransactionClient, branchId: string, ids: readonly string[]): Promise<DraftBatch[]> {
    return tx.stockBatch.findMany({
      where: { id: { in: [...ids] }, branchId, isDeleted: false },
      select: { id: true, productId: true, quantityOnHand: true, batchNumber: true, importPrice: true },
    });
  }

  /**
   * Như `findBatches` nhưng khoá `FOR UPDATE` (thứ tự `id`, như mọi chỗ khoá lô): hai lần lập phiếu kiểm kê cùng lô
   * chạy nối tiếp. Lọc chi nhánh ngay trong câu khoá — không ai giữ được khoá lô của chi nhánh khác.
   */
  lockBatches(tx: Prisma.TransactionClient, branchId: string, ids: readonly string[]): Promise<DraftBatch[]> {
    if (!ids.length) return Promise.resolve([]);
    return tx.$queryRaw<DraftBatch[]>(Prisma.sql`
      SELECT "id", "productId", "quantityOnHand", "batchNumber", "importPrice"
      FROM "stock_batches"
      WHERE "id" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
        AND "branchId" = ${branchId}::uuid AND "isDeleted" = false
      ORDER BY "id"
      FOR UPDATE`);
  }

  /** Một dòng kiểm kê thuộc phiếu nháp đang giữ một trong các lô (nếu có). */
  async findPendingStockTake(tx: Prisma.TransactionClient, batchIds: readonly string[], excludeAdjustmentId?: string) {
    const item = await tx.stockAdjustmentItem.findFirst({
      where: {
        batchId: { in: [...batchIds] },
        isDeleted: false,
        adjustment: {
          type: AdjustmentType.STOCK_TAKE,
          status: ReceiptStatus.DRAFT,
          isDeleted: false,
          // Sửa nháp: chính phiếu đang sửa không tính là "phiếu khác giữ lô".
          ...(excludeAdjustmentId ? { id: { not: excludeAdjustmentId } } : {}),
        },
      },
      select: { batch: { select: { batchNumber: true } }, adjustment: { select: { code: true } } },
    });
    return item ? { batchNumber: item.batch.batchNumber, code: item.adjustment.code } : null;
  }

  /**
   * Cảnh báo trước khi cân bằng phiếu kiểm kê (như mock `/stock-counts/:id/warnings`):
   * - `movedLots`: lô trong phiếu mà tồn hiện tại khác số sổ sách đã chụp (có bán/nhập sau lúc đếm);
   * - `newLots`: lô còn hàng của cùng sản phẩm, cùng chi nhánh, tạo SAU lúc lập phiếu và chưa có trong phiếu.
   */
  async findStockTakeWarnings(adjustmentId: string, scopeWhere: { branchId?: string }) {
    const head = await this.prisma.stockAdjustment.findFirst({
      where: { id: adjustmentId, isDeleted: false, type: AdjustmentType.STOCK_TAKE, ...scopeWhere },
      select: {
        branchId: true,
        createdAt: true,
        items: {
          where: { isDeleted: false },
          select: {
            productId: true,
            systemQuantity: true,
            product: { select: { name: true } },
            batch: { select: { id: true, batchNumber: true, quantityOnHand: true } },
          },
        },
      },
    });
    if (!head) return null;
    const inDoc = new Set(head.items.map((i) => i.batch.id));
    const fresh = await this.prisma.stockBatch.findMany({
      where: {
        branchId: head.branchId,
        productId: { in: [...new Set(head.items.map((i) => i.productId))] },
        createdAt: { gt: head.createdAt },
        quantityOnHand: { gt: 0 },
        isDeleted: false,
        id: { notIn: [...inDoc] },
      },
      select: { id: true, batchNumber: true, quantityOnHand: true, product: { select: { name: true } } },
    });
    return {
      newLots: fresh.map((b) => ({ lotId: b.id, lotNumber: b.batchNumber, drugName: b.product.name, qtyOnHand: b.quantityOnHand })),
      movedLots: head.items
        .filter((i) => i.systemQuantity !== null && i.systemQuantity !== i.batch.quantityOnHand)
        .map((i) => ({
          lotId: i.batch.id,
          lotNumber: i.batch.batchNumber,
          drugName: i.product.name,
          systemQtyAtSnapshot: i.systemQuantity ?? 0,
          systemQtyNow: i.batch.quantityOnHand,
        })),
    };
  }

  /** Mã đã dùng chưa — quét cả phiếu đã xoá mềm/huỷ (unique index toàn cục). `exceptId`: phiếu đang sửa. */
  async codeExists(tx: Prisma.TransactionClient, code: string, exceptId?: string): Promise<boolean> {
    return (await tx.stockAdjustment.count({ where: { code, ...(exceptId ? { id: { not: exceptId } } : {}) } })) > 0;
  }

  /**
   * Sửa nháp: xoá hẳn dòng cũ rồi ghi dòng mới. Dòng nháp chưa có bút toán sổ kho tham chiếu (bút toán chỉ ghi lúc xác
   * nhận) nên xoá vật lý an toàn, và tránh vướng unique (adjustmentId, batchId) khi giữ lại cùng lô.
   */
  async replaceItems(
    tx: Prisma.TransactionClient,
    adjustmentId: string,
    rows: Prisma.StockAdjustmentItemCreateManyInput[],
  ): Promise<void> {
    await tx.stockAdjustmentItem.deleteMany({ where: { adjustmentId } });
    await tx.stockAdjustmentItem.createMany({ data: rows });
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
      // unitCost: giá vốn đã chốt lúc xác nhận — huỷ phiếu đã xác nhận đảo đúng giá này.
      select: {
        id: true, batchId: true, systemQuantity: true, actualQuantity: true, quantity: true, unitCost: true, reason: true,
        goodsReceiptItemId: true,
      },
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
