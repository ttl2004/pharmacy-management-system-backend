import { ApiPropertyOptional } from '@nestjs/swagger';
import { RecordStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional } from 'class-validator';
import { AbstractBaseQuery } from 'src/providers/abstract-base/abstract-base.query';
import { toBoolean } from '../../product/dtos/product.query';

export class DrugQuery extends AbstractBaseQuery {
  @IsOptional()
  @IsEnum(RecordStatus)
  @ApiPropertyOptional({ enum: RecordStatus, description: 'INACTIVE = thuốc đã rút khỏi danh mục nguồn' })
  status?: RecordStatus;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  @ApiPropertyOptional({ type: Boolean, description: 'Lọc thuốc kê đơn' })
  isPrescription?: boolean;
}
