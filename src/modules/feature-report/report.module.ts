import { Module } from '@nestjs/common';
import { AuthzModule } from '../feature-auth/authz/authz.module';
import { PermissionModule } from '../feature-auth/permission/permission.module';
import { InMemoryReportCache, REPORT_CACHE } from './report-cache';
import { SalesReportController } from './sales-report.controller';
import { SalesReportRepository } from './sales-report.repository';
import { SalesReportService } from './sales-report.service';
import { SalesRollupReconcileJob } from './sales-rollup.reconcile';
import { SalesRollupRepository } from './sales-rollup.repository';

/**
 * Báo cáo: bảng tổng hợp doanh thu do module bán hàng cập nhật (`SalesRollupRepository`, export), API báo cáo chỉ đọc
 * bảng đó. Cache là provider `REPORT_CACHE` — đổi sang Redis bằng một provider khác.
 */
@Module({
  imports: [PermissionModule, AuthzModule],
  controllers: [SalesReportController],
  providers: [
    SalesRollupRepository,
    SalesRollupReconcileJob,
    SalesReportRepository,
    SalesReportService,
    { provide: REPORT_CACHE, useFactory: () => new InMemoryReportCache() },
  ],
  exports: [SalesRollupRepository],
})
export class ReportModule {}
