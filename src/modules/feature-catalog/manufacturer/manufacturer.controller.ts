import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { AuthzGuard } from '../../feature-auth/authz/guards/auth.guard';
import type { JwtUser } from '../../feature-auth/authz/types/authz.types';
import { RequirePermissions } from '../../feature-auth/permission/decorators/require-permissions.decorator';
import { PermissionGuard } from '../../feature-auth/permission/guards/permission.guard';
import { CreateManufacturerRequest, UpdateManufacturerRequest } from './dtos/manufacturer.request';
import { ManufacturerQuery } from './dtos/manufacturer.query';
import { ManufacturerService } from './manufacturer.service';

@Controller('manufacturer')
@ApiTags('Manufacturer')
@ApiBearerAuth(AUTH_JWT)
@ApiResponse({
  status: 400,
  description: 'Mã lỗi: RECORD_NOT_FOUND (1600), DUPLICATE_CODE (1601), INVALID_REFERENCE (1602)',
})
@UseGuards(AuthzGuard, PermissionGuard)
export class ManufacturerController {
  constructor(private readonly manufacturerService: ManufacturerService) {}

  @RequirePermissions('manufacturer:read')
  @Get()
  @ApiOperation({ description: 'Danh sách hãng sản xuất, tìm theo mã/tên/quốc gia, lọc theo trạng thái.' })
  list(@Query() query: ManufacturerQuery) {
    return this.manufacturerService.list(query);
  }

  @RequirePermissions('manufacturer:read')
  @Get(':id')
  @ApiOperation({ description: 'Chi tiết hãng sản xuất.' })
  detail(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.manufacturerService.getDetail(id);
  }

  @RequirePermissions('manufacturer:create')
  @Post()
  @ApiOperation({ description: 'Tạo hãng sản xuất.' })
  create(@Body() dto: CreateManufacturerRequest, @CurrentUser() user: JwtUser) {
    return this.manufacturerService.create(dto, user.userId);
  }

  @RequirePermissions('manufacturer:update')
  @Patch(':id')
  @ApiOperation({ description: 'Sửa hãng sản xuất. Gửi null cho country/address/note để xoá giá trị cũ.' })
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateManufacturerRequest,
    @CurrentUser() user: JwtUser,
  ) {
    return this.manufacturerService.update(id, dto, user.userId);
  }

  @RequirePermissions('manufacturer:delete')
  @Delete(':id')
  @ApiOperation({ description: 'Xoá mềm hãng sản xuất. Từ chối nếu còn sản phẩm tham chiếu.' })
  remove(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.manufacturerService.remove(id);
  }
}
