import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { AuthzGuard } from '../../feature-auth/authz/guards/auth.guard';
import type { JwtUser } from '../../feature-auth/authz/types/authz.types';
import { RequirePermissions } from '../../feature-auth/permission/decorators/require-permissions.decorator';
import { PermissionGuard } from '../../feature-auth/permission/guards/permission.guard';
import { PriceBookRequest } from './dtos/price-book.request';
import { PriceRowsFilterRequest, PriceRowsQuery, SetBookItemRequest, SetGeneralPriceRequest } from './dtos/price-book-rows.request';
import { PriceBookItemsService } from './price-book-items.service';
import { PriceBookRowsService } from './price-book-rows.service';
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
  constructor(
    private readonly priceBookService: PriceBookService,
    private readonly rowsService: PriceBookRowsService,
    private readonly itemsService: PriceBookItemsService,
  ) {}

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

  @RequirePermissions('product:read')
  @Get('rows')
  @ApiOperation({
    description:
      'Trang dòng giá: mỗi dòng một (hàng, đơn vị) kèm giá vốn, giá nhập cuối theo chi nhánh, giá chung và giá các bảng trong bookIds. Trả {items, total, page, pageSize}.',
  })
  rows(@Query() query: PriceRowsQuery, @CurrentUser() user: JwtUser) {
    return this.rowsService.listRows(query, user);
  }

  @RequirePermissions('price-book:update')
  @Put('general-price')
  @ApiOperation({ description: 'Sửa giá chung (product_units.salePrice). Chỉ vai trò toàn chuỗi; quản lý chi nhánh → 403.' })
  setGeneralPrice(@Body() dto: SetGeneralPriceRequest, @CurrentUser() user: JwtUser) {
    return this.rowsService.setGeneralPrice(dto, user);
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
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: PriceBookRequest,
    @CurrentUser() user: JwtUser,
    @Query('branchId', new ParseUUIDPipe({ optional: true })) branchId?: string,
  ) {
    return this.priceBookService.update(id, dto, user, branchId);
  }

  @RequirePermissions('price-book:update')
  @Put(':id/items')
  @ApiOperation({ description: 'Sửa giá một ô: price là số -> thêm/cập nhật, null -> bỏ hàng khỏi bảng.' })
  setItem(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: SetBookItemRequest, @CurrentUser() user: JwtUser) {
    return this.itemsService.setItem(id, dto, user);
  }

  @RequirePermissions('price-book:update')
  @Post(':id/apply-formula')
  @ApiOperation({
    description: 'Áp công thức của bảng cho mọi dòng khớp bộ lọc trong body (như query của /rows). Trả {count}.',
  })
  applyFormula(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: PriceRowsFilterRequest,
    @CurrentUser() user: JwtUser,
  ) {
    return this.itemsService.applyFormulaToFilter(id, dto, user);
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
