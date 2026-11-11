import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsOptional, IsUUID } from 'class-validator';
import { IsDateOnly } from 'src/common/validators/is-date-only.validator';

/** Danh sách phân tách dấu phẩy → mảng (quy ước FE `csv`). */
const csv = ({ value }: { value: unknown }) =>
  typeof value === 'string'
    ? value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : value;

export class EndOfDayReportQuery {
  @IsOptional()
  @IsDateOnly()
  @ApiPropertyOptional({
    description: 'Ngày chốt (giờ VN), YYYY-MM-DD; mặc định hôm nay; không được ở tương lai (1002)',
    example: '2026-11-10',
  })
  date?: string;

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
