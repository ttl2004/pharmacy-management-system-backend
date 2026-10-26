import { Injectable } from '@nestjs/common';
import { PaymentMethod, Prisma, ReceiptStatus, StockMovementType, StockRefType } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';
import {
  GoodsReceiptDetail,
  GoodsReceiptSummary,
  presentReceipt,
  RECEIPT_DETAIL_SELECT,
  RECEIPT_LIST_SELECT,
} from './goods-receipt-select';

export type { GoodsReceiptDetail, GoodsReceiptSummary };

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
  code: string;
  paymentMethod: PaymentMethod | null;
  id: string;
  status: ReceiptStatus;
  branchId: string;
  supplierId: string;
  receivedAt: Date | null;
  receiverId: string | null;
  note: string | null;
  discountAmount: bigint;
  supplierExpenseAmount: bigint;
  otherExpenseAmount: bigint;
  totalAmount: bigint;
  paidAmount: bigint;
}

/** Tổng trên mọi phiếu khớp bộ lọc, trừ phiếu huỷ (như mock). */
export interface ReceiptListSummary {
  totalAmount: bigint;
  subtotalAmount: bigint;
  discountAmount: bigint;
  paidAmount: bigint;
  totalQuantity: number;
}

export interface ReceiptPage {
  hits: (GoodsReceiptSummary & { totalQuantity: number })[];
  summary: ReceiptListSummary;
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
    const counted: Prisma.GoodsReceiptWhereInput = { AND: [fullWhere, { status: { not: ReceiptStatus.CANCELLED } }] };
    const [rows, total, sums, quantity] = await Promise.all([
      this.prisma.goodsReceipt.findMany({
        where: fullWhere,
        select: RECEIPT_LIST_SELECT,
        orderBy,
        take: limit,
        skip: (page - 1) * limit,
      }),
      this.prisma.goodsReceipt.count({ where: fullWhere }),
      this.prisma.goodsReceipt.aggregate({
        where: counted,
        _sum: { totalAmount: true, subtotalAmount: true, discountAmount: true, paidAmount: true },
      }),
      this.prisma.goodsReceiptItem.aggregate({
        where: { isDeleted: false, receipt: counted },
        _sum: { quantity: true },
      }),
    ]);
    const perReceipt = rows.length
      ? await this.prisma.goodsReceiptItem.groupBy({
          by: ['receiptId'],
          where: { isDeleted: false, receiptId: { in: rows.map((row) => row.id) } },
          _sum: { quantity: true },
        })
      : [];
    const quantityById = new Map(perReceipt.map((row) => [row.receiptId, row._sum.quantity ?? 0]));
    const hits = rows.map((row) => ({ ...presentReceipt(row), totalQuantity: quantityById.get(row.id) ?? 0 }));
    const summary: ReceiptListSummary = {
      totalAmount: sums._sum.totalAmount ?? 0n,
      subtotalAmount: sums._sum.subtotalAmount ?? 0n,
      discountAmount: sums._sum.discountAmount ?? 0n,
      paidAmount: sums._sum.paidAmount ?? 0n,
      totalQuantity: quantity._sum.quantity ?? 0,
    };
    return { hits, summary, total, page, totalPages: Math.ceil(total / limit), limit };
  }

  /** `scopeWhere` (vd `{ branchId }`) nằm ngay trong `where` — bản ghi ngoài phạm vi coi như không tồn tại. */
  findDetail(
    id: string,
    scopeWhere: { branchId?: string },
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<GoodsReceiptDetail | null> {
    return client.goodsReceipt
      .findFirst({ where: { id, isDeleted: false, ...scopeWhere }, select: RECEIPT_DETAIL_SELECT })
      .then((row) => (row ? presentReceipt(row) : null));
  }

  findStatus(tx: Prisma.TransactionClient, id: string, scopeWhere: { branchId?: string }): Promise<ReceiptHead | null> {
    return tx.goodsReceipt.findFirst({
      where: { id, isDeleted: false, ...scopeWhere },
      select: {
        id: true,
        code: true,
        paymentMethod: true,
        status: true,
        branchId: true,
        supplierId: true,
        receivedAt: true,
        receiverId: true,
        note: true,
        discountAmount: true,
        supplierExpenseAmount: true,
        otherExpenseAmount: true,
        totalAmount: true,
        paidAmount: true,
      },
    });
  }

  /**
   * Như `findStatus` nhưng KHOÁ dòng phiếu (`FOR UPDATE`) đến hết transaction rồi mới đọc: mọi thao tác đổi phiếu
   * (xác nhận, huỷ, sửa nháp, trả tiền, sửa meta) xếp hàng, và đầu phiếu đọc được là số mới nhất, không bị cũ.
   * Câu đọc đứng SAU khoá nên (READ COMMITTED) thấy cả bản commit của request vừa nhả khoá.
   */
  async findStatusForUpdate(
    tx: Prisma.TransactionClient,
    id: string,
    scopeWhere: { branchId?: string },
  ): Promise<ReceiptHead | null> {
    const locked = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT "id" FROM "goods_receipts"
      WHERE "id" = ${id}::uuid AND "isDeleted" = false
        ${scopeWhere.branchId ? Prisma.sql`AND "branchId" = ${scopeWhere.branchId}::uuid` : Prisma.empty}
      FOR UPDATE`);
    return locked.length ? this.findStatus(tx, id, scopeWhere) : null;
  }

  /** Người nhập hợp lệ: ACTIVE, chưa xoá, không phải SUPER_ADMIN/CUSTOMER, thuộc chi nhánh phiếu hoặc vai trò toàn chuỗi. */
  findReceiverCandidates(branchId?: string) {
    return this.prisma.user.findMany({
      where: {
        isDeleted: false,
        status: 'ACTIVE',
        role: { code: { notIn: ['SUPER_ADMIN', 'CUSTOMER'] } },
        ...(branchId ? { OR: [{ branchId }, { role: { code: 'ADMIN' } }] } : {}),
      },
      select: { id: true, fullName: true },
      orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
    });
  }

  async isValidReceiver(tx: Prisma.TransactionClient, userId: string, branchId: string): Promise<boolean> {
    const found = await tx.user.findFirst({
      where: {
        id: userId,
        isDeleted: false,
        status: 'ACTIVE',
        role: { code: { notIn: ['SUPER_ADMIN', 'CUSTOMER'] } },
        OR: [{ branchId }, { role: { code: 'ADMIN' } }],
      },
      select: { id: true },
    });
    return !!found;
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
        totalPrice: true,
        unitDiscount: true,
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
