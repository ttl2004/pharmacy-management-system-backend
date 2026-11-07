import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { IsDateOnly } from 'src/common/validators/is-date-only.validator';
import { MAX_PAGE_LIMIT } from 'src/providers/abstract-base/abstract-base.query';
import {
  SECURITY_EVENTS,
  type SecurityEventType,
  type SecurityOutcome,
} from 'src/providers/security-event/security-events';

const TYPES = Object.keys(SECURITY_EVENTS) as SecurityEventType[];

/** Sự kiện bảo mật chỉ tăng → phân trang con trỏ như nhật ký thao tác. */
export class SecurityEventQuery {
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
  @ArrayMaxSize(TYPES.length)
  @IsIn(TYPES, { each: true })
  @ApiPropertyOptional({
    type: String,
    example: 'AUTH.LOGIN_FAILED,AUTH.BRUTE_FORCE_SUSPECTED',
    description: 'Nhiều loại, phân tách bằng dấu phẩy',
  })
  type?: SecurityEventType[];

  @IsOptional()
  @IsIn(['SUCCESS', 'DENIED', 'FAILED'])
  @ApiPropertyOptional({ enum: ['SUCCESS', 'DENIED', 'FAILED'] })
  outcome?: SecurityOutcome;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'Mọi sự kiện của một nhân viên' })
  actorId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(45)
  @ApiPropertyOptional({ example: '203.0.113.7' })
  ip?: string;

  @IsOptional()
  @IsDateOnly()
  @ApiPropertyOptional()
  fromDate?: string;

  @IsOptional()
  @IsDateOnly()
  @ApiPropertyOptional({ description: 'Có cả fromDate và toDate thì khoảng tối đa 90 ngày' })
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
