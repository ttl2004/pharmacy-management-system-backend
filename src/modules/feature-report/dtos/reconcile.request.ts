import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import { IsDateOnly } from 'src/common/validators/is-date-only.validator';
import { AbstractBaseQuery } from 'src/providers/abstract-base/abstract-base.query';

export const RECONCILE_STATUSES = ['RUNNING', 'SUCCESS', 'FAILED'] as const;

export class ReconcileRequest {
  @IsDateOnly()
  @ApiProperty({ description: 'Từ ngày (giờ VN), YYYY-MM-DD', example: '2026-11-01' })
  fromDate!: string;

  @IsDateOnly()
  @ApiProperty({
    description: 'Đến hết ngày (giờ VN), YYYY-MM-DD; không quá hôm nay, tối đa 31 ngày',
    example: '2026-11-05',
  })
  toDate!: string;
}

export class ReconcileRunsQuery extends AbstractBaseQuery {
  @IsOptional()
  @IsIn(RECONCILE_STATUSES)
  @ApiPropertyOptional({ enum: RECONCILE_STATUSES })
  status?: (typeof RECONCILE_STATUSES)[number];

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  @ApiPropertyOptional({ description: 'true = chỉ lần chạy có phát hiện lệch; false = chỉ lần không lệch' })
  hasMismatch?: boolean;
}
