import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsUUID, Min } from 'class-validator';

export class OpeningStockRequest {
  @IsUUID()
  @ApiProperty()
  branchId: string;

  @IsUUID()
  @ApiProperty()
  productId: string;

  @IsInt()
  @Min(1)
  @ApiProperty({ description: 'Số lượng theo đơn vị cơ bản' })
  quantity: number;

  @IsInt()
  @Min(0)
  @ApiProperty({ description: 'Giá vốn / đơn vị cơ bản, đơn vị đồng' })
  unitCost: number;
}
