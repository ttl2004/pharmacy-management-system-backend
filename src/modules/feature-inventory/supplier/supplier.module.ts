import { Module } from '@nestjs/common';
import { AuthzModule } from '../../feature-auth/authz/authz.module';
import { PermissionModule } from '../../feature-auth/permission/permission.module';
import { InventoryCoreModule } from '../core/inventory-core.module';
import { SupplierRepository } from './repositories/supplier.repository';
import { SupplierController } from './supplier.controller';
import { SupplierService } from './supplier.service';

@Module({
  imports: [InventoryCoreModule, PermissionModule, AuthzModule],
  controllers: [SupplierController],
  providers: [SupplierService, SupplierRepository],
  exports: [SupplierRepository],
})
export class SupplierModule {}
