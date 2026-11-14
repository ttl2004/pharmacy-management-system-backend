import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';

/** Khoảng thời gian nửa mở `[start, end)` — mốc UTC của ngày giờ VN. */
export interface DayRange {
  start: Date;
  end: Date;
}

export interface PaymentMethodRow {
  method: string;
  kind: string;
  total: bigint;
}
export interface OrderCountRow {
  orderCount: number;
  cancelledCount: number;
}
export interface SupplierReceiptRow {
  count: number;
  amount: bigint;
}
export interface SupplierPaymentRow {
  method: string;
  count: number;
  amount: bigint;
}
export interface TopProductRow {
  productId: string;
  productName: string;
  qtyBase: bigint;
  amount: bigint;
}
export interface StaffRow {
  staffId: string;
  staffName: string;
  orderCount: number;
  netAmount: bigint;
}

/** Hình thức thu tại quầy có trong báo cáo (COD không phát sinh dòng tiền trong ngày). */
const SALE_METHODS = ['CASH', 'BANK_TRANSFER', 'CARD'];

/**
 * Đọc thẳng bảng gốc, tổng hợp trong PostgreSQL. Điều kiện thời gian luôn dạng `col >= start AND col < end` (không bọc
 * cột trong hàm) để dùng chỉ mục; mọi giá trị truyền vào đi qua tham số `Prisma.sql`.
 */
@Injectable()
export class EndOfDayReportRepository {
  constructor(private readonly prisma: PrismaService) {}

  private only(column: string, branchIds?: string[]): Prisma.Sql {
    return branchIds?.length ? Prisma.sql` AND ${Prisma.raw(column)} = ANY(${branchIds}::uuid[])` : Prisma.empty;
  }

  /** Σ tiền thu / hoàn thành công trong ngày, theo hình thức và loại — tối đa 6 dòng. */
  paymentsByMethod(range: DayRange, branchIds?: string[]): Promise<PaymentMethodRow[]> {
    return this.prisma.$queryRaw<PaymentMethodRow[]>(Prisma.sql`
      SELECT p."method"::text AS "method", p."kind"::text AS "kind", COALESCE(SUM(p."amount"), 0)::bigint AS "total"
      FROM payments p
      JOIN orders o ON o."id" = p."orderId"
      WHERE p."paidAt" >= ${range.start} AND p."paidAt" < ${range.end}
        AND p."status" = 'SUCCESS' AND p."method"::text = ANY(${SALE_METHODS})${this.only('o."branchId"', branchIds)}
      GROUP BY p."method", p."kind"`);
  }

  /** Đơn thu trong ngày còn COMPLETED; đơn huỷ sau thu trong ngày (có `completedAt`). */
  async orderCounts(range: DayRange, branchIds?: string[]): Promise<OrderCountRow> {
    const [row] = await this.prisma.$queryRaw<OrderCountRow[]>(Prisma.sql`
      SELECT
        (SELECT COUNT(*) FROM orders o
          WHERE o."completedAt" >= ${range.start} AND o."completedAt" < ${range.end}
            AND o."status" = 'COMPLETED' AND o."isDeleted" = false${this.only('o."branchId"', branchIds)})::int AS "orderCount",
        (SELECT COUNT(*) FROM orders o
          WHERE o."cancelledAt" >= ${range.start} AND o."cancelledAt" < ${range.end}
            AND o."completedAt" IS NOT NULL AND o."isDeleted" = false${this.only('o."branchId"', branchIds)})::int AS "cancelledCount"`);
    return row ?? { orderCount: 0, cancelledCount: 0 };
  }

  /** Phiếu nhập đã xác nhận trong ngày. */
  async supplierReceipts(range: DayRange, branchIds?: string[]): Promise<SupplierReceiptRow> {
    const [row] = await this.prisma.$queryRaw<SupplierReceiptRow[]>(Prisma.sql`
      SELECT COUNT(*)::int AS "count", COALESCE(SUM(g."totalAmount"), 0)::bigint AS "amount"
      FROM goods_receipts g
      WHERE g."status" = 'CONFIRMED' AND g."isDeleted" = false
        AND g."confirmedAt" >= ${range.start} AND g."confirmedAt" < ${range.end}${this.only('g."branchId"', branchIds)}`);
    return row ?? { count: 0, amount: 0n };
  }

  /** Phiếu chi NCC chưa huỷ, `paidAt` trong ngày, theo hình thức. */
  supplierPayments(range: DayRange, branchIds?: string[]): Promise<SupplierPaymentRow[]> {
    return this.prisma.$queryRaw<SupplierPaymentRow[]>(Prisma.sql`
      SELECT sp."method"::text AS "method", COUNT(*)::int AS "count", COALESCE(SUM(sp."amount"), 0)::bigint AS "amount"
      FROM supplier_payments sp
      WHERE sp."cancelledAt" IS NULL
        AND sp."paidAt" >= ${range.start} AND sp."paidAt" < ${range.end}${this.only('sp."branchId"', branchIds)}
      GROUP BY sp."method"`);
  }

  /** Top sản phẩm theo tiền của đơn thu trong ngày còn COMPLETED. */
  topProducts(range: DayRange, limit: number, branchIds?: string[]): Promise<TopProductRow[]> {
    return this.prisma.$queryRaw<TopProductRow[]>(Prisma.sql`
      SELECT pr."id" AS "productId", pr."name" AS "productName",
             SUM(oi."baseQuantity")::bigint AS "qtyBase", SUM(oi."totalPrice")::bigint AS "amount"
      FROM orders o
      JOIN order_items oi ON oi."orderId" = o."id" AND oi."isDeleted" = false
      JOIN products pr ON pr."id" = oi."productId"
      WHERE o."completedAt" >= ${range.start} AND o."completedAt" < ${range.end}
        AND o."status" = 'COMPLETED' AND o."isDeleted" = false${this.only('o."branchId"', branchIds)}
      GROUP BY pr."id", pr."name"
      ORDER BY "amount" DESC, "qtyBase" DESC, pr."id"
      LIMIT ${limit}`);
  }

  /**
   * Theo nhân viên lập đơn: số đơn thu trong ngày còn COMPLETED, và ròng = Σ thu − Σ hoàn của payment trong ngày gắn với
   * đơn của nhân viên đó. Đơn không có `staffId` không vào bảng này.
   */
  byStaff(range: DayRange, branchIds?: string[]): Promise<StaffRow[]> {
    return this.prisma.$queryRaw<StaffRow[]>(Prisma.sql`
      WITH pay AS (
        SELECT o."staffId" AS "staffId",
               SUM(CASE WHEN p."kind" = 'PAYMENT' THEN p."amount" ELSE -p."amount" END) AS "net"
        FROM payments p
        JOIN orders o ON o."id" = p."orderId"
        WHERE p."paidAt" >= ${range.start} AND p."paidAt" < ${range.end}
          AND p."status" = 'SUCCESS' AND p."method"::text = ANY(${SALE_METHODS})
          AND o."staffId" IS NOT NULL${this.only('o."branchId"', branchIds)}
        GROUP BY o."staffId"
      ), cnt AS (
        SELECT o."staffId" AS "staffId", COUNT(*) AS "n"
        FROM orders o
        WHERE o."completedAt" >= ${range.start} AND o."completedAt" < ${range.end}
          AND o."status" = 'COMPLETED' AND o."isDeleted" = false
          AND o."staffId" IS NOT NULL${this.only('o."branchId"', branchIds)}
        GROUP BY o."staffId"
      )
      SELECT u."id" AS "staffId", u."fullName" AS "staffName",
             COALESCE(cnt."n", 0)::int AS "orderCount", COALESCE(pay."net", 0)::bigint AS "netAmount"
      FROM pay
      FULL OUTER JOIN cnt ON cnt."staffId" = pay."staffId"
      JOIN users u ON u."id" = COALESCE(pay."staffId", cnt."staffId")
      ORDER BY "netAmount" DESC, u."fullName", u."id"`);
  }
}
