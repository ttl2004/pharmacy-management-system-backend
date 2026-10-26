import { Module } from '@nestjs/common';
import { AuthzModule } from '../../feature-auth/authz/authz.module';
import { PermissionModule } from '../../feature-auth/permission/permission.module';
import { InventoryCoreModule } from '../core/inventory-core.module';
import { AdjustmentController } from './adjustment.controller';
import { AdjustmentService } from './adjustment.service';
import { InternalUseTypeController } from './internal-use-type.controller';
import { InternalUseTypeService } from './internal-use-type.service';
import { PurchaseReturnMoneyService } from './purchase-return-money.service';
import { AdjustmentRepository } from './repositories/adjustment.repository';
import { PurchaseReturnRepository } from './repositories/purchase-return.repository';

@Module({
  imports: [InventoryCoreModule, PermissionModule, AuthzModule],
  controllers: [AdjustmentController, InternalUseTypeController],
  providers: [
    AdjustmentService, AdjustmentRepository, InternalUseTypeService, PurchaseReturnMoneyService, PurchaseReturnRepository,
  ],
})
export class AdjustmentModule {}
