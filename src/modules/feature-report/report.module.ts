import { Module } from '@nestjs/common';
import { SalesRollupRepository } from './sales-rollup.repository';

/** Báo cáo: bảng tổng hợp doanh thu do module bán hàng cập nhật, API báo cáo đọc từ đó. */
@Module({
  providers: [SalesRollupRepository],
  exports: [SalesRollupRepository],
})
export class ReportModule {}
