import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsUUID } from 'class-validator';
import { IsDateOnly } from 'src/common/validators/is-date-only.validator';

/** Danh sách phân tách dấu phẩy → mảng (quy ước FE `csv`). */
const csv = ({ value }: { value: unknown }) =>
  typeof value === 'string'
    ? value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : value;

export class SalesReportQuery {
  @IsDateOnly()
  @ApiProperty({ description: 'Từ ngày (giờ VN), YYYY-MM-DD', example: '2026-11-01' })
  from!: string;

  @IsDateOnly()
  @ApiProperty({ description: 'Đến hết ngày (giờ VN), YYYY-MM-DD; khoảng tối đa 366 ngày', example: '2026-11-30' })
  to!: string;

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

  @IsOptional()
  @IsIn(['revenue', 'grossProfit'])
  @ApiPropertyOptional({
    enum: ['revenue', 'grossProfit'],
    default: 'revenue',
    description: 'Tiêu chí xếp top 10 sản phẩm: doanh thu (mặc định) hoặc lãi gộp giảm dần',
  })
  topBy?: 'revenue' | 'grossProfit';
}
