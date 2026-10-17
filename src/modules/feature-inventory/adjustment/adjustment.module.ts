import { Module } from '@nestjs/common';
import { AuthzModule } from '../../feature-auth/authz/authz.module';
import { PermissionModule } from '../../feature-auth/permission/permission.module';
import { InventoryCoreModule } from '../core/inventory-core.module';
import { AdjustmentController } from './adjustment.controller';
import { AdjustmentService } from './adjustment.service';
import { AdjustmentRepository } from './repositories/adjustment.repository';

@Module({
  imports: [InventoryCoreModule, PermissionModule, AuthzModule],
  controllers: [AdjustmentController],
  providers: [AdjustmentService, AdjustmentRepository],
})
export class AdjustmentModule {}
