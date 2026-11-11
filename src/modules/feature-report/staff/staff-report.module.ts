import { Module } from '@nestjs/common';
import { AuthzModule } from '../../feature-auth/authz/authz.module';
import { PermissionModule } from '../../feature-auth/permission/permission.module';
import { InMemoryReportCache, REPORT_CACHE } from '../report-cache';
import { StaffReportController } from './staff-report.controller';
import { StaffReportRepository } from './staff-report.repository';
import { StaffReportService } from './staff-report.service';

/** Báo cáo nhân viên: đọc thẳng bảng đơn/thanh toán, cache RAM riêng của module. */
@Module({
  imports: [PermissionModule, AuthzModule],
  controllers: [StaffReportController],
  providers: [
    StaffReportRepository,
    StaffReportService,
    { provide: REPORT_CACHE, useFactory: () => new InMemoryReportCache() },
  ],
})
export class StaffReportModule {}
