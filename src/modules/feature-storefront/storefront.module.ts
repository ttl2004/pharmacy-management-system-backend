import { Module } from '@nestjs/common';
import { CatalogModule } from '../feature-catalog/catalog.module';
import { StorefrontCategoryController } from './category/storefront-category.controller';
import { StorefrontCategoryService } from './category/storefront-category.service';
import { StorefrontManufacturerController } from './manufacturer/storefront-manufacturer.controller';
import { StorefrontManufacturerService } from './manufacturer/storefront-manufacturer.service';
import { StorefrontProductController } from './product/storefront-product.controller';
import { StorefrontProductService } from './product/storefront-product.service';

/**
 * Bề mặt đọc công khai cho khách chưa đăng nhập. Dùng lại repository của `CatalogModule` (đã export)
 * để không nhân đôi truy vấn; chỉ khác bộ trường trả về và luôn ép trạng thái ACTIVE.
 */
@Module({
  imports: [CatalogModule],
  controllers: [StorefrontProductController, StorefrontCategoryController, StorefrontManufacturerController],
  providers: [StorefrontProductService, StorefrontCategoryService, StorefrontManufacturerService],
})
export class StorefrontModule {}
