import { Module } from '@nestjs/common';
import { AuthzModule } from '../feature-auth/authz/authz.module';
import { PermissionModule } from '../feature-auth/permission/permission.module';
import { CategoryController } from './category/category.controller';
import { CategoryService } from './category/category.service';
import { CategoryRepository } from './category/repositories/category.repository';
import { ManufacturerController } from './manufacturer/manufacturer.controller';
import { ManufacturerService } from './manufacturer/manufacturer.service';
import { ManufacturerRepository } from './manufacturer/repositories/manufacturer.repository';
import { UnitController } from './unit/unit.controller';
import { UnitService } from './unit/unit.service';
import { UnitRepository } from './unit/repositories/unit.repository';
import { ProductController } from './product/product.controller';
import { ProductService } from './product/product.service';
import { ProductRepository } from './product/repositories/product.repository';

@Module({
  imports: [PermissionModule, AuthzModule],
  controllers: [CategoryController, ManufacturerController, UnitController, ProductController],
  providers: [
    CategoryService,
    CategoryRepository,
    ManufacturerService,
    ManufacturerRepository,
    UnitService,
    UnitRepository,
    ProductService,
    ProductRepository,
  ],
  // Repository được export để `StorefrontModule` dùng lại truy vấn đọc công khai, không viết lại.
  exports: [
    CategoryService,
    ManufacturerService,
    UnitService,
    ProductService,
    CategoryRepository,
    ManufacturerRepository,
    ProductRepository,
  ],
})
export class CatalogModule {}
