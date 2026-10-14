import { ApiPropertyOptional } from '@nestjs/swagger';
import { AuditAction } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { IsDateOnly } from 'src/common/validators/is-date-only.validator';
import { MAX_PAGE_LIMIT } from 'src/providers/abstract-base/abstract-base.query';

/** Nhật ký chỉ tăng → phân trang con trỏ như sổ kho. */
export class AuditLogQuery {
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'PM: bỏ trống hoặc đúng chi nhánh mình' })
  branchId?: string;

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
