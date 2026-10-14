import { Module } from '@nestjs/common';
import { AuthzModule } from '../../feature-auth/authz/authz.module';
import { PermissionModule } from '../../feature-auth/permission/permission.module';
import { InventoryCoreModule } from '../core/inventory-core.module';
import { GoodsReceiptController } from './goods-receipt.controller';
import { GoodsReceiptService } from './goods-receipt.service';
import { GoodsReceiptRepository } from './repositories/goods-receipt.repository';

@Module({
  imports: [InventoryCoreModule, PermissionModule, AuthzModule],
  controllers: [GoodsReceiptController],
  providers: [GoodsReceiptService, GoodsReceiptRepository],
})
export class GoodsReceiptModule {}
