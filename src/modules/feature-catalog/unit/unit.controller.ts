import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { AuthzGuard } from '../../feature-auth/authz/guards/auth.guard';
import type { JwtUser } from '../../feature-auth/authz/types/authz.types';
import { RequirePermissions } from '../../feature-auth/permission/decorators/require-permissions.decorator';
import { PermissionGuard } from '../../feature-auth/permission/guards/permission.guard';
import { CreateUnitRequest, UpdateUnitRequest } from './dtos/unit.request';
import { UnitQuery } from './dtos/unit.query';
import { UnitService } from './unit.service';

@Controller('unit')
@ApiTags('Unit')
@ApiBearerAuth(AUTH_JWT)
@ApiResponse({
  status: 400,
  description: 'Mã lỗi: RECORD_NOT_FOUND (1600), DUPLICATE_CODE (1601), INVALID_REFERENCE (1602)',
})
@UseGuards(AuthzGuard, PermissionGuard)
export class UnitController {
  constructor(private readonly unitService: UnitService) {}

  @RequirePermissions('unit:read')
  @Get()
  @ApiOperation({ description: 'Danh sách đơn vị tính, tìm theo mã/tên.' })
  list(@Query() query: UnitQuery) {
    return this.unitService.list(query);
  }

  @RequirePermissions('unit:read')
  @Get(':id')
  @ApiOperation({ description: 'Chi tiết đơn vị tính.' })
  detail(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.unitService.getDetail(id);
  }

  @RequirePermissions('unit:create')
  @Post()
  @ApiOperation({ description: 'Tạo đơn vị tính. Bảng đơn vị không có trạng thái hoạt động.' })
  create(@Body() dto: CreateUnitRequest, @CurrentUser() user: JwtUser) {
    return this.unitService.create(dto, user.userId);
  }

  @RequirePermissions('unit:update')
  @Patch(':id')
  @ApiOperation({ description: 'Sửa đơn vị tính. Gửi null cho note để xoá ghi chú.' })
  update(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: UpdateUnitRequest, @CurrentUser() user: JwtUser) {
    return this.unitService.update(id, dto, user.userId);
  }

  @RequirePermissions('unit:delete')
  @Delete(':id')
  @ApiOperation({
    description: 'Xoá mềm đơn vị tính. Từ chối nếu đang là đơn vị cơ bản hoặc có trong cấu hình đơn vị bán.',
  })
  remove(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.unitService.remove(id);
  }
}
