import { Inject, Injectable } from '@nestjs/common';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { todayInVietnam } from 'src/common/utils/date-only.util';
import { InventoryReportQuery } from './dtos/inventory-report.query';
import { InventoryReportRepository } from './inventory-report.repository';
import { REPORT_CACHE, ReportCache } from './report-cache';
import { resolveReportScope } from './report-scope';

export const INVENTORY_REPORT_TTL_MS = 60_000;

/** Khớp `inventoryReportSchema` của FE (`src/api/contract/report.ts`). */
export interface InventoryReportResponse {
  lotCount: number;
  drugCount: number;
  estimatedValue: number;
  inTransitQty: number;
  byBranch: { branchId: string; branchName: string; lotCount: number; estimatedValue: number }[];
  expirySummary: { expired: number; critical: number; warning: number; info: number; ok: number };
}

@Injectable()
export class InventoryReportService {
  constructor(
    private readonly repo: InventoryReportRepository,
    @Inject(REPORT_CACHE) private readonly cache: ReportCache,
  ) {}

  async inventoryReport(query: InventoryReportQuery, actor: RequestActor): Promise<InventoryReportResponse> {
    const { branchIds, scopeKey } = resolveReportScope(actor, query.branchIds);
    const key = `inventory|${(branchIds ?? []).join(',')}|${scopeKey}`;
    const cached = this.cache.get<InventoryReportResponse>(key);
    if (cached) return cached;

    const today = todayInVietnam();
    const [rows, drugCount, inTransit] = await Promise.all([
      this.repo.byBranch(today, branchIds),
      this.repo.distinctProducts(branchIds),
      this.repo.inTransitQty(branchIds),
    ]);

    const expirySummary = { expired: 0, critical: 0, warning: 0, info: 0, ok: 0 };
    let lotCount = 0;
    let value = 0n;
    for (const row of rows) {
      lotCount += row.lotCount;
      value += row.value;
      for (const bucket of Object.keys(expirySummary) as (keyof typeof expirySummary)[]) {
        expirySummary[bucket] += row[bucket];
      }
    }

    const report: InventoryReportResponse = {
      lotCount,
      drugCount,
      estimatedValue: Number(value),
      inTransitQty: Number(inTransit),
      byBranch: rows.map((row) => ({
        branchId: row.branchId,
        branchName: row.branchName,
        lotCount: row.lotCount,
        estimatedValue: Number(row.value),
      })),
      expirySummary,
    };
    this.cache.set(key, report, INVENTORY_REPORT_TTL_MS);
    return report;
  }
}
