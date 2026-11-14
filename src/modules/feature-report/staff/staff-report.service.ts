import { Inject, Injectable } from '@nestjs/common';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';
import { daysBetweenDateOnly } from 'src/common/utils/date-only.util';
import { REPORT_CACHE, ReportCache } from '../report-cache';
import { resolveReportScope } from '../report-scope';
import { StaffReportQuery } from './dtos/staff-report.query';
import { StaffReportRepository } from './staff-report.repository';

export const STAFF_REPORT_MAX_DAYS = 92;
export const STAFF_REPORT_TTL_MS = 60_000;

export interface StaffReportResponse {
  totals: { orderCount: number; revenue: number; cancelledCount: number; refundAmount: number };
  byStaff: {
    staffId: string;
    staffName: string;
    branchName: string | null;
    orderCount: number;
    revenue: number;
    avgOrderValue: number;
    cancelledCount: number;
    refundAmount: number;
    cogs: number;
    grossProfit: number;
  }[];
}

@Injectable()
export class StaffReportService {
  constructor(
    private readonly repo: StaffReportRepository,
    @Inject(REPORT_CACHE) private readonly cache: ReportCache,
  ) {}

  async staffReport(query: StaffReportQuery, actor: RequestActor): Promise<StaffReportResponse> {
    this.assertRange(query.from, query.to);
    const { branchIds, scopeKey } = resolveReportScope(actor, query.branchIds);
    const key = `staff|${query.from}|${query.to}|${(branchIds ?? []).join(',')}|${scopeKey}`;
    const cached = this.cache.get<StaffReportResponse>(key);
    if (cached) return cached;

    const rows = await this.repo.byStaff({ from: query.from, to: query.to, branchIds });

    const totals = { orderCount: 0, revenue: 0n, cancelledCount: 0, refundAmount: 0n };
    for (const row of rows) {
      totals.orderCount += row.orderCount;
      totals.revenue += row.revenue;
      totals.cancelledCount += row.cancelledCount;
      totals.refundAmount += row.refundAmount;
    }

    const report: StaffReportResponse = {
      totals: {
        orderCount: totals.orderCount,
        revenue: Number(totals.revenue),
        cancelledCount: totals.cancelledCount,
        refundAmount: Number(totals.refundAmount),
      },
      byStaff: rows.map((row) => ({
        staffId: row.staffId,
        staffName: row.staffName,
        branchName: row.branchName,
        orderCount: row.orderCount,
        revenue: Number(row.revenue),
        avgOrderValue: row.orderCount > 0 ? Math.round(Number(row.revenue) / row.orderCount) : 0,
        cancelledCount: row.cancelledCount,
        refundAmount: Number(row.refundAmount),
        cogs: Number(row.cogs),
        grossProfit: Number(row.revenue - row.cogs),
      })),
    };
    this.cache.set(key, report, STAFF_REPORT_TTL_MS);
    return report;
  }

  private assertRange(from: string, to: string): void {
    const days = daysBetweenDateOnly(from, to) + 1;
    if (days < 1) {
      throw new ErrorException({ code: ErrorCode.HTTP_BAD_REQUEST, message: 'from phải trước hoặc bằng to' });
    }
    if (days > STAFF_REPORT_MAX_DAYS) {
      throw new ErrorException({
        code: ErrorCode.HTTP_BAD_REQUEST,
        message: `Khoảng ngày tối đa ${STAFF_REPORT_MAX_DAYS} ngày`,
      });
    }
  }
}
