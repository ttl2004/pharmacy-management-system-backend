import { Module } from '@nestjs/common';
import { AuthzModule } from '../../feature-auth/authz/authz.module';
import { PermissionModule } from '../../feature-auth/permission/permission.module';
import { InventoryCoreModule } from '../core/inventory-core.module';
import { SupplierGroupRepository } from './repositories/supplier-group.repository';
import { SupplierGroupController } from './supplier-group.controller';
import { SupplierGroupService } from './supplier-group.service';

@Module({
  imports: [InventoryCoreModule, PermissionModule, AuthzModule],
  controllers: [SupplierGroupController],
  providers: [SupplierGroupService, SupplierGroupRepository],
})
export class SupplierGroupModule {}
