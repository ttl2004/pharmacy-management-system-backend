import { Injectable } from '@nestjs/common';
import { Prisma, ReceiptStatus, StockMovementType, StockRefType } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';

const USER_BRIEF = { select: { id: true, fullName: true } } as const;

/** Cột đọc được của phiếu nhập ở danh sách — không lộ `isDeleted`. */
const RECEIPT_LIST_SELECT = {
  id: true,
  code: true,
  status: true,
  receivedAt: true,
  subtotalAmount: true,
  discountAmount: true,
  vatAmount: true,
  totalAmount: true,
  paidAmount: true,
  paymentStatus: true,
  supplierInvoiceNo: true,
  supplierInvoiceDate: true,
  confirmedAt: true,
  cancelledAt: true,
  createdAt: true,
  updatedAt: true,
  branch: { select: { id: true, code: true, name: true } },
  supplier: { select: { id: true, code: true, name: true } },
  _count: { select: { items: { where: { isDeleted: false } } } },
} satisfies Prisma.GoodsReceiptSelect;

const RECEIPT_DETAIL_SELECT = {
  ...RECEIPT_LIST_SELECT,
  branchId: true,
  supplierId: true,
  note: true,
  cancelReason: true,
  createdByUser: USER_BRIEF,
  updatedByUser: USER_BRIEF,
  confirmedByUser: USER_BRIEF,
  cancelledByUser: USER_BRIEF,
  items: {
    where: { isDeleted: false },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      productId: true,
      productUnitId: true,
      quantity: true,
      conversionRate: true,
      baseQuantity: true,
      importPrice: true,
      totalPrice: true,
      batchNumber: true,
      manufacturingDate: true,
      expiryDate: true,
      product: { select: { id: true, code: true, name: true } },
      productUnit: { select: { id: true, unit: { select: { id: true, code: true, name: true } } } },
    },
  },
} satisfies Prisma.GoodsReceiptSelect;

export type GoodsReceiptSummary = Prisma.GoodsReceiptGetPayload<{ select: typeof RECEIPT_LIST_SELECT }>;
export type GoodsReceiptDetail = Prisma.GoodsReceiptGetPayload<{ select: typeof RECEIPT_DETAIL_SELECT }>;

/** Đơn vị nhập kèm sản phẩm — đủ để kiểm "đơn vị thuộc đúng sản phẩm, cả hai còn hoạt động" và lấy hệ số. */
export type UnitWithProduct = Prisma.ProductUnitGetPayload<{
  select: {
    id: true;
    productId: true;
    conversionRate: true;
    status: true;
    isDeleted: true;
    product: { select: { id: true; status: true; isDeleted: true; code: true } };
  };
}>;

/** Đầu phiếu tối thiểu để quyết định chuyển trạng thái — đọc trong transaction, trước khi ghi. */
export interface ReceiptHead {
  id: string;
  status: ReceiptStatus;
  branchId: string;
  supplierId: string;
  receivedAt: Date | null;
  totalAmount: bigint;
  paidAmount: bigint;
}

export interface ReceiptPage {
  hits: GoodsReceiptSummary[];
  total: number;
  page: number;
  totalPages: number;
  limit: number;
}

@Injectable()
export class GoodsReceiptRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findPage(
    where: Prisma.GoodsReceiptWhereInput,
    page: number,
    limit: number,
    orderBy: Prisma.GoodsReceiptOrderByWithRelationInput[],
  ): Promise<ReceiptPage> {
    const fullWhere = { ...where, isDeleted: false };
    const [hits, total] = await Promise.all([
      this.prisma.goodsReceipt.findMany({
        where: fullWhere,
        select: RECEIPT_LIST_SELECT,
        orderBy,
        take: limit,
        skip: (page - 1) * limit,
      }),
      this.prisma.goodsReceipt.count({ where: fullWhere }),
    ]);
    return { hits, total, page, totalPages: Math.ceil(total / limit), limit };
  }

  /** `scopeWhere` (vd `{ branchId }`) nằm ngay trong `where` — bản ghi ngoài phạm vi coi như không tồn tại. */
  findDetail(
    id: string,
    scopeWhere: { branchId?: string },
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<GoodsReceiptDetail | null> {
    return client.goodsReceipt.findFirst({
      where: { id, isDeleted: false, ...scopeWhere },
      select: RECEIPT_DETAIL_SELECT,
    });
  }

  findStatus(tx: Prisma.TransactionClient, id: string, scopeWhere: { branchId?: string }): Promise<ReceiptHead | null> {
    return tx.goodsReceipt.findFirst({
      where: { id, isDeleted: false, ...scopeWhere },
      select: {
        id: true,
        status: true,
        branchId: true,
        supplierId: true,
        receivedAt: true,
        totalAmount: true,
        paidAmount: true,
      },
    });
  }

  findBranch(tx: Prisma.TransactionClient, id: string) {
    return tx.branch.findFirst({ where: { id, isDeleted: false }, select: { id: true, status: true } });
  }

  findSupplier(tx: Prisma.TransactionClient, id: string) {
    return tx.supplier.findFirst({ where: { id, isDeleted: false }, select: { id: true, status: true } });
  }

  findUnitsWithProduct(tx: Prisma.TransactionClient, ids: readonly string[]): Promise<UnitWithProduct[]> {
    return tx.productUnit.findMany({
      where: { id: { in: [...ids] } },
      select: {
        id: true,
        productId: true,
        conversionRate: true,
        status: true,
        isDeleted: true,
        product: { select: { id: true, status: true, isDeleted: true, code: true } },
      },
    });
  }

  createHeader(tx: Prisma.TransactionClient, data: Prisma.GoodsReceiptUncheckedCreateInput) {
    return tx.goodsReceipt.create({ data, select: { id: true } });
  }

  createItems(tx: Prisma.TransactionClient, rows: Prisma.GoodsReceiptItemCreateManyInput[]) {
    return tx.goodsReceiptItem.createMany({ data: rows });
  }

  /** Dòng của phiếu nháp bị thay thế thì xoá mềm (giữ lại để đối soát ai đã sửa gì). */
  softDeleteItems(tx: Prisma.TransactionClient, receiptId: string, actorId: string) {
    return tx.goodsReceiptItem.updateMany({
      where: { receiptId, isDeleted: false },
      data: { isDeleted: true, updatedAt: new Date(), updatedBy: actorId },
    });
  }

  /**
   * Đổi trạng thái CÓ ĐIỀU KIỆN: chỉ ăn khi phiếu đang ở `from`. Trả số dòng bị sửa — 0 nghĩa là có người xác nhận/
   * huỷ trước (bấm đúp, hai người cùng thao tác). Đây là cách chặn nhập kho hai lần, không cần khoá ứng dụng.
   */
  async transition(
    tx: Prisma.TransactionClient,
    id: string,
    from: ReceiptStatus | ReceiptStatus[],
    data: Prisma.GoodsReceiptUncheckedUpdateManyInput,
  ): Promise<number> {
    const result = await tx.goodsReceipt.updateMany({
      where: { id, isDeleted: false, status: Array.isArray(from) ? { in: from } : from },
      data,
    });
    return result.count;
  }

  /** Dòng phiếu kèm hệ số quy đổi HIỆN HÀNH của đơn vị nhập (K8: lấy lúc xác nhận). */
  findItemsForConfirm(tx: Prisma.TransactionClient, receiptId: string) {
    return tx.goodsReceiptItem.findMany({
      where: { receiptId, isDeleted: false },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        productId: true,
        quantity: true,
        conversionRate: true,
        importPrice: true,
        batchNumber: true,
        manufacturingDate: true,
        expiryDate: true,
        productUnit: {
          select: {
            conversionRate: true,
            status: true,
            isDeleted: true,
            product: { select: { status: true, isDeleted: true, code: true } },
          },
        },
      },
    });
  }

  /** Ghi lại hệ số + số lượng quy đổi cho các dòng có hệ số đổi từ lúc lập phiếu — MỘT câu lệnh. */
  async updateItemConversions(
    tx: Prisma.TransactionClient,
    rows: readonly { id: string; conversionRate: number; baseQuantity: number }[],
  ): Promise<void> {
    if (!rows.length) return;
    const values = Prisma.join(
      rows.map((row) => Prisma.sql`(${row.id}::uuid, ${row.conversionRate}::int, ${row.baseQuantity}::int)`),
    );
    await tx.$executeRaw(Prisma.sql`
      UPDATE "goods_receipt_items" AS i
      SET "conversionRate" = v."rate", "baseQuantity" = v."base", "updatedAt" = now()
      FROM (VALUES ${values}) AS v("id", "rate", "base")
      WHERE i."id" = v."id"`);
  }

  /** Bút toán nhập dương mà phiếu này đã ghi — nguồn để đảo khi huỷ phiếu đã xác nhận (K4). */
  findImportMovements(tx: Prisma.TransactionClient, receiptId: string) {
    return tx.stockMovement.findMany({
      where: {
        refType: StockRefType.GOODS_RECEIPT,
        refId: receiptId,
        type: StockMovementType.IMPORT,
        quantity: { gt: 0 },
      },
      select: { batchId: true, quantity: true, unitCost: true, refItemId: true, createdAt: true },
    });
  }

  /**
   * Lô đã phát sinh XUẤT (bút toán âm của chứng từ khác) kể từ lúc phiếu này nhập — có thì không được đảo phiếu,
   * vì hàng của phiếu có thể đã bán/chuyển đi. Bút toán đảo do huỷ phiếu nhập KHÁC (IMPORT âm) không phải hàng rời kho
   * nên không tính; tồn âm / đụng phần đang giữ vẫn bị `StockLedgerService` chặn.
   */
  findBatchesMovedSince(
    tx: Prisma.TransactionClient,
    batchIds: readonly string[],
    since: Date,
    receiptId: string,
  ): Promise<{ batchId: string }[]> {
    return tx.stockMovement.findMany({
      where: {
        batchId: { in: [...batchIds] },
        quantity: { lt: 0 },
        createdAt: { gte: since },
        refId: { not: receiptId },
        type: { not: StockMovementType.IMPORT },
      },
      select: { batchId: true },
      distinct: ['batchId'],
    });
  }
}
