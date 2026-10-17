import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TransferStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsIn,
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
import { MAX_BASE_QUANTITY } from '../../core/inventory.constants';

/** Chuyển theo LÔ cụ thể — giữ nguyên số lô và hạn dùng ở chi nhánh nhận. Số lượng theo đơn vị cơ bản. */
export class TransferItemRequest {
  @IsUUID()
  @ApiProperty({ description: 'Lô ở chi nhánh gửi' })
  batchId: string;

  @IsInt()
  @Min(1)
  @Max(MAX_BASE_QUANTITY)
  @ApiProperty({ example: 100 })
  quantity: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @ApiPropertyOptional()
  note?: string;
}

export class CreateTransferRequest {
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'Chi nhánh gửi. PM bỏ trống = chi nhánh mình; ADMIN bắt buộc.' })
  fromBranchId?: string;

  @IsUUID()
  @ApiProperty({ description: 'Chi nhánh nhận — phải khác chi nhánh gửi' })
  toBranchId: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  @ApiPropertyOptional()
  note?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => TransferItemRequest)
  @ApiProperty({ type: [TransferItemRequest] })
  items: TransferItemRequest[];
}

export class CancelTransferRequest {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  @ApiProperty({ example: 'Chi nhánh nhận không cần nữa' })
  reason: string;
}

export class TransferQuery extends AbstractBaseQuery {
  @IsOptional()
  @IsIn(['outgoing', 'incoming'])
  @ApiPropertyOptional({ enum: ['outgoing', 'incoming'], description: 'PM: phiếu mình gửi đi / nhận về' })
  direction?: 'outgoing' | 'incoming';

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'ADMIN lọc theo chi nhánh gửi' })
  fromBranchId?: string;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'ADMIN lọc theo chi nhánh nhận' })
  toBranchId?: string;

  @IsOptional()
  @IsEnum(TransferStatus)
  @ApiPropertyOptional({ enum: TransferStatus })
  status?: TransferStatus;

  @IsOptional()
  @IsDateOnly()
  @ApiPropertyOptional()
  fromDate?: string;

  @IsOptional()
  @IsDateOnly()
  @ApiPropertyOptional()
  toDate?: string;
}
