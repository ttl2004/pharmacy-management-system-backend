import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { CurrentActor, type RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthzGuard } from '../../feature-auth/authz/guards/auth.guard';
import { RequirePermissions } from '../../feature-auth/permission/decorators/require-permissions.decorator';
import { PermissionGuard } from '../../feature-auth/permission/guards/permission.guard';
import { InternalUseTypeRequest, InternalUseTypeService } from './internal-use-type.service';

/** Đọc cần quyền xem phiếu điều chỉnh; thêm/sửa/xoá chỉ ADMIN (`internal-use-type:manage`, danh mục toàn chuỗi). */
@Controller('internal-use-type')
@ApiTags('StockAdjustment')
@ApiBearerAuth(AUTH_JWT)
@UseGuards(AuthzGuard, PermissionGuard)
export class InternalUseTypeController {
  constructor(private readonly service: InternalUseTypeService) {}

  @RequirePermissions('stock-adjustment:read')
  @Get()
  @ApiOperation({ description: 'Loại xuất dùng nội bộ, xếp theo tên.' })
  list() {
    return this.service.list();
  }

  @RequirePermissions('internal-use-type:manage')
  @Post()
  @ApiOperation({ description: 'Tạo loại xuất. Trùng tên → 1601.' })
  create(@Body() dto: InternalUseTypeRequest, @CurrentActor() actor: RequestActor) {
    return this.service.create(dto, actor);
  }

  @RequirePermissions('internal-use-type:manage')
  @Put(':id')
  @ApiOperation({ description: 'Đổi tên loại xuất.' })
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: InternalUseTypeRequest,
    @CurrentActor() actor: RequestActor,
  ) {
    return this.service.update(id, dto, actor);
  }

  @RequirePermissions('internal-use-type:manage')
  @Delete(':id')
  @ApiOperation({ description: 'Xoá loại xuất chưa có phiếu dùng (đã dùng → 1602).' })
  remove(@Param('id', new ParseUUIDPipe()) id: string, @CurrentActor() actor: RequestActor) {
    return this.service.remove(id, actor);
  }
}
