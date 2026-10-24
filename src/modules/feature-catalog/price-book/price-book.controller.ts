import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { AuthzGuard } from '../../feature-auth/authz/guards/auth.guard';
import type { JwtUser } from '../../feature-auth/authz/types/authz.types';
import { RequirePermissions } from '../../feature-auth/permission/decorators/require-permissions.decorator';
import { PermissionGuard } from '../../feature-auth/permission/guards/permission.guard';
import { PriceBookRequest } from './dtos/price-book.request';
import { PriceBookService } from './price-book.service';

/**
 * Bảng giá (Thiết lập giá). Route tĩnh (`sellers`, `applicable`, và `rows`/`general-price` ở phần dòng giá) khai
 * báo TRƯỚC route `:id` để không bị hiểu nhầm thành id.
 */
@Controller('price-book')
@ApiTags('PriceBook')
@ApiBearerAuth(AUTH_JWT)
@ApiResponse({
  status: 400,
  description:
    'Mã lỗi: RECORD_NOT_FOUND (1600), DUPLICATE_CODE (1601) — trùng tên, INVALID_REFERENCE (1602), PRICE_BOOK_BASE_IN_USE (1606)',
})
@ApiResponse({ status: 403, description: 'Mã lỗi: BRANCH_ACCESS_DENIED (1506) — bảng ngoài phạm vi chi nhánh của người gọi' })
@UseGuards(AuthzGuard, PermissionGuard)
export class PriceBookController {
  constructor(private readonly priceBookService: PriceBookService) {}

  @RequirePermissions('product:read')
  @Get()
  @ApiOperation({
    description:
      'Bảng giá người gọi được xem, kèm itemCount và editable (có được sửa không). Quản lý chi nhánh thấy bảng toàn hệ thống + bảng có chi nhánh mình.',
  })
  list(@CurrentUser() user: JwtUser) {
    return this.priceBookService.list(user);
  }

  @RequirePermissions('product:read')
  @Get('sellers')
  @ApiOperation({ description: 'Người bán chọn được cho phạm vi áp dụng: {id, fullName}. Quản lý chi nhánh chỉ thấy người cùng chi nhánh.' })
  sellers(@CurrentUser() user: JwtUser) {
    return this.priceBookService.listSellers(user);
  }

  @RequirePermissions('order:create')
  @Get('applicable')
  @ApiOperation({ description: 'Bảng đang áp dụng cho POS ở chi nhánh này (theo người đăng nhập + hiệu lực), kèm toàn bộ giá.' })
  applicable(@Query('branchId', new ParseUUIDPipe()) branchId: string, @CurrentUser() user: JwtUser) {
    return this.priceBookService.listApplicable(branchId, user);
  }

  @RequirePermissions('price-book:update')
  @Post()
  @ApiOperation({
    description:
      'Tạo bảng giá. Quản lý chi nhánh bắt buộc branchIds = đúng [chi nhánh của mình] (rỗng = toàn hệ thống chỉ ADMIN).',
  })
  create(@Body() dto: PriceBookRequest, @CurrentUser() user: JwtUser) {
    return this.priceBookService.create(dto, user);
  }

  @RequirePermissions('price-book:update')
  @Put(':id')
  @ApiOperation({ description: 'Sửa bảng giá (gửi đủ trường). Bảng ngoài phạm vi sửa của người gọi → 403.' })
  update(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: PriceBookRequest, @CurrentUser() user: JwtUser) {
    return this.priceBookService.update(id, dto, user);
  }

  @RequirePermissions('price-book:update')
  @Delete(':id')
  @ApiOperation({
    description:
      'Xoá cứng bảng giá. Bảng khác lấy nó làm giá gốc thì bị gỡ công thức; nếu có bảng người gọi không sửa được → 1606.',
  })
  remove(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: JwtUser) {
    return this.priceBookService.remove(id, user);
  }
}
