import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { CurrentActor, type RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthzGuard } from '../../feature-auth/authz/guards/auth.guard';
import { RequirePermissions } from '../../feature-auth/permission/decorators/require-permissions.decorator';
import { PermissionGuard } from '../../feature-auth/permission/guards/permission.guard';
import { CreateProductRequest, UpdateProductRequest } from './dtos/product.request';
import { ProductQuery } from './dtos/product.query';
import { ProductService } from './product.service';
import { AuthRole } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';
import type { JwtUser } from '../../feature-auth/authz/types/authz.types';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { permissionError } from '../../feature-auth/permission/permission.error';
import { PermissionService } from '../../feature-auth/permission/permission.service';

@Controller('product')
@ApiTags('Product')
@ApiBearerAuth(AUTH_JWT)
@ApiResponse({
  status: 400,
  description: 'Mã lỗi: RECORD_NOT_FOUND (1600), DUPLICATE_CODE (1601), INVALID_REFERENCE (1602)',
})
@UseGuards(AuthzGuard, PermissionGuard)
export class ProductController {
  constructor(
    private readonly productService: ProductService,
    private readonly permissions: PermissionService,
  ) {}

  @RequirePermissions('product:read')
  @Get()
  @ApiOperation({
    description:
      'Danh sách sản phẩm kèm nhóm/hãng/đơn vị cơ bản tóm tắt. Tìm theo mã/mã vạch/tên/hoạt chất, lọc theo nhóm, hãng, đơn vị, trạng thái, dạng bào chế, thuốc kê đơn.',
  })
  async list(@Query() query: ProductQuery, @CurrentUser() user: JwtUser) {
    // `deleted=true` (xem hàng đã xoá để khôi phục) chỉ dành cho người có quyền xoá sản phẩm.
    if (query.deleted) await this.assertCanDelete(user);
    return this.productService.list(query, query.deleted === true);
  }

  private async assertCanDelete(user: JwtUser): Promise<void> {
    if (user.role === AuthRole.SUPER_ADMIN) return;
    if (!(await this.permissions.getGrantedCodes(user.role)).has('product:delete')) {
      throw permissionError(ErrorCode.PERMISSION_DENIED);
    }
  }

  @RequirePermissions('product:read')
  @Get(':id')
  @ApiOperation({ description: 'Chi tiết sản phẩm kèm cấu hình đơn vị bán đang hoạt động.' })
  detail(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.productService.getDetail(id);
  }

  @RequirePermissions('product:create')
  @Post()
  @ApiOperation({
    description:
      'Tạo sản phẩm kèm cấu hình đơn vị bán trong một transaction. Phải có đúng một dòng isBaseUnit = true khớp baseUnitId và có conversionRate = 1.',
  })
  create(@Body() dto: CreateProductRequest, @CurrentActor() actor: RequestActor) {
    return this.productService.create(dto, actor);
  }

  @RequirePermissions('product:update')
  @Patch(':id')
  @ApiOperation({
    description:
      'Sửa sản phẩm. Không gửi units để giữ nguyên cấu hình đơn vị bán; có gửi units là thay TOÀN BỘ — dòng vắng mặt bị xoá mềm. Đổi baseUnitId bắt buộc gửi kèm units.',
  })
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateProductRequest,
    @CurrentActor() actor: RequestActor,
  ) {
    return this.productService.update(id, dto, actor);
  }

  @RequirePermissions('product:delete')
  @Delete(':id')
  @ApiOperation({ description: 'Xoá mềm sản phẩm và toàn bộ đơn vị bán đang hoạt động trong một transaction.' })
  remove(@Param('id', new ParseUUIDPipe()) id: string, @CurrentActor() actor: RequestActor) {
    return this.productService.remove(id, actor);
  }

  @RequirePermissions('product:delete')
  @Post(':id/restore')
  @ApiOperation({
    description:
      'Khôi phục sản phẩm đã xoá mềm cùng các đơn vị bán bị xoá cùng lúc. Mã sản phẩm giữ nguyên; mã vạch đã nhả khi xoá nên rỗng, nhập lại bằng PATCH. Sản phẩm chưa xoá → 1600.',
  })
  restore(@Param('id', new ParseUUIDPipe()) id: string, @CurrentActor() actor: RequestActor) {
    return this.productService.restore(id, actor);
  }
}
