import { Inject, Injectable } from '@nestjs/common';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';
import { addDaysToDateOnly, daysBetweenDateOnly } from 'src/common/utils/date-only.util';
import { assertBranchInScope, resolveBranchScope } from '../feature-auth/permission/branch-scope';
import { SalesReportQuery } from './dtos/sales-report.query';
import { REPORT_CACHE, ReportCache } from './report-cache';
import { SalesReportRepository } from './sales-report.repository';

export const SALES_REPORT_MAX_DAYS = 366;
export const SALES_REPORT_TTL_MS = 60_000;
export const SALES_REPORT_TOP_LIMIT = 10;

/** Khớp `salesReportSchema` của FE (`src/api/contract/report.ts`). */
export interface SalesReportResponse {
  totalRevenue: number;
  orderCount: number;
  avgOrderValue: number;
  daily: { date: string; revenue: number; orders: number }[];
  byBranch: { branchId: string; branchName: string; revenue: number; orderCount: number }[];
  topDrugs: { drugId: string; drugName: string; qtyInBase: number; revenue: number }[];
}

@Injectable()
export class SalesReportService {
  constructor(
    private readonly repo: SalesReportRepository,
    @Inject(REPORT_CACHE) private readonly cache: ReportCache,
  ) {}

  async salesReport(query: SalesReportQuery, actor: RequestActor): Promise<SalesReportResponse> {
    this.assertRange(query.from, query.to);
    const scope = resolveBranchScope(actor.user);
    const requested = [...new Set(query.branchIds ?? [])].sort();
    // Kiểm quyền TRƯỚC khi nhìn cache: PM xin chi nhánh khác luôn bị 1506, dù có ai đó đã làm nóng khoá.
    for (const branchId of requested) assertBranchInScope(scope, branchId);
    const branchIds = requested.length ? requested : scope.kind === 'BRANCH' ? [scope.branchId] : undefined;

    const scopeKey = scope.kind === 'ALL' ? 'ALL' : `BRANCH:${scope.branchId}`;
    const key = `${query.from}|${query.to}|${(branchIds ?? []).join(',')}|${scopeKey}`;
    const cached = this.cache.get<SalesReportResponse>(key);
    if (cached) return cached;

    const filter = { from: query.from, to: query.to, branchIds };
    const [daily, byBranch, top] = await Promise.all([
      this.repo.daily(filter),
      this.repo.byBranch(filter),
      this.repo.topProducts(filter, SALES_REPORT_TOP_LIMIT),
    ]);

    const byDate = new Map(daily.map((row) => [row.date, row]));
    const days: SalesReportResponse['daily'] = [];
    let totalRevenue = 0n;
    let orderCount = 0;
    for (let date = query.from; date <= query.to; date = addDaysToDateOnly(date, 1)) {
      const row = byDate.get(date);
      days.push({ date, revenue: Number(row?.revenue ?? 0n), orders: row?.orders ?? 0 });
      totalRevenue += row?.revenue ?? 0n;
      orderCount += row?.orders ?? 0;
    }

    const report: SalesReportResponse = {
      totalRevenue: Number(totalRevenue),
      orderCount,
      avgOrderValue: orderCount > 0 ? Math.round(Number(totalRevenue) / orderCount) : 0,
      daily: days,
      byBranch: byBranch.map((row) => ({
        branchId: row.branchId,
        branchName: row.branchName,
        revenue: Number(row.revenue),
        orderCount: row.orderCount,
      })),
      topDrugs: top.slice(0, SALES_REPORT_TOP_LIMIT).map((row) => ({
        drugId: row.productId,
        drugName: row.productName,
        qtyInBase: row.qtyBase,
        revenue: Number(row.revenue),
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
