import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { AuthzGuard } from '../authz/guards/auth.guard';
import type { JwtUser } from '../authz/types/authz.types';
import { RequirePermissions } from '../permission/decorators/require-permissions.decorator';
import { PermissionGuard } from '../permission/guards/permission.guard';
import { CreateUserRequest, UpdateUserRequest } from './dtos/user.request';
import { UserQuery } from './dtos/user.query';
import { UserService } from './user.service';

@Controller('user')
@ApiTags('User')
@ApiBearerAuth(AUTH_JWT)
@ApiResponse({
  status: 400,
  description:
    'Mã lỗi: USER_NOT_FOUND (1200, kể cả người dùng ngoài phạm vi chi nhánh), RECORD_NOT_FOUND (1600), DUPLICATE_CODE (1601), INVALID_REFERENCE (1602), ROLE_NOT_ASSIGNABLE (1603), SUPER_ADMIN_PROTECTED (1604), SELF_OPERATION_FORBIDDEN (1605)',
})
@ApiResponse({
  status: 403,
  description:
    'Mã lỗi: PERMISSION_DENIED (1500), BRANCH_ACCESS_DENIED (1506 — lọc hoặc ghi chi nhánh khác), BRANCH_NOT_ASSIGNED (1507 — nhân viên chưa được gán chi nhánh), ROLE_LEVEL_FORBIDDEN (1508 — người dùng/vai trò cùng cấp hoặc cao hơn)',
})
@UseGuards(AuthzGuard, PermissionGuard)
export class UserController {
  constructor(private readonly userService: UserService) {}

  @RequirePermissions('user:read')
  @Get()
  @ApiOperation({
    description:
      'Danh sách người dùng, tìm theo SĐT/họ tên/email, lọc theo vai trò và chi nhánh. Nhân viên chi nhánh (PHARMACY_MANAGER) chỉ thấy người dùng thuộc chi nhánh của mình.',
  })
  list(@Query() query: UserQuery, @CurrentUser() user: JwtUser) {
    return this.userService.list(query, user);
  }

  @RequirePermissions('user:read')
  @Get(':id')
  @ApiOperation({ description: 'Chi tiết người dùng kèm vai trò và chi nhánh. Ngoài phạm vi chi nhánh trả 1200.' })
  detail(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: JwtUser) {
    return this.userService.getDetail(id, user);
  }

  @RequirePermissions('user:create')
  @Post()
  @ApiOperation({
    description: 'Tạo người dùng. Gửi kèm username/password thì tạo luôn tài khoản đăng nhập.',
  })
  create(@Body() dto: CreateUserRequest, @CurrentUser() user: JwtUser) {
    return this.userService.create(dto, user);
  }

  @RequirePermissions('user:update')
  @Patch(':id')
  @ApiOperation({
    description: 'Sửa hồ sơ, chi nhánh, trạng thái. Không đổi vai trò — dùng PATCH /permission/users/:userId/role.',
  })
  update(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: UpdateUserRequest, @CurrentUser() user: JwtUser) {
    return this.userService.update(id, dto, user);
  }

  @RequirePermissions('user:delete')
  @Delete(':id')
  @ApiOperation({ description: 'Xoá mềm người dùng và thu hồi toàn bộ phiên đăng nhập của họ.' })
  remove(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: JwtUser) {
    return this.userService.remove(id, user);
  }
}
