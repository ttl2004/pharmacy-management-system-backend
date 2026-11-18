import { Injectable } from '@nestjs/common';
import { AdjustmentType, Prisma, ReceiptStatus } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';
import type { LedgerKind } from '../dtos/supplier-debt.query';

export interface DebtFigures {
  /**
   * Nợ trong phạm vi: phiếu nhập CONFIRMED − phiếu trả NCC CONFIRMED (phần NCC chưa hoàn) + điều chỉnh chưa huỷ của chi
   * nhánh đó (không chỉ định chi nhánh = toàn chuỗi).
   */
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
    const found = await client.supplier.findFirst({
      where: { id: supplierId, isDeleted: false },
      select: { id: true },
    });
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
    const [receipts, returns, chainAdjustments, branchAdjustments] = await Promise.all([
      client.$queryRaw<{ scoped: bigint; chain: bigint }[]>(Prisma.sql`
        SELECT
          COALESCE(SUM(CASE WHEN ${branchId ?? null}::uuid IS NULL OR r."branchId" = ${branchId ?? null}::uuid
                            THEN r."totalAmount" - r."paidAmount" END), 0)::bigint AS scoped,
          COALESCE(SUM(r."totalAmount" - r."paidAmount"), 0)::bigint AS chain
        FROM "goods_receipts" r
        WHERE r."supplierId" = ${supplierId}::uuid AND r."status" = 'CONFIRMED' AND r."isDeleted" = false`),
      // Phiếu trả NCC đã xác nhận: phần NCC chưa hoàn tiền (cần trả − đã trả) giảm nợ, gắn với chi nhánh trả.
      client.$queryRaw<{ scoped: bigint; chain: bigint }[]>(Prisma.sql`
        SELECT
          COALESCE(SUM(CASE WHEN ${branchId ?? null}::uuid IS NULL OR a."branchId" = ${branchId ?? null}::uuid
                            THEN a."totalAmount" - a."supplierPaid" END), 0)::bigint AS scoped,
          COALESCE(SUM(a."totalAmount" - a."supplierPaid"), 0)::bigint AS chain
        FROM "stock_adjustments" a
        WHERE a."supplierId" = ${supplierId}::uuid AND a."type" = 'RETURN_TO_SUPPLIER'
          AND a."status" = 'CONFIRMED' AND a."isDeleted" = false`),
      client.supplierDebtAdjustment.aggregate({ where: adjustmentWhere, _sum: { delta: true } }),
      branchId
        ? client.supplierDebtAdjustment.aggregate({ where: { ...adjustmentWhere, branchId }, _sum: { delta: true } })
        : null,
    ]);
    const chainAdjustment = chainAdjustments._sum.delta ?? 0n;
    // Điều chỉnh gắn với chi nhánh lập: nợ của một chi nhánh = phiếu nhập + điều chỉnh CỦA CHI NHÁNH ĐÓ.
    const scopedAdjustment = branchAdjustments ? (branchAdjustments._sum.delta ?? 0n) : chainAdjustment;
    const row = receipts[0] ?? { scoped: 0n, chain: 0n };
    const returned = returns[0] ?? { scoped: 0n, chain: 0n };
    return {
      scoped: row.scoped - returned.scoped + scopedAdjustment,
      chain: row.chain - returned.chain + chainAdjustment,
    };
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

  /**
   * Sổ nợ NCC — MỘT trang, tính hết trong PostgreSQL (L7): không kéo toàn bộ lịch sử chứng từ về Node. Cùng luật với
   * `buildLedger` (bản JS giữ làm chuẩn đối chiếu trong db-spec):
   * - phiếu nhập/trả NCC đã từng xác nhận trong phạm vi (huỷ sau đó → dòng CANCELLED, không cộng vào số dư);
   * - phiếu chi: −Σ phân bổ vào phiếu nhập trong phạm vi (bỏ nếu ≤ 0); mốc xếp = muộn nhất của lúc chi, lúc xác nhận các
   *   phiếu được trả, lúc lập các điều chỉnh (trong phạm vi) có trước nó;
   * - điều chỉnh của chi nhánh trong phạm vi, xếp theo lúc lập.
   * Số dư cộng dồn bằng window function theo (mốc xếp, lúc lập, mã); lọc `kind` SAU khi cộng dồn; trả mới nhất trước.
   */
  async findLedgerPage(params: {
    supplierId: string;
    branchId: string | undefined;
    kind: string | undefined;
    limit: number;
    offset: number;
  }): Promise<{ rows: LedgerPageRow[]; total: number }> {
    const { supplierId, branchId } = params;
    const inBranch = (column: string) =>
      branchId ? Prisma.sql`AND ${Prisma.raw(column)} = ${branchId}::uuid` : Prisma.empty;
    const epoch = Prisma.sql`'epoch'::timestamptz`;
    const kindFilter = params.kind ? Prisma.sql`WHERE l."kind" = ${params.kind}` : Prisma.empty;

    const ledger = Prisma.sql`
      WITH adj AS (
        SELECT d."id", d."code", d."adjustedAt", d."createdAt", d."delta", d."cancelledAt"
        FROM "supplier_debt_adjustments" d
        WHERE d."supplierId" = ${supplierId}::uuid ${inBranch('d."branchId"')}
      ),
      entries AS (
        SELECT 'RECEIPT' AS "kind", r."id", r."code", COALESCE(r."confirmedAt", ${epoch}) AS "at",
               r."totalAmount"::bigint AS "amount", r."status" = 'CANCELLED' AS "cancelled",
               COALESCE(r."confirmedAt", ${epoch}) AS "sortAt", COALESCE(r."confirmedAt", ${epoch}) AS "created"
        FROM "goods_receipts" r
        WHERE r."supplierId" = ${supplierId}::uuid AND r."isDeleted" = false AND r."confirmedAt" IS NOT NULL
          AND r."status" IN ('CONFIRMED', 'CANCELLED') ${inBranch('r."branchId"')}
        UNION ALL
        SELECT 'PAYMENT', p."id", p."code", p."paidAt", -s."amount", p."cancelledAt" IS NOT NULL,
               GREATEST(
                 p."paidAt", s."lastConfirmed",
                 (SELECT MAX(a."createdAt") FROM adj a WHERE a."createdAt" < p."createdAt")
               ),
               p."createdAt"
        FROM "supplier_payments" p
        CROSS JOIN LATERAL (
          SELECT SUM(al."amount")::bigint AS "amount", MAX(COALESCE(gr."confirmedAt", ${epoch})) AS "lastConfirmed"
          FROM "supplier_payment_allocations" al
          JOIN "goods_receipts" gr ON gr."id" = al."receiptId"
          WHERE al."paymentId" = p."id" ${inBranch('gr."branchId"')}
        ) s
        WHERE p."supplierId" = ${supplierId}::uuid AND s."amount" > 0
        UNION ALL
        SELECT 'RETURN', t."id", t."code", COALESCE(t."confirmedAt", ${epoch}),
               -(t."totalAmount" - t."supplierPaid")::bigint, t."status" = 'CANCELLED',
               COALESCE(t."confirmedAt", ${epoch}), COALESCE(t."confirmedAt", ${epoch})
        FROM "stock_adjustments" t
        WHERE t."supplierId" = ${supplierId}::uuid AND t."type" = 'RETURN_TO_SUPPLIER' AND t."isDeleted" = false
          AND t."confirmedAt" IS NOT NULL AND t."status" IN ('CONFIRMED', 'CANCELLED') ${inBranch('t."branchId"')}
        UNION ALL
        SELECT 'ADJUSTMENT', a."id", a."code", a."adjustedAt", a."delta", a."cancelledAt" IS NOT NULL,
               a."createdAt", a."createdAt"
        FROM adj a
      ),
      ledger AS (
        SELECT e.*,
               SUM(CASE WHEN e."cancelled" THEN 0 ELSE e."amount" END)
                 OVER (ORDER BY e."sortAt", e."created", e."code" COLLATE "C", e."id" ROWS UNBOUNDED PRECEDING)
                 AS "balanceAfter"
        FROM entries e
      )`;

    const [rows, [count]] = await Promise.all([
      this.prisma.$queryRaw<RawLedgerRow[]>(Prisma.sql`${ledger}
        SELECT l."kind", l."id", l."code", l."at", l."amount", l."balanceAfter"::bigint AS "balanceAfter", l."cancelled"
        FROM ledger l ${kindFilter}
        ORDER BY l."sortAt" DESC, l."created" DESC, l."code" COLLATE "C" DESC, l."id" DESC
        LIMIT ${params.limit} OFFSET ${params.offset}`),
      this.prisma.$queryRaw<{ total: number }[]>(
        Prisma.sql`${ledger} SELECT COUNT(*)::int AS "total" FROM ledger l ${kindFilter}`,
      ),
    ]);
    return {
      rows: rows.map((row) => ({
        kind: row.kind,
        id: row.id,
        code: row.code,
        at: row.at,
        amount: Number(row.amount),
        balanceAfter: Number(row.balanceAfter),
        status: row.cancelled ? 'CANCELLED' : 'COMPLETED',
      })),
      total: count?.total ?? 0,
    };
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

  /** Phiếu trả NCC đã từng xác nhận (kể cả đã huỷ sau đó) trong phạm vi — dòng "Trả hàng nhập" của sổ nợ. */
  findLedgerReturns(supplierId: string, branchId: string | undefined) {
    return this.prisma.stockAdjustment.findMany({
      where: {
        supplierId,
        type: AdjustmentType.RETURN_TO_SUPPLIER,
        isDeleted: false,
        confirmedAt: { not: null },
        status: { in: [ReceiptStatus.CONFIRMED, ReceiptStatus.CANCELLED] },
        ...(branchId ? { branchId } : {}),
      },
      select: { id: true, code: true, status: true, confirmedAt: true, totalAmount: true, supplierPaid: true },
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
      select: {
        id: true,
        code: true,
        branchId: true,
        adjustedAt: true,
        createdAt: true,
        delta: true,
        cancelledAt: true,
      },
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

interface RawLedgerRow {
  kind: LedgerKind;
  id: string;
  code: string;
  at: Date;
  amount: bigint;
  balanceAfter: bigint;
  cancelled: boolean;
}

export interface LedgerPageRow {
  kind: LedgerKind;
  id: string;
  code: string;
  at: Date;
  amount: number;
  balanceAfter: number;
  status: 'COMPLETED' | 'CANCELLED';
}
