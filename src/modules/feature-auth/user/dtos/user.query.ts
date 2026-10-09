import { ApiPropertyOptional } from '@nestjs/swagger';
import { UserStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { AbstractBaseQuery } from 'src/providers/abstract-base/abstract-base.query';

export class UserQuery extends AbstractBaseQuery {
  @IsOptional()
  @IsString()
  @ApiPropertyOptional({ example: 'SALES_STAFF', description: 'Lọc theo mã vai trò' })
  roleCode?: string;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'Lọc theo chi nhánh' })
  branchId?: string;

  @IsOptional()
  @IsEnum(UserStatus)
  @ApiPropertyOptional({ enum: UserStatus })
  status?: UserStatus;
}
