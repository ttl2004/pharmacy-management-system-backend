import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsUUID, Max, Min } from 'class-validator';

/** Cột `Int` của PostgreSQL tối đa 2.147.483.647; chặn ở 400 thay vì để Prisma ném 500. */
const MAX_QUANTITY = 1_000_000_000;
const MAX_UNIT_COST = 1_000_000_000;

export class OpeningStockRequest {
  @IsUUID()
  @ApiProperty()
  branchId: string;

  @IsUUID()
  @ApiProperty()
  productId: string;

  @IsInt()
  @Min(1)
  @Max(MAX_QUANTITY, { message: 'Số lượng tối đa 1.000.000.000' })
  @ApiProperty({ description: 'Số lượng theo đơn vị cơ bản' })
  quantity: number;

  @IsInt()
  @Min(0)
  @Max(MAX_UNIT_COST, { message: 'Giá vốn tối đa 1.000.000.000 đồng' })
  @ApiProperty({ description: 'Giá vốn / đơn vị cơ bản, đơn vị đồng' })
  unitCost: number;
}
