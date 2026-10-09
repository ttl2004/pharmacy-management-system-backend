import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
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

  @RequirePermissions('user:create')
  @Post()
  @ApiOperation({
    description: 'Tạo người dùng. Gửi kèm username/password thì tạo luôn tài khoản đăng nhập.',
  })
  create(@Body() dto: CreateUserRequest, @CurrentUser() user: JwtUser) {
    return this.userService.create(dto, user.userId);
  }

  @RequirePermissions('user:update')
  @Patch(':id')
  @ApiOperation({
    description:
      'Sửa hồ sơ, chi nhánh, trạng thái. Không đổi vai trò — dùng PATCH /permission/users/:userId/role.',
  })
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateUserRequest,
    @CurrentUser() user: JwtUser,
  ) {
    return this.userService.update(id, dto, user.userId);
  }

  @RequirePermissions('user:delete')
  @Delete(':id')
  @ApiOperation({ description: 'Xoá mềm người dùng và thu hồi toàn bộ phiên đăng nhập của họ.' })
  remove(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: JwtUser) {
    return this.userService.remove(id, user.userId);
  }
}
