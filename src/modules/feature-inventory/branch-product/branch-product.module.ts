import { Module } from '@nestjs/common';
import { AuthzModule } from '../../feature-auth/authz/authz.module';
import { PermissionModule } from '../../feature-auth/permission/permission.module';
import { InventoryCoreModule } from '../core/inventory-core.module';
import { BranchProductController } from './branch-product.controller';
import { BranchProductService } from './branch-product.service';

@Module({
  imports: [InventoryCoreModule, PermissionModule, AuthzModule],
  controllers: [BranchProductController],
  providers: [BranchProductService],
})
export class BranchProductModule {}
