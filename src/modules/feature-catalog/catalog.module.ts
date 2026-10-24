import { Module } from '@nestjs/common';
import { AuditLogModule } from 'src/providers/audit-log/audit-log.module';
import { AuthzModule } from '../feature-auth/authz/authz.module';
import { PermissionModule } from '../feature-auth/permission/permission.module';
import { CatalogTransactions } from './catalog-transactions';
import { CategoryController } from './category/category.controller';
import { CategoryService } from './category/category.service';
import { CategoryRepository } from './category/repositories/category.repository';
import { LocationController } from './location/location.controller';
import { LocationService } from './location/location.service';
import { LocationRepository } from './location/repositories/location.repository';
import { RouteController } from './route/route.controller';
import { RouteService } from './route/route.service';
import { ManufacturerController } from './manufacturer/manufacturer.controller';
import { ManufacturerService } from './manufacturer/manufacturer.service';
import { ManufacturerRepository } from './manufacturer/repositories/manufacturer.repository';
import { UnitController } from './unit/unit.controller';
import { UnitService } from './unit/unit.service';
import { UnitRepository } from './unit/repositories/unit.repository';
import { ProductController } from './product/product.controller';
import { ProductImageController } from './product/product-image.controller';
import { ProductImageService } from './product/product-image.service';
import { ProductService } from './product/product.service';
import { ProductRepository } from './product/repositories/product.repository';

@Module({
  imports: [PermissionModule, AuthzModule, AuditLogModule],
  controllers: [
    CategoryController,
    ManufacturerController,
    UnitController,
    ProductController,
    ProductImageController,
    LocationController,
    RouteController,
  ],
  providers: [
    CatalogTransactions,
    ProductImageService,
    LocationService,
    LocationRepository,
    RouteService,
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
