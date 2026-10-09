import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { AuthzGuard } from '../authz/guards/auth.guard';
import { RequirePermissions } from '../permission/decorators/require-permissions.decorator';
import { PermissionGuard } from '../permission/guards/permission.guard';
import { UserQuery } from './dtos/user.query';
import { UserService } from './user.service';

@Controller('user')
@ApiTags('User')
@ApiBearerAuth(AUTH_JWT)
@ApiResponse({
  status: 400,
  description:
    'Mã lỗi: RECORD_NOT_FOUND (1600), DUPLICATE_CODE (1601), INVALID_REFERENCE (1602), ROLE_NOT_ASSIGNABLE (1603), SUPER_ADMIN_PROTECTED (1604), SELF_OPERATION_FORBIDDEN (1605)',
})
@UseGuards(AuthzGuard, PermissionGuard)
export class UserController {
  constructor(private readonly userService: UserService) {}

  @RequirePermissions('user:read')
  @Get()
  @ApiOperation({
    description: 'Danh sách người dùng, tìm theo SĐT/họ tên/email, lọc theo vai trò và chi nhánh.',
  })
  list(@Query() query: UserQuery) {
    return this.userService.list(query);
  }

  @RequirePermissions('user:read')
  @Get(':id')
  @ApiOperation({ description: 'Chi tiết người dùng kèm vai trò và chi nhánh.' })
  detail(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.userService.getDetail(id);
  }
}
