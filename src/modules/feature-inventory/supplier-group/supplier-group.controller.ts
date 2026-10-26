import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { CurrentActor, type RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthzGuard } from '../../feature-auth/authz/guards/auth.guard';
import { RequirePermissions } from '../../feature-auth/permission/decorators/require-permissions.decorator';
import { PermissionGuard } from '../../feature-auth/permission/guards/permission.guard';
import { CreateSupplierGroupRequest, UpdateSupplierGroupRequest } from './dtos/supplier-group.request';
import { SupplierGroupService } from './supplier-group.service';

@Controller('supplier-group')
@ApiTags('Supplier Group')
@ApiBearerAuth(AUTH_JWT)
@ApiResponse({ status: 400, description: 'Mã lỗi: RECORD_NOT_FOUND (1600), DUPLICATE_CODE (1601 — trùng tên nhóm)' })
@UseGuards(AuthzGuard, PermissionGuard)
export class SupplierGroupController {
  constructor(private readonly service: SupplierGroupService) {}

  @RequirePermissions('supplier:read')
  @Get()
  @ApiOperation({ description: 'Mọi nhóm NCC, xếp theo tên, không phân trang.' })
  list() {
    return this.service.list();
  }

  @RequirePermissions('supplier:create')
  @Post()
  @ApiOperation({ description: 'Tạo nhóm NCC. Tên không phân biệt hoa thường, không được trùng.' })
  create(@Body() dto: CreateSupplierGroupRequest, @CurrentActor() actor: RequestActor) {
    return this.service.create(dto, actor);
  }

  @RequirePermissions('supplier:update')
  @Patch(':id')
  @ApiOperation({ description: 'Sửa nhóm NCC. Gửi note = null để xoá ghi chú.' })
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateSupplierGroupRequest,
    @CurrentActor() actor: RequestActor,
  ) {
    return this.service.update(id, dto, actor);
  }

  @RequirePermissions('supplier:delete')
  @Delete(':id')
  @ApiOperation({ description: 'Xoá mềm nhóm; NCC thuộc nhóm được đưa về chưa phân nhóm.' })
  remove(@Param('id', new ParseUUIDPipe()) id: string, @CurrentActor() actor: RequestActor) {
    return this.service.remove(id, actor);
  }
}
