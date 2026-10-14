import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { AbstractBaseQuery } from 'src/providers/abstract-base/abstract-base.query';
import { MAX_BASE_QUANTITY } from '../../core/inventory.constants';

export class UpsertBranchProductRequest {
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'ADMIN bắt buộc; PM bỏ trống = chi nhánh mình' })
  branchId?: string;

  @IsUUID()
  @ApiProperty()
  productId: string;

  @IsInt()
  @Min(0)
  @Max(MAX_BASE_QUANTITY)
  @ApiProperty({ description: 'Ngưỡng cảnh báo sắp hết hàng của chi nhánh, theo đơn vị cơ bản' })
  minStockLevel: number;
}

export class BranchProductQuery extends AbstractBaseQuery {
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional()
  branchId?: string;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional()
  productId?: string;
}

export class BranchProductTargetQuery {
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'ADMIN bắt buộc; PM bỏ trống = chi nhánh mình' })
  branchId?: string;
}
