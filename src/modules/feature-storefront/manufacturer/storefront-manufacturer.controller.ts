import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { StorefrontManufacturerService } from './storefront-manufacturer.service';

/** Route công khai: cố ý không gắn AuthzGuard/PermissionGuard và không cần Bearer token. */
@Controller('storefront/manufacturer')
@ApiTags('Storefront')
export class StorefrontManufacturerController {
  constructor(private readonly storefrontManufacturerService: StorefrontManufacturerService) {}

  @Get()
  @ApiOperation({
    description: 'Danh sách hãng sản xuất đang hoạt động cho bộ lọc storefront — không cần đăng nhập.',
  })
  list() {
    return this.storefrontManufacturerService.list();
  }
}
