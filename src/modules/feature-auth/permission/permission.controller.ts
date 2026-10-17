import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Put, UseGuards } from '@nestjs/common';
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
    'Thiếu quyền. Các mã lỗi: PERMISSION_DENIED (1500), PERMISSION_NOT_DECLARED (1501), ROLE_NOT_EDITABLE (1504), CANNOT_CHANGE_OWN_ROLE (1505), BRANCH_ACCESS_DENIED (1506), BRANCH_NOT_ASSIGNED (1507), ROLE_LEVEL_FORBIDDEN (1508), PERMISSION_NOT_GRANTABLE (1509)',
})
@ApiResponse({ status: 404, description: 'Không tìm thấy. Mã lỗi: ROLE_NOT_FOUND (1502), USER_NOT_FOUND (1200)' })
@ApiResponse({
  status: 400,
  description:
    'Yêu cầu không hợp lệ. Mã lỗi: INVALID_REFERENCE (1602), ROLE_NOT_ASSIGNABLE (1603), SUPER_ADMIN_PROTECTED (1604)',
})
@UseGuards(AuthzGuard, PermissionGuard)
export class PermissionController {
  constructor(private readonly permissionService: PermissionService) {}

  @AnyAuthenticated()
  @Get('me')
  @ApiOperation({
    description:
      'Quyền của chính mình kèm phạm vi chi nhánh (branchId, branchScope: ALL | BRANCH | NONE), để giao diện ẩn/hiện nút và ô chọn chi nhánh.',
  })
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
    return this.permissionService.replaceRolePermissions(code, dto.permissionCodes, user);
  }

  @RequirePermissions('user:role:update')
  @Patch('users/:userId/role')
  @ApiOperation({
    description:
      'Đổi vai trò cho một người dùng. Không đổi được vai trò của chính mình; người ngoài phạm vi chi nhánh trả 1200.',
  })
  assignRole(
    // Cột `users.id` là uuid: id sai định dạng phải trả 400, nếu không Prisma ném P2023 thành 500.
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() dto: AssignRoleRequest,
    @CurrentUser() user: JwtUser,
  ) {
    return this.permissionService.assignRole(userId, dto.roleCode, user);
  }
}
