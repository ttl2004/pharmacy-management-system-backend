import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { StorefrontCategoryService } from './storefront-category.service';

/** Route công khai: cố ý không gắn AuthzGuard/PermissionGuard và không cần Bearer token. */
@Controller('storefront/category')
@ApiTags('Storefront')
export class StorefrontCategoryController {
  constructor(private readonly storefrontCategoryService: StorefrontCategoryService) {}

  @Get()
  @ApiOperation({
    description:
      'Danh sách nhóm sản phẩm đang hoạt động cho menu storefront — không cần đăng nhập. Kèm parentId để client tự dựng cây.',
  })
  list() {
    return this.storefrontCategoryService.list();
  }
}
