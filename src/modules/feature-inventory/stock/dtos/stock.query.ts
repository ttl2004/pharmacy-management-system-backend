import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BatchStatus, StockMovementType, StockRefType } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { IsDateOnly } from 'src/common/validators/is-date-only.validator';
import { AbstractBaseQuery, MAX_PAGE_LIMIT } from 'src/providers/abstract-base/abstract-base.query';

/** `Boolean('false')` là `true` — đổi tường minh; giá trị lạ giữ nguyên để `@IsBoolean` báo 400. */
const toBoolean = ({ value }: { value: unknown }) => {
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  return value;
};
const toInt = ({ value }: { value: unknown }) => (value === undefined ? value : Number(value));

class BranchFilter extends AbstractBaseQuery {
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'PM/nhân viên: bỏ trống hoặc đúng chi nhánh mình; khác → 1506' })
  branchId?: string;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional()
  productId?: string;
}

export class StockBatchQuery extends BranchFilter {
  @IsOptional()
  @IsEnum(BatchStatus)
  @ApiPropertyOptional({ enum: BatchStatus })
  status?: BatchStatus;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  @ApiPropertyOptional({ type: Boolean, default: true, description: 'Chỉ lô còn hàng (tồn > 0)' })
  inStockOnly?: boolean = true;

  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(0)
  @Max(3650)
  @ApiPropertyOptional({ description: 'Chỉ lô hết hạn trong N ngày tới (gồm cả lô đã hết hạn)' })
  expiringWithinDays?: number;
}

export class StockProductQuery extends BranchFilter {}

export class LowStockQuery extends AbstractBaseQuery {
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'ADMIN bắt buộc chọn; PM/nhân viên mặc định chi nhánh mình' })
  branchId?: string;
}

export class NearExpiryQuery extends BranchFilter {
  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(3650)
  @ApiPropertyOptional({ default: 90 })
  days?: number = 90;
}

export class MovementSummaryQuery {
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'ADMIN bỏ trống = gộp toàn chuỗi' })
  branchId?: string;

  @IsDateOnly()
  @ApiProperty({ example: '2026-10-01' })
  fromDate: string;

  @IsDateOnly()
  @ApiProperty({ example: '2026-10-31' })
  toDate: string;
}

/** Sổ kho dùng con trỏ, không dùng page/OFFSET — nên KHÔNG kế thừa `AbstractBaseQuery`. */
export class StockMovementQuery {
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional()
  branchId?: string;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional()
  productId?: string;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional()
  batchId?: string;

  @IsOptional()
  @IsEnum(StockMovementType)
  @ApiPropertyOptional({ enum: StockMovementType })
  type?: StockMovementType;

  @IsOptional()
  @IsEnum(StockRefType)
  @ApiPropertyOptional({ enum: StockRefType })
  refType?: StockRefType;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'Id chứng từ nguồn — xem mọi bút toán của một phiếu' })
  refId?: string;

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
  @ApiPropertyOptional({ description: 'Gửi lại nguyên văn `nextCursor` của trang trước' })
  cursor?: string;

  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_LIMIT)
  @ApiPropertyOptional({ default: 50, maximum: MAX_PAGE_LIMIT })
  limit: number = 50;
}
