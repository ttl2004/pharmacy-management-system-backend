import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RecordStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, ValidateIf } from 'class-validator';

const CODE_PATTERN = /^[A-Z0-9_-]+$/;

/** `@Transform` chạy trước class-validator nên `dhg` được đưa về `DHG` rồi mới qua regex. */
const normalizeCode = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

export class CreateManufacturerRequest {
  @IsOptional()
  @Transform(normalizeCode)
  @IsString()
  @MaxLength(30)
  @Matches(CODE_PATTERN, { message: 'code chỉ nhận chữ in hoa không dấu, chữ số, gạch ngang và gạch dưới' })
  @ApiPropertyOptional({ example: 'DHG' })
  code?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @ApiProperty({ example: 'Dược Hậu Giang' })
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @ApiPropertyOptional({ example: 'Việt Nam' })
  country?: string;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional()
  address?: string;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional()
  note?: string;

  @IsOptional()
  @IsEnum(RecordStatus)
  @ApiPropertyOptional({ enum: RecordStatus })
  status?: RecordStatus;
}

/**
 * DTO sửa hãng sản xuất. Viết tay thay vì `PartialType` để phân biệt "không gửi trường" (giữ nguyên)
 * với "gửi null" — các trường nullable được phép null để xoá giá trị cũ.
 */
export class UpdateManufacturerRequest {
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
  @IsString()
  @MaxLength(100)
  @ApiPropertyOptional({ nullable: true, description: 'Gửi null để xoá' })
  country?: string | null;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({ nullable: true, description: 'Gửi null để xoá' })
  address?: string | null;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({ nullable: true, description: 'Gửi null để xoá' })
  note?: string | null;

  @ValidateIf((_, value) => value !== undefined)
  @IsEnum(RecordStatus)
  @ApiPropertyOptional({ enum: RecordStatus })
  status?: RecordStatus;
}
