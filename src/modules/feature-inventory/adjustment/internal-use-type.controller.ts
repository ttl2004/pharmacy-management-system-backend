import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { CurrentActor, type RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthzGuard } from '../../feature-auth/authz/guards/auth.guard';
import { RequirePermissions } from '../../feature-auth/permission/decorators/require-permissions.decorator';
import { PermissionGuard } from '../../feature-auth/permission/guards/permission.guard';
import { InternalUseTypeRequest, InternalUseTypeService } from './internal-use-type.service';

/** Đọc cần quyền xem phiếu điều chỉnh; ghi cần quyền lập phiếu (như mock). */
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

  @RequirePermissions('stock-adjustment:create')
  @Post()
  @ApiOperation({ description: 'Tạo loại xuất. Trùng tên → 1601.' })
  create(@Body() dto: InternalUseTypeRequest, @CurrentActor() actor: RequestActor) {
    return this.service.create(dto, actor.user.userId);
  }

  @RequirePermissions('stock-adjustment:create')
  @Put(':id')
  @ApiOperation({ description: 'Đổi tên loại xuất.' })
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: InternalUseTypeRequest,
    @CurrentActor() actor: RequestActor,
  ) {
    return this.service.update(id, dto, actor.user.userId);
  }

  @RequirePermissions('stock-adjustment:create')
  @Delete(':id')
  @ApiOperation({ description: 'Xoá loại xuất chưa có phiếu dùng (đã dùng → 1602).' })
  remove(@Param('id', new ParseUUIDPipe()) id: string, @CurrentActor() actor: RequestActor) {
    return this.service.remove(id, actor.user.userId);
  }
}
