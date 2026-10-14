import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { CurrentActor, type RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthzGuard } from '../../feature-auth/authz/guards/auth.guard';
import { RequirePermissions } from '../../feature-auth/permission/decorators/require-permissions.decorator';
import { PermissionGuard } from '../../feature-auth/permission/guards/permission.guard';
import { CreateSupplierRequest, UpdateSupplierRequest } from './dtos/supplier.request';
import { SupplierQuery } from './dtos/supplier.query';
import { SupplierService } from './supplier.service';

@Controller('supplier')
@ApiTags('Supplier')
@ApiBearerAuth(AUTH_JWT)
@ApiResponse({
  status: 400,
  description: 'Mã lỗi: RECORD_NOT_FOUND (1600), DUPLICATE_CODE (1601), INVALID_REFERENCE (1602)',
})
@UseGuards(AuthzGuard, PermissionGuard)
export class SupplierController {
  constructor(private readonly supplierService: SupplierService) {}

  @RequirePermissions('supplier:read')
  @Get()
  @ApiOperation({ description: 'Danh sách nhà cung cấp, tìm theo mã/tên/SĐT/mã số thuế, lọc theo trạng thái.' })
  list(@Query() query: SupplierQuery) {
    return this.supplierService.list(query);
  }

  @RequirePermissions('supplier:read')
  @Get(':id')
  @ApiOperation({ description: 'Chi tiết nhà cung cấp.' })
  detail(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.supplierService.getDetail(id);
  }

  @RequirePermissions('supplier:create')
  @Post()
  @ApiOperation({ description: 'Tạo nhà cung cấp.' })
  create(@Body() dto: CreateSupplierRequest, @CurrentActor() actor: RequestActor) {
    return this.supplierService.create(dto, actor);
  }

  @RequirePermissions('supplier:update')
  @Patch(':id')
  @ApiOperation({ description: 'Sửa nhà cung cấp. Gửi null để xoá các trường tuỳ chọn.' })
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateSupplierRequest,
    @CurrentActor() actor: RequestActor,
  ) {
    return this.supplierService.update(id, dto, actor);
  }

  @RequirePermissions('supplier:delete')
  @Delete(':id')
  @ApiOperation({ description: 'Xoá mềm. Từ chối (1602) nếu đã có chứng từ kho — khi đó chuyển INACTIVE.' })
  remove(@Param('id', new ParseUUIDPipe()) id: string, @CurrentActor() actor: RequestActor) {
    return this.supplierService.remove(id, actor);
  }
}
