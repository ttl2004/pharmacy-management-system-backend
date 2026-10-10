import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RecordStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

const CODE_PATTERN = /^[A-Z0-9_-]+$/;

/** `@Transform` chạy trước class-validator nên `otc` được đưa về `OTC` rồi mới qua regex. */
const normalizeCode = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

export class CreateCategoryRequest {
  @IsOptional()
  @Transform(normalizeCode)
  @IsString()
  @MaxLength(30)
  @Matches(CODE_PATTERN, { message: 'code chỉ nhận chữ in hoa không dấu, chữ số, gạch ngang và gạch dưới' })
  @ApiPropertyOptional({ example: 'OTC' })
  code?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @ApiProperty({ example: 'Thuốc không kê đơn' })
  name: string;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'Nhóm cha; bỏ trống là nhóm gốc' })
  parentId?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @ApiPropertyOptional({ example: 0 })
  sortOrder?: number;

  @IsOptional()
  @IsEnum(RecordStatus)
  @ApiPropertyOptional({ enum: RecordStatus })
  status?: RecordStatus;
}

/**
 * DTO sửa nhóm sản phẩm. Viết tay thay vì `PartialType` để phân biệt "không gửi trường" (giữ nguyên)
 * với "gửi null" — chỉ `code` và `parentId` được phép null.
 */
export class UpdateCategoryRequest {
  @IsOptional()
  @Transform(normalizeCode)
  @IsString()
  @MaxLength(30)
  @Matches(CODE_PATTERN, { message: 'code chỉ nhận chữ in hoa không dấu, chữ số, gạch ngang và gạch dưới' })
  @ApiPropertyOptional({ nullable: true, description: 'Gửi null để xoá mã' })
  code?: string | null;

  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @ApiPropertyOptional()
  name?: string;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ nullable: true, description: 'Gửi null để đưa về nhóm gốc' })
  parentId?: string | null;

  @ValidateIf((_, value) => value !== undefined)
  @IsInt()
  @Min(0)
  @ApiPropertyOptional()
  sortOrder?: number;

  @ValidateIf((_, value) => value !== undefined)
  @IsEnum(RecordStatus)
  @ApiPropertyOptional({ enum: RecordStatus })
  status?: RecordStatus;
}
