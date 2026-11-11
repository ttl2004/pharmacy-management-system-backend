import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';
import { vietnamDayStartUtc, addDaysToDateOnly } from 'src/common/utils/date-only.util';

export interface StaffRow {
  staffId: string;
  staffName: string;
  branchName: string | null;
  orderCount: number;
  cancelledCount: number;
  refundAmount: bigint;
  revenue: bigint;
  cogs: bigint;
}

export interface StaffFilter {
  from: string;
  to: string;
  branchIds?: string[];
}

/** Đọc thẳng `orders` / `payments` / `order_item_batches`, gộp theo nhân viên trong một câu SQL. */
@Injectable()
export class StaffReportRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Tập đơn = `completedAt` trong [đầu ngày VN của `from`, đầu ngày VN sau `to`), chưa xoá, có `staffId`.
   * Doanh thu khớp `sales_daily.revenue`: đơn COMPLETED tính tổng đơn, đơn CANCELLED (huỷ sau thu) tính tổng − hoàn.
   * Hoàn tiền chỉ có ở đơn CANCELLED nên chỉ tra cho đơn đó; gán về đơn gốc (bất kể ngày hoàn). Giá vốn chỉ tính đơn COMPLETED. Số dòng kết quả = số nhân viên.
   */
  byStaff(filter: StaffFilter): Promise<StaffRow[]> {
    const start = vietnamDayStartUtc(filter.from);
    const end = vietnamDayStartUtc(addDaysToDateOnly(filter.to, 1));
    const only = filter.branchIds?.length
      ? Prisma.sql` AND o."branchId" = ANY(${filter.branchIds}::uuid[])`
      : Prisma.empty;
    return this.prisma.$queryRaw<StaffRow[]>(Prisma.sql`
      WITH s AS (
        SELECT o."id", o."staffId", o."status", o."totalAmount"
        FROM orders o
        WHERE o."completedAt" >= ${start} AND o."completedAt" < ${end}
          AND o."status" IN ('COMPLETED', 'CANCELLED') AND o."isDeleted" = false
          AND o."staffId" IS NOT NULL${only}
      )
      SELECT s."staffId" AS "staffId", u."fullName" AS "staffName", br."name" AS "branchName",
             (COUNT(*) FILTER (WHERE s."status" = 'COMPLETED'))::int AS "orderCount",
             (COUNT(*) FILTER (WHERE s."status" = 'CANCELLED'))::int AS "cancelledCount",
             COALESCE(SUM(r."refund"), 0)::bigint AS "refundAmount",
             COALESCE(SUM(CASE WHEN s."status" = 'COMPLETED' THEN s."totalAmount" ELSE s."totalAmount" - r."refund" END), 0)::bigint AS "revenue",
             COALESCE(SUM(c."cost"), 0)::bigint AS "cogs"
      FROM s
      JOIN users u ON u."id" = s."staffId"
      LEFT JOIN branches br ON br."id" = u."branchId"
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(p."amount"), 0) AS "refund" FROM payments p
        WHERE s."status" = 'CANCELLED' AND p."orderId" = s."id" AND p."kind" = 'REFUND' AND p."status" = 'SUCCESS'
      ) r ON true
      LEFT JOIN LATERAL (
        SELECT SUM(b."quantity"::bigint * b."unitCost") AS "cost"
        FROM order_items oi
        JOIN order_item_batches b ON b."orderItemId" = oi."id"
        WHERE oi."orderId" = s."id" AND oi."isDeleted" = false AND s."status" = 'COMPLETED'
      ) c ON true
      GROUP BY s."staffId", u."fullName", br."name"
      ORDER BY 7 DESC, s."staffId"`);
  }
}
