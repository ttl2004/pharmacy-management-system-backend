import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { SupplierReportQuery } from './supplier-report.query';

export const SUPPLIER_RECEIPTS_DEFAULT_LIMIT = 100;
export const SUPPLIER_RECEIPTS_MAX_LIMIT = 500;

/** Cùng `from`, `to`, `branchIds`, `supplierId` với báo cáo NCC, thêm `limit`. */
export class SupplierReceiptsQuery extends SupplierReportQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(SUPPLIER_RECEIPTS_MAX_LIMIT)
  @ApiPropertyOptional({
    description: `Số phiếu tối đa (mặc định ${SUPPLIER_RECEIPTS_DEFAULT_LIMIT}, tối đa ${SUPPLIER_RECEIPTS_MAX_LIMIT})`,
    default: SUPPLIER_RECEIPTS_DEFAULT_LIMIT,
  })
  limit?: number;
}
