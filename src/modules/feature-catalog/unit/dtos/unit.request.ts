import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength, ValidateIf } from 'class-validator';

const CODE_PATTERN = /^[A-Z0-9_-]+$/;

/** `@Transform` chạy trước class-validator nên `vien` được đưa về `VIEN` rồi mới qua regex. */
const normalizeCode = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

/** Bảng `units` không có cột `status` theo từ điển dữ liệu — DTO cố ý không nhận trường này. */
export class CreateUnitRequest {
  @Transform(normalizeCode)
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  @Matches(CODE_PATTERN, { message: 'code chỉ nhận chữ in hoa không dấu, chữ số, gạch ngang và gạch dưới' })
  @ApiProperty({ example: 'VIEN' })
  code: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @ApiProperty({ example: 'Viên' })
  name: string;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional()
  note?: string;
}

export class UpdateUnitRequest {
  @ValidateIf((_, value) => value !== undefined)
  @Transform(normalizeCode)
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  @Matches(CODE_PATTERN, { message: 'code chỉ nhận chữ in hoa không dấu, chữ số, gạch ngang và gạch dưới' })
  @ApiPropertyOptional({ example: 'VIEN' })
  code?: string;

  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @ApiPropertyOptional()
  name?: string;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({ nullable: true, description: 'Gửi null để xoá' })
  note?: string | null;
}
