import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { AuthzGuard } from '../../feature-auth/authz/guards/auth.guard';
import type { JwtUser } from '../../feature-auth/authz/types/authz.types';
import { RequirePermissions } from '../../feature-auth/permission/decorators/require-permissions.decorator';
import { PermissionGuard } from '../../feature-auth/permission/guards/permission.guard';
import { CategoryService } from './category.service';
import { CategoryQuery } from './dtos/category.query';
import { CreateCategoryRequest, UpdateCategoryRequest } from './dtos/category.request';

@Controller('category')
@ApiTags('Category')
@ApiBearerAuth(AUTH_JWT)
@ApiResponse({
  status: 400,
  description: 'Mã lỗi: RECORD_NOT_FOUND (1600), DUPLICATE_CODE (1601), INVALID_REFERENCE (1602)',
})
@UseGuards(AuthzGuard, PermissionGuard)
export class CategoryController {
  constructor(private readonly categoryService: CategoryService) {}

  @RequirePermissions('category:read')
  @Get()
  @ApiOperation({ description: 'Danh sách nhóm sản phẩm, tìm theo mã/tên, lọc theo nhóm cha và trạng thái.' })
  list(@Query() query: CategoryQuery) {
    return this.categoryService.list(query);
  }

  @RequirePermissions('category:read')
  @Get(':id')
  @ApiOperation({ description: 'Chi tiết nhóm sản phẩm kèm nhóm cha.' })
  detail(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.categoryService.getDetail(id);
  }

  @RequirePermissions('category:create')
  @Post()
  @ApiOperation({ description: 'Tạo nhóm sản phẩm. Bỏ trống parentId để tạo nhóm gốc.' })
  create(@Body() dto: CreateCategoryRequest, @CurrentUser() user: JwtUser) {
    return this.categoryService.create(dto, user.userId);
  }

  @RequirePermissions('category:update')
  @Patch(':id')
  @ApiOperation({
    description: 'Sửa nhóm sản phẩm. Gửi null cho parentId để đưa về nhóm gốc; không tạo được vòng cây.',
  })
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateCategoryRequest,
    @CurrentUser() user: JwtUser,
  ) {
    return this.categoryService.update(id, dto, user.userId);
  }

  @RequirePermissions('category:delete')
  @Delete(':id')
  @ApiOperation({ description: 'Xoá mềm nhóm sản phẩm. Từ chối nếu còn nhóm con hoặc sản phẩm tham chiếu.' })
  remove(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.categoryService.remove(id);
  }
}
