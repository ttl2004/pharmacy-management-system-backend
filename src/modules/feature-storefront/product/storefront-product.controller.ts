import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { StorefrontProductQuery } from './dtos/storefront-product.query';
import { StorefrontProductService } from './storefront-product.service';

/** Route công khai: cố ý không gắn AuthzGuard/PermissionGuard và không cần Bearer token. */
@Controller('storefront/product')
@ApiTags('Storefront')
@ApiResponse({ status: 400, description: 'Mã lỗi: RECORD_NOT_FOUND (1600)' })
export class StorefrontProductController {
  constructor(private readonly storefrontProductService: StorefrontProductService) {}

  @Get()
  @ApiOperation({
    description:
      'Danh sách sản phẩm cho khách — không cần đăng nhập. Chỉ trả sản phẩm đang bán; tìm theo tên/hoạt chất, lọc theo nhóm, hãng, dạng bào chế, thuốc kê đơn.',
  })
  list(@Query() query: StorefrontProductQuery) {
    return this.storefrontProductService.list(query);
  }

  @Get(':id')
  @ApiOperation({
    description: 'Chi tiết sản phẩm cho khách kèm giá theo từng đơn vị bán. Sản phẩm ngừng bán trả 1600.',
  })
  detail(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.storefrontProductService.getDetail(id);
  }
}
