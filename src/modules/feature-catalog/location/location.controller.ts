import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { AuthzGuard } from '../../feature-auth/authz/guards/auth.guard';
import type { JwtUser } from '../../feature-auth/authz/types/authz.types';
import { RequirePermissions } from '../../feature-auth/permission/decorators/require-permissions.decorator';
import { PermissionGuard } from '../../feature-auth/permission/guards/permission.guard';
import { CreateLocationRequest } from './dtos/location.request';
import { LocationService } from './location.service';

/** Dùng chung quyền sản phẩm: vị trí chỉ là thuộc tính của sản phẩm, không có màn quản trị riêng. */
@Controller('location')
@ApiTags('Location')
@ApiBearerAuth(AUTH_JWT)
@ApiResponse({ status: 400, description: 'Mã lỗi: DUPLICATE_CODE (1601) — trùng tên vị trí' })
@UseGuards(AuthzGuard, PermissionGuard)
export class LocationController {
  constructor(private readonly locationService: LocationService) {}

  @RequirePermissions('product:read')
  @Get()
  @ApiOperation({ description: 'Toàn bộ vị trí (kệ/tủ), xếp theo tên. Không phân trang.' })
  list() {
    return this.locationService.list();
  }

  @RequirePermissions('product:create')
  @Post()
  @ApiOperation({ description: 'Tạo vị trí. Tên trùng (không phân biệt hoa thường) → 1601.' })
  create(@Body() dto: CreateLocationRequest, @CurrentUser() user: JwtUser) {
    return this.locationService.create(dto, user.userId);
  }
}
