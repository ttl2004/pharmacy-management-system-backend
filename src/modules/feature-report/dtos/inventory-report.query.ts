import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsOptional, IsUUID } from 'class-validator';

/** Danh sách phân tách dấu phẩy → mảng (quy ước FE `csv`). */
const csv = ({ value }: { value: unknown }) =>
  typeof value === 'string'
    ? value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : value;

export class InventoryReportQuery {
  @IsOptional()
  @Transform(csv)
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  @ApiPropertyOptional({
    type: String,
    description: 'Chi nhánh (csv). ADMIN: bỏ trống = toàn chuỗi. PM: bỏ trống = chi nhánh mình; chi nhánh khác → 1506',
  })
  branchIds?: string[];
}
