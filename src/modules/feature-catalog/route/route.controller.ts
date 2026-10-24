import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { AuthzGuard } from '../../feature-auth/authz/guards/auth.guard';
import type { JwtUser } from '../../feature-auth/authz/types/authz.types';
import { RequirePermissions } from '../../feature-auth/permission/decorators/require-permissions.decorator';
import { PermissionGuard } from '../../feature-auth/permission/guards/permission.guard';
import { CreateLocationRequest as CreateRouteRequest } from '../location/dtos/location.request';
import { RouteService } from './route.service';

/** Đường dùng: danh mục nhỏ đi kèm sản phẩm — dùng quyền sản phẩm như Vị trí. Body giống Vị trí (`name`). */
@Controller('route')
@ApiTags('Route')
@ApiBearerAuth(AUTH_JWT)
@ApiResponse({ status: 400, description: 'Mã lỗi: DUPLICATE_CODE (1601) — trùng tên đường dùng' })
@UseGuards(AuthzGuard, PermissionGuard)
export class RouteController {
  constructor(private readonly routeService: RouteService) {}

  @RequirePermissions('product:read')
  @Get()
  @ApiOperation({ description: 'Toàn bộ đường dùng, xếp theo tên. Không phân trang.' })
  list() {
    return this.routeService.list();
  }

  @RequirePermissions('product:create')
  @Post()
  @ApiOperation({ description: 'Tạo đường dùng. Tên trùng (không phân biệt hoa thường) → 1601.' })
  create(@Body() dto: CreateRouteRequest, @CurrentUser() user: JwtUser) {
    return this.routeService.create(dto, user.userId);
  }
}
