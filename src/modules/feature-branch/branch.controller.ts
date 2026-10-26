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
import { AuthzGuard } from '../feature-auth/authz/guards/auth.guard';
import type { JwtUser } from '../feature-auth/authz/types/authz.types';
import { RequirePermissions } from '../feature-auth/permission/decorators/require-permissions.decorator';
import { PermissionGuard } from '../feature-auth/permission/guards/permission.guard';
import { BranchService } from './branch.service';
import { CreateBranchRequest, UpdateBranchRequest } from './dtos/branch.request';
import { BranchQuery } from './dtos/branch.query';

@Controller('branch')
@ApiTags('Branch')
@ApiBearerAuth(AUTH_JWT)
@ApiResponse({
  status: 400,
  description: 'Mã lỗi: RECORD_NOT_FOUND (1600), DUPLICATE_CODE (1601), INVALID_REFERENCE (1602)',
})
@UseGuards(AuthzGuard, PermissionGuard)
export class BranchController {
  constructor(private readonly branchService: BranchService) {}

  @RequirePermissions('branch:read')
  @Get()
  @ApiOperation({
    description:
      'Danh sách chi nhánh, tìm theo mã/tên/SĐT, lọc theo trạng thái. Vai trò phạm vi chi nhánh chỉ thấy chi nhánh của mình.',
  })
  list(@Query() query: BranchQuery, @CurrentUser() user: JwtUser) {
    return this.branchService.list(query, user);
  }

  @RequirePermissions('branch:read')
  @Get(':id')
  @ApiOperation({ description: 'Chi tiết chi nhánh. Ngoài phạm vi người gọi → BRANCH_ACCESS_DENIED (1506).' })
  detail(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: JwtUser) {
    return this.branchService.getDetail(id, user);
  }

  @RequirePermissions('branch:create')
  @Post()
  @ApiOperation({ description: 'Tạo chi nhánh. Chỉ vai trò phạm vi toàn chuỗi.' })
  create(@Body() dto: CreateBranchRequest, @CurrentUser() user: JwtUser) {
    return this.branchService.create(dto, user);
  }

  @RequirePermissions('branch:update')
  @Patch(':id')
  @ApiOperation({ description: 'Sửa chi nhánh. Gửi null cho email/openingHours để xoá giá trị cũ.' })
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateBranchRequest,
    @CurrentUser() user: JwtUser,
  ) {
    return this.branchService.update(id, dto, user);
  }

  @RequirePermissions('branch:delete')
  @Delete(':id')
  @ApiOperation({ description: 'Xoá mềm chi nhánh. Từ chối nếu còn người dùng tham chiếu.' })
  remove(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: JwtUser) {
    return this.branchService.remove(id, user);
  }
}
