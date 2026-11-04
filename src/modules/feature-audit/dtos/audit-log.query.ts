import { ApiPropertyOptional } from '@nestjs/swagger';
import { AuditAction } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { IsDateOnly } from 'src/common/validators/is-date-only.validator';
import { MAX_PAGE_LIMIT } from 'src/providers/abstract-base/abstract-base.query';

/** Nhật ký chỉ tăng → phân trang con trỏ như sổ kho. */
export class AuditLogQuery {
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'PM: bỏ trống hoặc đúng chi nhánh mình' })
  branchId?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : value,
  )
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  @ApiPropertyOptional({
    type: String,
    description: 'Nhiều chi nhánh, phân tách bằng dấu phẩy (ADMIN). PM: chỉ chi nhánh mình',
  })
  branchIds?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @ApiPropertyOptional({
    description:
      'Tìm không dấu, không phân biệt hoa thường trong nhãn đối tượng, lý do và mã chứng từ. Bắt buộc fromDate + toDate (≤ 90 ngày); từ khoá sau khi bỏ dấu ≥ 3 ký tự',
  })
  search?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : value,
  )
  @IsArray()
  @ArrayMaxSize(20)
  @Matches(/^[A-Z_]+\.[A-Z_]+$/, { each: true })
  @ApiPropertyOptional({
    type: String,
    example: 'ORDER.VOID_PAID,PAYMENT.REFUNDED',
    description: 'Nhiều sự kiện, phân tách bằng dấu phẩy',
  })
  event?: string[];

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsIn([0, 1, 2])
  @ApiPropertyOptional({ enum: [0, 1, 2], description: 'Từ mức này trở lên' })
  severity?: 0 | 1 | 2;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  @ApiPropertyOptional({ example: 'goods_receipts' })
  entityType?: string;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'Lịch sử của đúng một bản ghi' })
  entityId?: string;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'Mọi thao tác của một người' })
  actorId?: string;

  @IsOptional()
  @IsEnum(AuditAction)
  @ApiPropertyOptional({ enum: AuditAction })
  action?: AuditAction;

  @IsOptional()
  @IsDateOnly()
  @ApiPropertyOptional()
  fromDate?: string;

  @IsOptional()
  @IsDateOnly()
  @ApiPropertyOptional()
  toDate?: string;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional()
  cursor?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (value === undefined ? value : Number(value)))
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_LIMIT)
  @ApiPropertyOptional({ default: 50 })
  limit: number = 50;
}
