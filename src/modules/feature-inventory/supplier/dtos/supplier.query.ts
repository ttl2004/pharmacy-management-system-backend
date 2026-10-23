import { ApiPropertyOptional } from '@nestjs/swagger';
import { RecordStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Matches, Min } from 'class-validator';
import { IsDateOnly } from 'src/common/validators/is-date-only.validator';
import { AbstractBaseQuery } from 'src/providers/abstract-base/abstract-base.query';

const toInt = ({ value }: { value: unknown }) => (value === '' || value === undefined ? undefined : Number(value));

export class SupplierQuery extends AbstractBaseQuery {
  @IsOptional()
  @IsEnum(RecordStatus)
  @ApiPropertyOptional({ enum: RecordStatus })
  status?: RecordStatus;

  @IsOptional()
  @Matches(/^([0-9a-fA-F-]{36}|none)$/, { message: 'groupId phải là uuid hoặc "none"' })
  @ApiPropertyOptional({ description: 'Id nhóm NCC, hoặc "none" = chưa có nhóm' })
  groupId?: string;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({ description: 'Ghi chú chứa chuỗi này' })
  note?: string;

  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(0)
  @ApiPropertyOptional({ description: 'Tổng mua tối thiểu' })
  purchaseMin?: number;

  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(0)
  @ApiPropertyOptional({ description: 'Tổng mua tối đa' })
  purchaseMax?: number;

  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(0)
  @ApiPropertyOptional({ description: 'Nợ hiện tại tối thiểu (bỏ qua nếu thiếu quyền supplier-debt:read)' })
  debtMin?: number;

  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(0)
  @ApiPropertyOptional({ description: 'Nợ hiện tại tối đa (bỏ qua nếu thiếu quyền supplier-debt:read)' })
  debtMax?: number;

  @IsOptional()
  @IsDateOnly()
  @ApiPropertyOptional({ description: 'Tổng mua tính từ ngày (giờ VN, theo ngày nhập hàng)', example: '2026-10-01' })
  fromDate?: string;

  @IsOptional()
  @IsDateOnly()
  @ApiPropertyOptional({ description: 'Tổng mua đến hết ngày (giờ VN, theo ngày nhập hàng)', example: '2026-10-31' })
  toDate?: string;
}
