import { ApiPropertyOptional } from '@nestjs/swagger';
import { ReceiptStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { IsDateOnly } from 'src/common/validators/is-date-only.validator';
import { AbstractBaseQuery } from 'src/providers/abstract-base/abstract-base.query';

export class GoodsReceiptQuery extends AbstractBaseQuery {
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'PM/nhân viên: bỏ trống hoặc đúng chi nhánh mình; khác → 1506' })
  branchId?: string;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional()
  supplierId?: string;

  @IsOptional()
  @IsEnum(ReceiptStatus)
  @ApiPropertyOptional({ enum: ReceiptStatus })
  status?: ReceiptStatus;

  @IsOptional()
  @IsDateOnly()
  @ApiPropertyOptional({ description: 'Lập từ ngày (giờ VN), YYYY-MM-DD' })
  fromDate?: string;

  @IsOptional()
  @IsDateOnly()
  @ApiPropertyOptional({ description: 'Lập đến hết ngày (giờ VN), YYYY-MM-DD' })
  toDate?: string;
}
