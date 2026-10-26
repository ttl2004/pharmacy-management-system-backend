import { ApiPropertyOptional } from '@nestjs/swagger';
import { UserStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { AbstractBaseQuery } from 'src/providers/abstract-base/abstract-base.query';

export class UserQuery extends AbstractBaseQuery {
  /** Mã vai trò lạ cho ra danh sách rỗng (vai trò tự tạo nên không còn là enum cố định). */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  @ApiPropertyOptional({ example: 'SALES_STAFF', description: 'Lọc theo mã vai trò' })
  roleCode?: string;

  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  @ApiPropertyOptional({ description: 'true = loại khách hàng (CUSTOMER) khỏi danh sách' })
  excludeCustomer?: boolean;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({
    description: 'Lọc theo chi nhánh. Nhân viên chi nhánh bỏ trống = chi nhánh của mình; chi nhánh khác trả 1506.',
  })
  branchId?: string;

  @IsOptional()
  @IsEnum(UserStatus)
  @ApiPropertyOptional({ enum: UserStatus })
  status?: UserStatus;
}
