import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { AuthzGuard } from '../authz/guards/auth.guard';
import type { JwtUser } from '../authz/types/authz.types';
import { AnyAuthenticated, RequirePermissions } from './decorators/require-permissions.decorator';
import { PermissionGuard } from './guards/permission.guard';
import { PermissionService } from './permission.service';
import { RoleAdminService } from './role-admin.service';
import { AssignRoleRequest, ReplaceRolePermissionsRequest } from './dtos/permission.request';
import { CreateRoleRequest } from './dtos/role-create.request';

@Controller('permission')
@ApiTags('Permission')
@ApiBearerAuth(AUTH_JWT)
@ApiResponse({
  status: 403,
  description:
    'Thiếu quyền. Các mã lỗi: PERMISSION_DENIED (1500), PERMISSION_NOT_DECLARED (1501), ROLE_NOT_EDITABLE (1504), CANNOT_CHANGE_OWN_ROLE (1505), BRANCH_ACCESS_DENIED (1506), BRANCH_NOT_ASSIGNED (1507), ROLE_LEVEL_FORBIDDEN (1508), PERMISSION_NOT_GRANTABLE (1509)',
})
@ApiResponse({ status: 404, description: 'Không tìm thấy. Mã lỗi: ROLE_NOT_FOUND (1502), USER_NOT_FOUND (1200)' })
@ApiResponse({ status: 409, description: 'Vai trò còn người dùng. Mã lỗi: ROLE_IN_USE (1510)' })
@ApiResponse({
  status: 400,
  description:
    'Yêu cầu không hợp lệ. Mã lỗi: INVALID_REFERENCE (1602), ROLE_NOT_ASSIGNABLE (1603), SUPER_ADMIN_PROTECTED (1604)',
})
@UseGuards(AuthzGuard, PermissionGuard)
export class PermissionController {
  constructor(
    private readonly permissionService: PermissionService,
    private readonly roleAdminService: RoleAdminService,
  ) {}

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
  @ApiOperation({
    description:
      'Danh sách vai trò kèm số quyền, số người dùng, cờ hệ thống; sắp theo cấp bậc giảm dần.',
  })
  roles() {
    return this.roleAdminService.getRoles();
  }

  @RequirePermissions('permission:update')
  @Post('roles')
  @ApiOperation({
    description:
      'Tạo vai trò tự tạo (luôn gắn một chi nhánh). Mã sinh từ tên; cấp bậc phải lớn hơn CUSTOMER và nhỏ hơn cấp người tạo.',
  })
  createRole(@Body() dto: CreateRoleRequest, @CurrentUser() user: JwtUser) {
    return this.roleAdminService.createRole(dto, user);
  }

  @RequirePermissions('permission:update')
  @Delete('roles/:code')
  @ApiOperation({ description: 'Xoá mềm vai trò tự tạo (mã được nhả để dùng lại). Vai trò hệ thống trả 1504; còn người dùng chưa xoá trả 1510.' })
  deleteRole(@Param('code') code: string, @CurrentUser() user: JwtUser) {
    return this.roleAdminService.deleteRole(code, user);
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
