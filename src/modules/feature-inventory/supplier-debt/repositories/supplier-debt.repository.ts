import { Injectable } from '@nestjs/common';
import { Prisma, ReceiptStatus } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';

export interface DebtFigures {
  /** Nợ trong phạm vi: phiếu nhập CONFIRMED + điều chỉnh chưa huỷ của chi nhánh đó (không chỉ định chi nhánh = toàn chuỗi). */
  scoped: bigint;
  /** Nợ toàn chuỗi: mọi phiếu nhập CONFIRMED + mọi điều chỉnh chưa huỷ. */
  chain: bigint;
}

/** Phiếu nhập đủ để phân bổ thanh toán. */
export interface AllocatableReceipt {
  id: string;
  code: string;
  branchId: string;
  supplierId: string;
  status: ReceiptStatus;
  totalAmount: bigint;
  paidAmount: bigint;
}

/** Đọc số liệu công nợ NCC (không ghi). Nhận `client` để chạy trong transaction của người gọi. */
@Injectable()
export class SupplierDebtRepository {
  constructor(private readonly prisma: PrismaService) {}

  async supplierExists(supplierId: string, client: Prisma.TransactionClient = this.prisma): Promise<boolean> {
    const found = await client.supplier.findFirst({ where: { id: supplierId, isDeleted: false }, select: { id: true } });
    return !!found;
  }

  /** Phiếu nhập theo id trong phạm vi chi nhánh (undefined = mọi chi nhánh). */
  findReceiptInScope(id: string, branchId: string | undefined) {
    return this.prisma.goodsReceipt.findFirst({
      where: { id, isDeleted: false, ...(branchId ? { branchId } : {}) },
      select: { id: true },
    });
  }

  /** Khoá dòng NCC đến hết transaction — điều chỉnh nợ của cùng NCC xếp hàng, `debtBefore` không bị tính trùng. */
  async lockSupplier(tx: Prisma.TransactionClient, supplierId: string): Promise<boolean> {
    const rows = await tx.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT "id" FROM "suppliers" WHERE "id" = ${supplierId}::uuid AND "isDeleted" = false FOR UPDATE`,
    );
    return rows.length > 0;
  }

  /** `branchId` undefined = phạm vi ALL. */
  async debtOf(
    supplierId: string,
    branchId: string | undefined,
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<DebtFigures> {
    const adjustmentWhere = { supplierId, cancelledAt: null };
    const [receipts, chainAdjustments, branchAdjustments] = await Promise.all([
      client.$queryRaw<{ scoped: bigint; chain: bigint }[]>(Prisma.sql`
        SELECT
          COALESCE(SUM(CASE WHEN ${branchId ?? null}::uuid IS NULL OR r."branchId" = ${branchId ?? null}::uuid
                            THEN r."totalAmount" - r."paidAmount" END), 0)::bigint AS scoped,
          COALESCE(SUM(r."totalAmount" - r."paidAmount"), 0)::bigint AS chain
        FROM "goods_receipts" r
        WHERE r."supplierId" = ${supplierId}::uuid AND r."status" = 'CONFIRMED' AND r."isDeleted" = false`),
      client.supplierDebtAdjustment.aggregate({ where: adjustmentWhere, _sum: { delta: true } }),
      branchId
        ? client.supplierDebtAdjustment.aggregate({ where: { ...adjustmentWhere, branchId }, _sum: { delta: true } })
        : null,
    ]);
    const chainAdjustment = chainAdjustments._sum.delta ?? 0n;
    // Điều chỉnh gắn với chi nhánh lập: nợ của một chi nhánh = phiếu nhập + điều chỉnh CỦA CHI NHÁNH ĐÓ.
    const scopedAdjustment = branchAdjustments ? (branchAdjustments._sum.delta ?? 0n) : chainAdjustment;
    const row = receipts[0] ?? { scoped: 0n, chain: 0n };
    return { scoped: row.scoped + scopedAdjustment, chain: row.chain + chainAdjustment };
  }

  /** Chi nhánh còn dùng được để ghi chứng từ nợ (tồn tại, chưa xoá, ACTIVE). */
  async branchUsable(tx: Prisma.TransactionClient, branchId: string): Promise<boolean> {
    const found = await tx.branch.findFirst({
      where: { id: branchId, isDeleted: false, status: 'ACTIVE' },
      select: { id: true },
    });
    return !!found;
  }

  /** Phiếu nhập theo id (mọi chi nhánh) — người gọi tự lọc phạm vi/NCC/trạng thái để báo lỗi đúng. */
  findReceiptsForAllocation(tx: Prisma.TransactionClient, ids: readonly string[]): Promise<AllocatableReceipt[]> {
    return tx.goodsReceipt.findMany({
      where: { id: { in: [...ids] }, isDeleted: false },
      select: {
        id: true,
        code: true,
        branchId: true,
        supplierId: true,
        status: true,
        totalAmount: true,
        paidAmount: true,
      },
    });
  }

  /** Phiếu CONFIRMED còn nợ của NCC, cũ trước — bảng phân bổ của dialog thanh toán. */
  findOpenReceipts(supplierId: string, branchId: string | undefined) {
    return this.prisma.$queryRaw<
      {
        id: string;
        code: string;
        receivedAt: Date | null;
        confirmedAt: Date | null;
        branchId: string;
        branchName: string;
        totalAmount: bigint;
        paidAmount: bigint;
      }[]
    >(Prisma.sql`
      SELECT r."id", r."code", r."receivedAt", r."confirmedAt", r."branchId", b."name" AS "branchName",
             r."totalAmount", r."paidAmount"
      FROM "goods_receipts" r JOIN "branches" b ON b."id" = r."branchId"
      WHERE r."supplierId" = ${supplierId}::uuid AND r."status" = 'CONFIRMED' AND r."isDeleted" = false
        AND r."totalAmount" > r."paidAmount"
        ${branchId ? Prisma.sql`AND r."branchId" = ${branchId}::uuid` : Prisma.empty}
      ORDER BY r."confirmedAt" ASC NULLS LAST, r."code" ASC`);
  }

  /** Nguồn sổ nợ: phiếu nhập đã từng xác nhận (kể cả đã huỷ sau đó) trong phạm vi. */
  findLedgerReceipts(supplierId: string, branchId: string | undefined) {
    return this.prisma.goodsReceipt.findMany({
      where: {
        supplierId,
        isDeleted: false,
        confirmedAt: { not: null },
        status: { in: [ReceiptStatus.CONFIRMED, ReceiptStatus.CANCELLED] },
        ...(branchId ? { branchId } : {}),
      },
      select: { id: true, code: true, branchId: true, status: true, confirmedAt: true, totalAmount: true },
    });
  }

  findLedgerPayments(supplierId: string) {
    return this.prisma.supplierPayment.findMany({
      where: { supplierId },
      select: {
        id: true,
        code: true,
        paidAt: true,
        createdAt: true,
        cancelledAt: true,
        allocations: {
          select: { amount: true, receipt: { select: { id: true, branchId: true, confirmedAt: true } } },
        },
      },
    });
  }

  findLedgerAdjustments(supplierId: string) {
    return this.prisma.supplierDebtAdjustment.findMany({
      where: { supplierId },
      select: { id: true, code: true, branchId: true, adjustedAt: true, createdAt: true, delta: true, cancelledAt: true },
    });
  }

  /** Lịch sử thanh toán của một phiếu nhập: mỗi phiếu chi một dòng với phần phân bổ vào phiếu này. */
  findReceiptPayments(receiptId: string) {
    return this.prisma.supplierPaymentAllocation.findMany({
      where: { receiptId },
      orderBy: [{ payment: { paidAt: 'asc' } }, { createdAt: 'asc' }],
      select: {
        amount: true,
        payment: {
          select: {
            id: true,
            code: true,
            paidAt: true,
            method: true,
            source: true,
            cancelledAt: true,
            createdByUser: { select: { id: true, fullName: true } },
          },
        },
      },
    });
  }
}
