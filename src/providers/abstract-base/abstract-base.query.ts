import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class AbstractBaseQuery {
  @ApiPropertyOptional({ example: 1, description: 'Số trang' })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsNumber()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ example: 10, description: 'Số lượng mỗi trang' })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsNumber()
  @Min(1)
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
