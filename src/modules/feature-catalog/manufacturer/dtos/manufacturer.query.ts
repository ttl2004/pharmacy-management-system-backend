import { ApiPropertyOptional } from '@nestjs/swagger';
import { RecordStatus } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';
import { AbstractBaseQuery } from 'src/providers/abstract-base/abstract-base.query';

export class ManufacturerQuery extends AbstractBaseQuery {
  @IsOptional()
  @IsEnum(RecordStatus)
  @ApiPropertyOptional({ enum: RecordStatus })
  status?: RecordStatus;
}
