import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RecordStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEmail, IsEnum, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, ValidateIf } from 'class-validator';

const CODE_PATTERN = /^[A-Z0-9_-]+$/;

/**
 * `@Transform` chạy trước class-validator, nên `cn004` được đưa về `CN004` rồi mới qua regex.
 */
const normalizeCode = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

export class CreateBranchRequest {
  @Transform(normalizeCode)
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  @Matches(CODE_PATTERN, { message: 'code chỉ nhận chữ in hoa không dấu, chữ số, gạch ngang và gạch dưới' })
  @ApiProperty({ example: 'CN001' })
  code: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @ApiProperty({ example: 'Nhà thuốc Trung tâm' })
  name: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  @ApiProperty({ example: '0900000001' })
  phone: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(150)
  @ApiProperty({ required: false })
  email?: string;

  @IsString()
  @IsNotEmpty()
  @ApiProperty({ example: '123 Phố Huế, Hà Nội' })
  address: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @ApiProperty({ required: false, example: '07:00 - 22:00' })
  openingHours?: string;

  @IsOptional()
  @IsEnum(RecordStatus)
  @ApiProperty({ enum: RecordStatus, required: false })
  status?: RecordStatus;
}

/**
 * DTO sửa chi nhánh. Viết tay thay vì `PartialType` để phân biệt "không gửi trường" (giữ nguyên) với
 * "gửi null" — chỉ `email` và `openingHours` được phép null, các trường còn lại gửi null là lỗi.
 */
export class UpdateBranchRequest {
  @ValidateIf((_, value) => value !== undefined)
  @Transform(normalizeCode)
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  @Matches(CODE_PATTERN, { message: 'code chỉ nhận chữ in hoa không dấu, chữ số, gạch ngang và gạch dưới' })
  @ApiPropertyOptional({ example: 'CN001' })
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

  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @IsNotEmpty()
  @ApiPropertyOptional()
  address?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(150)
  @ApiPropertyOptional({ nullable: true, description: 'Gửi null để xoá' })
  email?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @ApiPropertyOptional({ nullable: true, description: 'Gửi null để xoá' })
  openingHours?: string | null;

  @ValidateIf((_, value) => value !== undefined)
  @IsEnum(RecordStatus)
  @ApiPropertyOptional({ enum: RecordStatus })
  status?: RecordStatus;
}
