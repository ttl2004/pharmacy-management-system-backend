import { Module } from '@nestjs/common';
import { AuthzModule } from '../../feature-auth/authz/authz.module';
import { PermissionModule } from '../../feature-auth/permission/permission.module';
import { InventoryCoreModule } from '../core/inventory-core.module';
import { SupplierListWithTotalsRepository } from './repositories/supplier-list-with-totals.repository';
import { SupplierRepository } from './repositories/supplier.repository';
import { SupplierController } from './supplier.controller';
import { SupplierListService } from './supplier-list.service';
import { SupplierService } from './supplier.service';

@Module({
  imports: [InventoryCoreModule, PermissionModule, AuthzModule],
  controllers: [SupplierController],
  providers: [SupplierService, SupplierListService, SupplierRepository, SupplierListWithTotalsRepository],
  exports: [SupplierRepository],
})
export class SupplierModule {}
