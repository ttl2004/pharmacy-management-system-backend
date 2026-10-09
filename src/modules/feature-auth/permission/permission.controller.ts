import { Body, Controller, Get, Param, Patch, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { AuthzGuard } from '../authz/guards/auth.guard';
import type { JwtUser } from '../authz/types/authz.types';
import { AnyAuthenticated, RequirePermissions } from './decorators/require-permissions.decorator';
import { PermissionGuard } from './guards/permission.guard';
import { PermissionService } from './permission.service';
import { AssignRoleRequest, ReplaceRolePermissionsRequest } from './dtos/permission.request';

@Controller('permission')
@ApiTags('Permission')
@ApiBearerAuth(AUTH_JWT)
@ApiResponse({
  status: 403,
  description:
    'Thiếu quyền. Các mã lỗi: PERMISSION_DENIED (1500), PERMISSION_NOT_DECLARED (1501), ROLE_NOT_EDITABLE (1504), CANNOT_CHANGE_OWN_ROLE (1505)',
})
@ApiResponse({ status: 404, description: 'Không tìm thấy. Mã lỗi: ROLE_NOT_FOUND (1502), USER_NOT_FOUND (1200)' })
@UseGuards(AuthzGuard, PermissionGuard)
export class PermissionController {
  constructor(private readonly permissionService: PermissionService) {}

  @AnyAuthenticated()
  @Get('me')
  @ApiOperation({ description: 'Quyền của chính mình, để giao diện ẩn/hiện nút theo vai trò.' })
  me(@CurrentUser() user: JwtUser) {
    return this.permissionService.getMyPermissions(user);
  }

  @RequirePermissions('permission:read')
  @Get('catalog')
  @ApiOperation({ description: 'Danh mục quyền của hệ thống, sắp theo module rồi thứ tự hiển thị.' })
  catalog() {
    return this.permissionService.getCatalog();
  }

  @RequirePermissions('permission:read')
  @Get('roles')
  @ApiOperation({ description: 'Năm vai trò kèm số quyền đang có, sắp theo cấp bậc giảm dần.' })
  roles() {
    return this.permissionService.getRoles();
  }

  @RequirePermissions('permission:read')
  @Get('roles/:code/permissions')
  @ApiOperation({ description: 'Ma trận quyền hiện tại của một vai trò.' })
  roleMatrix(@Param('code') code: string) {
    return this.permissionService.getRoleMatrix(code);
  }

  @RequirePermissions('permission:update')
  @Put('roles/:code/permissions')
  @ApiOperation({
    description:
      'Ghi đè toàn bộ tập quyền của vai trò. Quyền không có trong danh sách gửi lên sẽ bị thu hồi. Không sửa được SUPER_ADMIN.',
  })
  replaceRolePermissions(
    @Param('code') code: string,
    @Body() dto: ReplaceRolePermissionsRequest,
    @CurrentUser() user: JwtUser,
  ) {
    return this.permissionService.replaceRolePermissions(code, dto.permissionCodes, user.userId);
  }

  @RequirePermissions('user:role:update')
  @Patch('users/:userId/role')
  @ApiOperation({ description: 'Đổi vai trò cho một người dùng. Không đổi được vai trò của chính mình.' })
  assignRole(@Param('userId') userId: string, @Body() dto: AssignRoleRequest, @CurrentUser() user: JwtUser) {
    return this.permissionService.assignRole(userId, dto.roleCode, user.userId);
  }
}
