import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AdjustmentType, ReceiptStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { IsDateOnly } from 'src/common/validators/is-date-only.validator';
import { AbstractBaseQuery } from 'src/providers/abstract-base/abstract-base.query';

/**
 * Dòng phiếu điều chỉnh, số lượng theo đơn vị cơ bản. Trường cần gửi tuỳ loại phiếu (kiểm ở service):
 * - STOCK_TAKE: `actualQuantity` — số đếm thực tế (>= 0). Chênh lệch tính lúc xác nhận.
 * - DISPOSE / RETURN_TO_SUPPLIER: `quantity` — số đưa RA khỏi kho (> 0).
 * - OTHER: `quantity` — delta có dấu, khác 0.
 */
export class AdjustmentItemRequest {
  @IsUUID()
  @ApiProperty()
  batchId: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  @ApiPropertyOptional({ description: 'STOCK_TAKE: số đếm thực tế' })
  actualQuantity?: number;

  @IsOptional()
  @IsInt()
  @Min(-10_000_000)
  @Max(10_000_000)
  @ApiPropertyOptional({ description: 'DISPOSE/RETURN_TO_SUPPLIER: số đưa ra (> 0); OTHER: delta có dấu' })
  quantity?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @ApiPropertyOptional()
  reason?: string;
}

export class CreateAdjustmentRequest {
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'PM bỏ trống = chi nhánh mình; ADMIN bắt buộc' })
  branchId?: string;

  @IsEnum(AdjustmentType)
  @ApiProperty({ enum: AdjustmentType })
  type: AdjustmentType;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'Bắt buộc khi type = RETURN_TO_SUPPLIER' })
  supplierId?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  @ApiProperty({ example: 'Biên bản huỷ thuốc hết hạn số 12/2026' })
  reason: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  @ApiPropertyOptional()
  note?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => AdjustmentItemRequest)
  @ApiProperty({ type: [AdjustmentItemRequest] })
  items: AdjustmentItemRequest[];
}

export class CancelAdjustmentRequest {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  @ApiProperty()
  reason: string;
}

export class AdjustmentQuery extends AbstractBaseQuery {
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional()
  branchId?: string;

  @IsOptional()
  @IsEnum(AdjustmentType)
  @ApiPropertyOptional({ enum: AdjustmentType })
  type?: AdjustmentType;

  @IsOptional()
  @IsEnum(ReceiptStatus)
  @ApiPropertyOptional({ enum: ReceiptStatus })
  status?: ReceiptStatus;

  @IsOptional()
  @IsDateOnly()
  @ApiPropertyOptional()
  fromDate?: string;

  @IsOptional()
  @IsDateOnly()
  @ApiPropertyOptional()
  toDate?: string;
}
