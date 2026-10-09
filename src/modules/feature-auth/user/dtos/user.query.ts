import { ApiPropertyOptional } from '@nestjs/swagger';
import { UserStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { AuthRole } from 'src/common/types/common.enum';
import { AbstractBaseQuery } from 'src/providers/abstract-base/abstract-base.query';

export class UserQuery extends AbstractBaseQuery {
  /** Chặn ở DTO để mã vai trò rác trả 400 rõ ràng, thay vì lặng lẽ ra danh sách rỗng. */
  @IsOptional()
  @IsEnum(AuthRole)
  @ApiPropertyOptional({ enum: AuthRole, example: 'SALES_STAFF', description: 'Lọc theo mã vai trò' })
  roleCode?: AuthRole;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'Lọc theo chi nhánh' })
  branchId?: string;

  @IsOptional()
  @IsEnum(UserStatus)
  @ApiPropertyOptional({ enum: UserStatus })
  status?: UserStatus;
}
