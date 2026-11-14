import { Inject, Injectable } from '@nestjs/common';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';
import { addDaysToDateOnly, daysBetweenDateOnly } from 'src/common/utils/date-only.util';
import { SalesReportQuery } from './dtos/sales-report.query';
import { REPORT_CACHE, ReportCache } from './report-cache';
import { resolveReportScope } from './report-scope';
import { SalesReportRepository } from './sales-report.repository';

export const SALES_REPORT_MAX_DAYS = 366;
export const SALES_REPORT_TTL_MS = 60_000;
export const SALES_REPORT_TOP_LIMIT = 10;

/** Khớp `salesReportSchema` của FE (`src/api/contract/report.ts`). */
export interface SalesReportResponse {
  totalRevenue: number;
  orderCount: number;
  avgOrderValue: number;
  totalCogs: number;
  grossProfit: number;
  grossMarginPct: number | null;
  daily: { date: string; revenue: number; orders: number; cogs: number; grossProfit: number }[];
  byBranch: {
    branchId: string;
    branchName: string;
    revenue: number;
    orderCount: number;
    cogs: number;
    grossProfit: number;
    grossMarginPct: number | null;
  }[];
  topDrugs: {
    drugId: string;
    drugName: string;
    qtyInBase: number;
    revenue: number;
    cogs: number;
    grossProfit: number;
    grossMarginPct: number | null;
  }[];
}

/** Lãi gộp / doanh thu × 100, 1 chữ số thập phân; doanh thu ≤ 0 → null. */
function marginPct(profit: bigint, revenue: bigint): number | null {
  if (revenue <= 0n) return null;
  return Math.round((Number(profit) * 1000) / Number(revenue)) / 10;
}

@Injectable()
export class SalesReportService {
  constructor(
    private readonly repo: SalesReportRepository,
    @Inject(REPORT_CACHE) private readonly cache: ReportCache,
  ) {}

  async salesReport(query: SalesReportQuery, actor: RequestActor): Promise<SalesReportResponse> {
    this.assertRange(query.from, query.to);
    const topBy = query.topBy ?? 'revenue';
    const { branchIds, scopeKey } = resolveReportScope(actor, query.branchIds);
    const key = `${query.from}|${query.to}|${(branchIds ?? []).join(',')}|${scopeKey}|${topBy}`;
    const cached = this.cache.get<SalesReportResponse>(key);
    if (cached) return cached;

    const filter = { from: query.from, to: query.to, branchIds };
    const [daily, byBranch, top] = await Promise.all([
      this.repo.daily(filter),
      this.repo.byBranch(filter),
      // Chỉ ADMIN không lọc chi nhánh mới đọc bảng chuỗi; PM và truy vấn có lọc giữ bảng theo chi nhánh.
      branchIds
        ? this.repo.topProducts(filter, SALES_REPORT_TOP_LIMIT, topBy)
        : this.repo.topProductsChain(filter, SALES_REPORT_TOP_LIMIT, topBy),
    ]);

    const byDate = new Map(daily.map((row) => [row.date, row]));
    const days: SalesReportResponse['daily'] = [];
    let totalRevenue = 0n;
    let totalCogs = 0n;
    let orderCount = 0;
    for (let date = query.from; date <= query.to; date = addDaysToDateOnly(date, 1)) {
      const row = byDate.get(date);
      const revenue = row?.revenue ?? 0n;
      const cogs = row?.cogs ?? 0n;
      days.push({
        date,
        revenue: Number(revenue),
        orders: row?.orders ?? 0,
        cogs: Number(cogs),
        grossProfit: Number(revenue - cogs),
      });
      totalRevenue += revenue;
      totalCogs += cogs;
      orderCount += row?.orders ?? 0;
    }

    const report: SalesReportResponse = {
      totalRevenue: Number(totalRevenue),
      orderCount,
      avgOrderValue: orderCount > 0 ? Math.round(Number(totalRevenue) / orderCount) : 0,
      totalCogs: Number(totalCogs),
      grossProfit: Number(totalRevenue - totalCogs),
      grossMarginPct: marginPct(totalRevenue - totalCogs, totalRevenue),
      daily: days,
      byBranch: byBranch.map((row) => ({
        branchId: row.branchId,
        branchName: row.branchName,
        revenue: Number(row.revenue),
        orderCount: row.orderCount,
        cogs: Number(row.cogs),
        grossProfit: Number(row.revenue - row.cogs),
        grossMarginPct: marginPct(row.revenue - row.cogs, row.revenue),
      })),
      topDrugs: top.map((row) => ({
        drugId: row.productId,
        drugName: row.productName,
        qtyInBase: row.qtyBase,
        revenue: Number(row.revenue),
        cogs: Number(row.cogs),
        grossProfit: Number(row.revenue - row.cogs),
        grossMarginPct: marginPct(row.revenue - row.cogs, row.revenue),
      })),
    };
    this.cache.set(key, report, SALES_REPORT_TTL_MS);
    return report;
  }

  private assertRange(from: string, to: string): void {
    const days = daysBetweenDateOnly(from, to) + 1;
    if (days < 1) {
      throw new ErrorException({ code: ErrorCode.HTTP_BAD_REQUEST, message: 'from phải trước hoặc bằng to' });
    }
    if (days > SALES_REPORT_MAX_DAYS) {
      throw new ErrorException({
        code: ErrorCode.HTTP_BAD_REQUEST,
        message: `Khoảng ngày tối đa ${SALES_REPORT_MAX_DAYS} ngày`,
      });
    }
  }
}
