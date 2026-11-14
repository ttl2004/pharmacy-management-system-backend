import { Module } from '@nestjs/common';
import { AuthzModule } from '../../feature-auth/authz/authz.module';
import { PermissionModule } from '../../feature-auth/permission/permission.module';
import { InMemoryReportCache, REPORT_CACHE } from '../report-cache';
import { SupplierReportController } from './supplier-report.controller';
import { SupplierReportRepository } from './supplier-report.repository';
import { SupplierReportService } from './supplier-report.service';

/** Báo cáo nhà cung cấp: đọc thẳng bảng phiếu nhập/trả/chi/điều chỉnh, cache RAM riêng của module. */
@Module({
  imports: [PermissionModule, AuthzModule],
  controllers: [SupplierReportController],
  providers: [
    SupplierReportRepository,
    SupplierReportService,
    { provide: REPORT_CACHE, useFactory: () => new InMemoryReportCache() },
  ],
})
export class SupplierReportModule {}
