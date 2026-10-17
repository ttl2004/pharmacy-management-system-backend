import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/** Trần số dòng mỗi trang — chặn một request kéo về cả bảng (sổ kho chỉ tăng, không giảm). */
export const MAX_PAGE_LIMIT = 100;

/**
 * Trần số trang. Không có trần thì `page=1e300` làm `OFFSET` tràn và trả 500; 10.000 trang × 100 dòng đã vượt xa mọi
 * danh sách thật.
 */
export const MAX_PAGE = 10_000;

export class AbstractBaseQuery {
  @ApiPropertyOptional({ example: 1, description: 'Số trang' })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page: number = 1;

  @ApiPropertyOptional({ example: 10, maximum: MAX_PAGE_LIMIT, description: 'Số lượng mỗi trang' })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_LIMIT)
  limit: number = 10;

  @ApiPropertyOptional({
    description: 'Chuỗi sắp xếp: "field:asc" hoặc "field:desc"',
  })
  @IsOptional()
  @IsString()
  sort?: string;

  @ApiPropertyOptional({
    description: 'Từ khóa tìm kiếm',
  })
  @IsOptional()
  @IsString()
  search?: string;
}
