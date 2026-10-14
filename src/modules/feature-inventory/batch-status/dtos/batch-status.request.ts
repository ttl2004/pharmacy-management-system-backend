import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BatchStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class UpdateBatchStatusRequest {
  @IsEnum(BatchStatus)
  @ApiProperty({ enum: BatchStatus })
  status: BatchStatus;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  @ApiPropertyOptional({ description: 'Bắt buộc khi khoá/thu hồi — vd số quyết định thu hồi của Cục Quản lý Dược' })
  reason?: string;
}

export class RecallBatchRequest {
  @IsUUID()
  @ApiProperty()
  productId: string;

  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @ApiProperty({ example: 'LO2026A' })
  batchNumber: string;

  @IsIn([BatchStatus.QUARANTINE, BatchStatus.RECALLED])
  @ApiProperty({ enum: [BatchStatus.QUARANTINE, BatchStatus.RECALLED], default: BatchStatus.RECALLED })
  status: typeof BatchStatus.QUARANTINE | typeof BatchStatus.RECALLED = BatchStatus.RECALLED;

  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  @ApiProperty({ example: 'Quyết định thu hồi số 123/QĐ-QLD' })
  reason: string;
}
