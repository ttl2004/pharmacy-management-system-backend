import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';

export interface InventoryBranchRow {
  branchId: string;
  branchName: string;
  lotCount: number;
  value: bigint;
  expired: number;
  critical: number;
  warning: number;
  info: number;
  ok: number;
}

/** Đọc thẳng `stock_batches` / `stock_transfers`. Mọi giá trị truyền vào đều đi qua tham số `Prisma.sql`. */
@Injectable()
export class InventoryReportRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Mỗi chi nhánh (chưa xoá) trong phạm vi một dòng, kể cả chi nhánh 0 tồn. Số ngày còn hạn = `expiryDate − today`
   * (cả hai là ngày, `today` là ngày giờ VN do service truyền): ≤ 0 hết hạn, 1–30 critical, 31–60 warning, 61–90 info.
   */
  byBranch(today: string, branchIds?: string[]): Promise<InventoryBranchRow[]> {
    const only = branchIds?.length ? Prisma.sql` AND b."id" = ANY(${branchIds}::uuid[])` : Prisma.empty;
    return this.prisma.$queryRaw<InventoryBranchRow[]>(Prisma.sql`
      SELECT b."id" AS "branchId", b."name" AS "branchName",
             COALESCE(s."lotCount", 0)::int AS "lotCount", COALESCE(s."value", 0)::bigint AS "value",
             COALESCE(s."expired", 0)::int AS "expired", COALESCE(s."critical", 0)::int AS "critical",
             COALESCE(s."warning", 0)::int AS "warning", COALESCE(s."info", 0)::int AS "info",
             COALESCE(s."ok", 0)::int AS "ok"
      FROM branches b
      LEFT JOIN (
        SELECT sb."branchId",
               COUNT(*) AS "lotCount",
               SUM(sb."quantityOnHand"::bigint * sb."importPrice") AS "value",
               COUNT(*) FILTER (WHERE d.days <= 0) AS "expired",
               COUNT(*) FILTER (WHERE d.days BETWEEN 1 AND 30) AS "critical",
               COUNT(*) FILTER (WHERE d.days BETWEEN 31 AND 60) AS "warning",
               COUNT(*) FILTER (WHERE d.days BETWEEN 61 AND 90) AS "info",
               COUNT(*) FILTER (WHERE d.days > 90) AS "ok"
        FROM stock_batches sb
        CROSS JOIN LATERAL (SELECT (sb."expiryDate" - ${today}::date) AS days) d
        WHERE sb."isDeleted" = false AND sb."quantityOnHand" > 0
        GROUP BY sb."branchId"
      ) s ON s."branchId" = b."id"
      WHERE b."isDeleted" = false${only}
      ORDER BY COALESCE(s."value", 0) DESC, b."name", b."id"`);
  }

  /** Số sản phẩm khác nhau trong toàn phạm vi (`DISTINCT` không cộng dồn được qua chi nhánh). */
  async distinctProducts(branchIds?: string[]): Promise<number> {
    const only = branchIds?.length ? Prisma.sql` AND sb."branchId" = ANY(${branchIds}::uuid[])` : Prisma.empty;
    const [row] = await this.prisma.$queryRaw<{ n: number }[]>(Prisma.sql`
      SELECT COUNT(DISTINCT sb."productId")::int AS "n"
      FROM stock_batches sb
      JOIN branches b ON b."id" = sb."branchId" AND b."isDeleted" = false
      WHERE sb."isDeleted" = false AND sb."quantityOnHand" > 0${only}`);
    return row?.n ?? 0;
  }

  /** Tổng số lượng (đơn vị cơ bản) phiếu IN_TRANSIT có chi nhánh gửi HOẶC nhận trong phạm vi; mỗi dòng đếm một lần. */
  async inTransitQty(branchIds?: string[]): Promise<bigint> {
    const only = branchIds?.length
      ? Prisma.sql` AND (t."fromBranchId" = ANY(${branchIds}::uuid[]) OR t."toBranchId" = ANY(${branchIds}::uuid[]))`
      : Prisma.empty;
    const [row] = await this.prisma.$queryRaw<{ qty: bigint }[]>(Prisma.sql`
      SELECT COALESCE(SUM(i."quantity"), 0)::bigint AS "qty"
      FROM stock_transfers t
      JOIN stock_transfer_items i ON i."transferId" = t."id" AND i."isDeleted" = false
      WHERE t."status" = 'IN_TRANSIT' AND t."isDeleted" = false${only}`);
    return row?.qty ?? 0n;
  }
}
