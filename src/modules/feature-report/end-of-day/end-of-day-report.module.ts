import { Module } from '@nestjs/common';
import { AuthzModule } from '../../feature-auth/authz/authz.module';
import { PermissionModule } from '../../feature-auth/permission/permission.module';
import { InMemoryReportCache, REPORT_CACHE } from '../report-cache';
import { EndOfDayReportController } from './end-of-day-report.controller';
import { EndOfDayReportRepository } from './end-of-day-report.repository';
import { EndOfDayReportService } from './end-of-day-report.service';

/** Báo cáo cuối ngày: đọc thẳng bảng đơn / thanh toán / phiếu nhập / phiếu chi NCC, cache RAM 60 giây. */
@Module({
  imports: [PermissionModule, AuthzModule],
  controllers: [EndOfDayReportController],
  providers: [
    EndOfDayReportRepository,
    EndOfDayReportService,
    { provide: REPORT_CACHE, useFactory: () => new InMemoryReportCache() },
  ],
})
export class EndOfDayReportModule {}
