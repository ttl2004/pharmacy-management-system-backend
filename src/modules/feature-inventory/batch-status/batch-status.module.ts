import { Module } from '@nestjs/common';
import { AuthzModule } from '../../feature-auth/authz/authz.module';
import { PermissionModule } from '../../feature-auth/permission/permission.module';
import { InventoryCoreModule } from '../core/inventory-core.module';
import { BatchStatusController } from './batch-status.controller';
import { BatchStatusService } from './batch-status.service';

@Module({
  imports: [InventoryCoreModule, PermissionModule, AuthzModule],
  controllers: [BatchStatusController],
  providers: [BatchStatusService],
})
export class BatchStatusModule {}
