import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';

export interface SalesReportFilter {
  from: string;
  to: string;
  /** Rỗng/undefined = mọi chi nhánh. */
  branchIds?: string[];
}

export interface DailyRow {
  date: string;
  orders: number;
  revenue: bigint;
  cogs: bigint;
}
export interface BranchRow {
  branchId: string;
  branchName: string;
  orderCount: number;
  revenue: bigint;
  cogs: bigint;
}
export interface ProductRow {
  productId: string;
  productName: string;
  qtyBase: number;
  revenue: bigint;
  cogs: bigint;
}

export type SalesTopBy = 'revenue' | 'grossProfit';

/** Đọc bảng tổng hợp doanh thu. Mọi giá trị người dùng truyền vào đều đi qua tham số `Prisma.sql`. */
@Injectable()
export class SalesReportRepository {
  constructor(private readonly prisma: PrismaService) {}

  private scope(filter: SalesReportFilter, alias: string): Prisma.Sql {
    const branch = filter.branchIds?.length
      ? Prisma.sql` AND ${Prisma.raw(alias)}."branchId" = ANY(${filter.branchIds}::uuid[])`
      : Prisma.empty;
    return Prisma.sql`${Prisma.raw(alias)}."date" BETWEEN ${filter.from}::date AND ${filter.to}::date${branch}`;
  }

  /** `grossProfit` = SUM(doanh thu) − SUM(giá vốn), hoà → doanh thu rồi id; `revenue` giữ thứ tự cũ. */
  private innerOrder(topBy: SalesTopBy): Prisma.Sql {
    return topBy === 'grossProfit'
      ? Prisma.sql`SUM(s."revenue") - SUM(s."cogsAmount") DESC, SUM(s."revenue") DESC, s."productId"`
      : Prisma.sql`SUM(s."revenue") DESC, SUM(s."qtyBase") DESC, s."productId"`;
  }

  private outerOrder(topBy: SalesTopBy): Prisma.Sql {
    return topBy === 'grossProfit'
      ? Prisma.sql`t."revenue" - t."cogs" DESC, t."revenue" DESC, p."id"`
      : Prisma.sql`t."revenue" DESC, t."qtyBase" DESC, p."id"`;
  }

  daily(filter: SalesReportFilter): Promise<DailyRow[]> {
    return this.prisma.$queryRaw<DailyRow[]>(Prisma.sql`
      SELECT to_char(s."date", 'YYYY-MM-DD') AS "date", SUM(s."orderCount")::int AS "orders", SUM(s."revenue")::bigint AS "revenue",
             SUM(s."cogsAmount")::bigint AS "cogs"
      FROM sales_daily s
      WHERE ${this.scope(filter, 's')}
      GROUP BY s."date"
      ORDER BY s."date"`);
  }

  /** Mọi chi nhánh trong phạm vi (kể cả chi nhánh 0đ, như mock FE); chi nhánh đã xoá chỉ hiện nếu có doanh thu. */
  byBranch(filter: SalesReportFilter): Promise<BranchRow[]> {
    const only = filter.branchIds?.length ? Prisma.sql` AND b."id" = ANY(${filter.branchIds}::uuid[])` : Prisma.empty;
    return this.prisma.$queryRaw<BranchRow[]>(Prisma.sql`
      SELECT b."id" AS "branchId", b."name" AS "branchName",
             COALESCE(s."orderCount", 0)::int AS "orderCount", COALESCE(s."revenue", 0)::bigint AS "revenue",
             COALESCE(s."cogs", 0)::bigint AS "cogs"
      FROM branches b
      LEFT JOIN (
        SELECT s."branchId", SUM(s."orderCount") AS "orderCount", SUM(s."revenue") AS "revenue", SUM(s."cogsAmount") AS "cogs"
        FROM sales_daily s
        WHERE ${this.scope(filter, 's')}
        GROUP BY s."branchId"
      ) s ON s."branchId" = b."id"
      WHERE (b."isDeleted" = false OR s."branchId" IS NOT NULL)${only}
      ORDER BY "revenue" DESC, b."name", b."id"`);
  }

  /** Toàn chuỗi (không lọc chi nhánh): đọc bảng gộp mọi chi nhánh, nhỏ hơn ~10 lần. */
  topProductsChain(
    filter: Pick<SalesReportFilter, 'from' | 'to'>,
    limit: number,
    topBy: SalesTopBy = 'revenue',
  ): Promise<ProductRow[]> {
    return this.prisma.$queryRaw<ProductRow[]>(Prisma.sql`
      SELECT p."id" AS "productId", p."name" AS "productName", t."qtyBase"::int AS "qtyBase", t."revenue"::bigint AS "revenue", t."cogs"::bigint AS "cogs"
      FROM (
        SELECT s."productId", SUM(s."qtyBase") AS "qtyBase", SUM(s."revenue") AS "revenue", SUM(s."cogsAmount") AS "cogs"
        FROM sales_daily_product_chain s
        WHERE s."date" BETWEEN ${filter.from}::date AND ${filter.to}::date
        GROUP BY s."productId"
        HAVING SUM(s."qtyBase") > 0
        ORDER BY ${this.innerOrder(topBy)}
        LIMIT ${limit}
      ) t
      JOIN products p ON p."id" = t."productId"
      ORDER BY ${this.outerOrder(topBy)}`);
  }

  topProducts(filter: SalesReportFilter, limit: number, topBy: SalesTopBy = 'revenue'): Promise<ProductRow[]> {
    return this.prisma.$queryRaw<ProductRow[]>(Prisma.sql`
      SELECT p."id" AS "productId", p."name" AS "productName", t."qtyBase"::int AS "qtyBase", t."revenue"::bigint AS "revenue", t."cogs"::bigint AS "cogs"
      FROM (
        SELECT s."productId", SUM(s."qtyBase") AS "qtyBase", SUM(s."revenue") AS "revenue", SUM(s."cogsAmount") AS "cogs"
        FROM sales_daily_product s
        WHERE ${this.scope(filter, 's')}
        GROUP BY s."productId"
        HAVING SUM(s."qtyBase") > 0
        ORDER BY ${this.innerOrder(topBy)}
        LIMIT ${limit}
      ) t
      JOIN products p ON p."id" = t."productId"
      ORDER BY ${this.outerOrder(topBy)}`);
  }
}
