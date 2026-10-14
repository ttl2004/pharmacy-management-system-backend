import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

/** Trần số dòng mỗi trang — chặn một request kéo về cả bảng (sổ kho chỉ tăng, không giảm). */
export const MAX_PAGE_LIMIT = 100;

export class AbstractBaseQuery {
  @ApiPropertyOptional({ example: 1, description: 'Số trang' })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsNumber()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ example: 10, maximum: MAX_PAGE_LIMIT, description: 'Số lượng mỗi trang' })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsNumber()
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
