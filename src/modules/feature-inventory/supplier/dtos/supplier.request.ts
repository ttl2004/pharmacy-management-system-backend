import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RecordStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEmail, IsEnum, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, ValidateIf } from 'class-validator';

const CODE_PATTERN = /^[A-Z0-9_-]+$/;
const CODE_MESSAGE = 'code chỉ nhận chữ in hoa không dấu, chữ số, gạch ngang và gạch dưới';

/** `@Transform` chạy trước class-validator: `ncc001` thành `NCC001` rồi mới qua regex. */
const normalizeCode = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

export class CreateSupplierRequest {
  @Transform(normalizeCode)
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  @Matches(CODE_PATTERN, { message: CODE_MESSAGE })
  @ApiProperty({ example: 'NCC001' })
  code: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @ApiProperty({ example: 'Công ty Dược phẩm Trung ương 1' })
  name: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  @ApiProperty({ example: '02438251234' })
  phone: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(150)
  @ApiPropertyOptional()
  email?: string;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional()
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  @ApiPropertyOptional({ description: 'Mã số thuế — dùng đối chiếu hoá đơn đầu vào' })
  taxCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  @ApiPropertyOptional()
  contactName?: string;

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
 * Viết tay thay vì `PartialType` để phân biệt "không gửi" (giữ nguyên) với "gửi null" (xoá giá trị) — chỉ các trường
 * tuỳ chọn mới được null; `code`, `name`, `phone`, `status` gửi null là lỗi.
 */
export class UpdateSupplierRequest {
  @ValidateIf((_, value) => value !== undefined)
  @Transform(normalizeCode)
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  @Matches(CODE_PATTERN, { message: CODE_MESSAGE })
  @ApiPropertyOptional()
  code?: string;

  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @ApiPropertyOptional()
  name?: string;

  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  @ApiPropertyOptional()
  phone?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(150)
  @ApiPropertyOptional({ nullable: true })
  email?: string | null;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({ nullable: true })
  address?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  @ApiPropertyOptional({ nullable: true })
  taxCode?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  @ApiPropertyOptional({ nullable: true })
  contactName?: string | null;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({ nullable: true })
  note?: string | null;

  @ValidateIf((_, value) => value !== undefined)
  @IsEnum(RecordStatus)
  @ApiPropertyOptional({ enum: RecordStatus })
  status?: RecordStatus;
}
