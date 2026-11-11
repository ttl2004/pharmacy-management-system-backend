import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';

export interface SupplierReportFilter {
  /** 00:00 giờ VN của `from`, quy ra UTC (gồm). */
  start: Date;
  /** 00:00 giờ VN của ngày sau `to`, quy ra UTC (không gồm). */
  end: Date;
  /** `undefined` = toàn chuỗi. */
  branchIds?: string[];
  supplierId?: string;
}

/** Một thành phần nợ của một NCC: `opening` = phát sinh trước `start`, `period` = trong `[start, end)`. */
export interface DebtComponentRow {
  supplierId: string;
  opening: bigint;
  period: bigint;
  /** Số chứng từ trong kỳ. */
  count: number;
}

export interface SupplierNameRow {
  id: string;
  code: string;
  name: string;
}

export interface TopProductRow {
  productId: string;
  productName: string;
  qtyBase: number;
  amount: bigint;
}

/**
 * Đọc thẳng các bảng gốc, mỗi thành phần một câu `GROUP BY supplierId` (số dòng = số NCC): tổng trước mốc đầu và
 * tổng trong kỳ nằm CÙNG một lần quét nhờ `FILTER`. Điều kiện thời gian viết `col < $end` để dùng được chỉ mục.
 * Công thức nợ khớp `supplier-debt-ledger.builder` và `SupplierListWithTotalsRepository` (chứng từ huỷ = 0).
 */
@Injectable()
export class SupplierReportRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Phiếu nhập CONFIRMED (chưa huỷ, chưa xoá) theo `confirmedAt`: tổng `totalAmount`. */
  receipts(f: SupplierReportFilter): Promise<DebtComponentRow[]> {
    return this.component(Prisma.sql`
      SELECT r."supplierId" AS "supplierId",
        COALESCE(SUM(r."totalAmount") FILTER (WHERE r."confirmedAt" < ${f.start}), 0)::bigint AS opening,
        COALESCE(SUM(r."totalAmount") FILTER (WHERE r."confirmedAt" >= ${f.start}), 0)::bigint AS period,
        (COUNT(*) FILTER (WHERE r."confirmedAt" >= ${f.start}))::int AS count
      FROM "goods_receipts" r
      WHERE r."status" = 'CONFIRMED' AND r."isDeleted" = false AND r."confirmedAt" < ${f.end}
        ${this.branchCond(f, 'r')} ${this.supplierCond(f, 'r')}
      GROUP BY r."supplierId"`);
  }

  /** Phần phân bổ của phiếu chi chưa huỷ theo `paidAt`, vào phiếu nhập thuộc phạm vi chi nhánh. */
  payments(f: SupplierReportFilter): Promise<DebtComponentRow[]> {
    return this.component(Prisma.sql`
      SELECT p."supplierId" AS "supplierId",
        COALESCE(SUM(a."amount") FILTER (WHERE p."paidAt" < ${f.start}), 0)::bigint AS opening,
        COALESCE(SUM(a."amount") FILTER (WHERE p."paidAt" >= ${f.start}), 0)::bigint AS period,
        (COUNT(DISTINCT p."id") FILTER (WHERE p."paidAt" >= ${f.start}))::int AS count
      FROM "supplier_payments" p
      JOIN "supplier_payment_allocations" a ON a."paymentId" = p."id"
      ${f.branchIds ? Prisma.sql`JOIN "goods_receipts" r ON r."id" = a."receiptId"` : Prisma.empty}
      WHERE p."cancelledAt" IS NULL AND p."paidAt" < ${f.end}
        ${this.branchCond(f, 'r')} ${this.supplierCond(f, 'p')}
      GROUP BY p."supplierId"`);
  }

  /** Phiếu trả NCC CONFIRMED theo `confirmedAt`: phần giảm nợ = `totalAmount − supplierPaid`. */
  returns(f: SupplierReportFilter): Promise<DebtComponentRow[]> {
    return this.component(Prisma.sql`
      SELECT t."supplierId" AS "supplierId",
        COALESCE(SUM(t."totalAmount" - t."supplierPaid") FILTER (WHERE t."confirmedAt" < ${f.start}), 0)::bigint AS opening,
        COALESCE(SUM(t."totalAmount" - t."supplierPaid") FILTER (WHERE t."confirmedAt" >= ${f.start}), 0)::bigint AS period,
        (COUNT(*) FILTER (WHERE t."confirmedAt" >= ${f.start}))::int AS count
      FROM "stock_adjustments" t
      WHERE t."type" = 'RETURN_TO_SUPPLIER' AND t."status" = 'CONFIRMED' AND t."isDeleted" = false
        AND t."supplierId" IS NOT NULL AND t."confirmedAt" < ${f.end}
        ${this.branchCond(f, 't')} ${this.supplierCond(f, 't')}
      GROUP BY t."supplierId"`);
  }

  /** Điều chỉnh nợ chưa huỷ theo `adjustedAt`, chi nhánh lập trong phạm vi: tổng `delta`. */
  adjustments(f: SupplierReportFilter): Promise<DebtComponentRow[]> {
    return this.component(Prisma.sql`
      SELECT x."supplierId" AS "supplierId",
        COALESCE(SUM(x."delta") FILTER (WHERE x."adjustedAt" < ${f.start}), 0)::bigint AS opening,
        COALESCE(SUM(x."delta") FILTER (WHERE x."adjustedAt" >= ${f.start}), 0)::bigint AS period,
        (COUNT(*) FILTER (WHERE x."adjustedAt" >= ${f.start}))::int AS count
      FROM "supplier_debt_adjustments" x
      WHERE x."cancelledAt" IS NULL AND x."adjustedAt" < ${f.end}
        ${this.branchCond(f, 'x')} ${this.supplierCond(f, 'x')}
      GROUP BY x."supplierId"`);
  }

  /** Hàng nhập nhiều nhất trong kỳ theo Σ `totalPrice` (dòng chưa xoá, phiếu CONFIRMED). */
  async topProducts(f: SupplierReportFilter, limit: number): Promise<TopProductRow[]> {
    const rows = await this.prisma.$queryRaw<
      { productId: string; productName: string; qtyBase: bigint; amount: bigint }[]
    >(Prisma.sql`
      SELECT i."productId" AS "productId", p."name" AS "productName",
        COALESCE(SUM(i."baseQuantity"), 0)::bigint AS "qtyBase",
        COALESCE(SUM(i."totalPrice"), 0)::bigint AS amount
      FROM "goods_receipts" r
      JOIN "goods_receipt_items" i ON i."receiptId" = r."id" AND i."isDeleted" = false
      JOIN "products" p ON p."id" = i."productId"
      WHERE r."status" = 'CONFIRMED' AND r."isDeleted" = false
        AND r."confirmedAt" >= ${f.start} AND r."confirmedAt" < ${f.end}
        ${this.branchCond(f, 'r')} ${this.supplierCond(f, 'r')}
      GROUP BY i."productId", p."name"
      ORDER BY amount DESC, i."productId"
      LIMIT ${limit}`);
    return rows.map((r) => ({
      productId: r.productId,
      productName: r.productName,
      qtyBase: Number(r.qtyBase),
      amount: r.amount,
    }));
  }

  /** Tên NCC của các NCC có mặt trong báo cáo — một câu cho cả danh sách. */
  suppliersByIds(ids: string[]): Promise<SupplierNameRow[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.prisma.$queryRaw<SupplierNameRow[]>(
      Prisma.sql`SELECT s."id", s."code", s."name" FROM "suppliers" s WHERE s."id" = ANY(${ids}::uuid[])`,
    );
  }

  private component(query: Prisma.Sql): Promise<DebtComponentRow[]> {
    return this.prisma.$queryRaw<DebtComponentRow[]>(query);
  }

  private branchCond(f: SupplierReportFilter, alias: string): Prisma.Sql {
    return f.branchIds
      ? Prisma.sql`AND ${Prisma.raw(`${alias}."branchId"`)} = ANY(${f.branchIds}::uuid[])`
      : Prisma.empty;
  }

  private supplierCond(f: SupplierReportFilter, alias: string): Prisma.Sql {
    return f.supplierId ? Prisma.sql`AND ${Prisma.raw(`${alias}."supplierId"`)} = ${f.supplierId}::uuid` : Prisma.empty;
  }
}
