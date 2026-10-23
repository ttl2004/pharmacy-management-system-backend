import { Module } from '@nestjs/common';
import { AuthzModule } from '../../feature-auth/authz/authz.module';
import { PermissionModule } from '../../feature-auth/permission/permission.module';
import { InventoryCoreModule } from '../core/inventory-core.module';
import { SupplierDebtModule } from '../supplier-debt/supplier-debt.module';
import { GoodsReceiptController } from './goods-receipt.controller';
import { GoodsReceiptDraftBuilder } from './goods-receipt-draft.builder';
import { GoodsReceiptLocker } from './goods-receipt-locker';
import { GoodsReceiptMetaService } from './goods-receipt-meta.service';
import { GoodsReceiptPaymentService } from './goods-receipt-payment.service';
import { GoodsReceiptService } from './goods-receipt.service';
import { GoodsReceiptRepository } from './repositories/goods-receipt.repository';

@Module({
  imports: [InventoryCoreModule, SupplierDebtModule, PermissionModule, AuthzModule],
  controllers: [GoodsReceiptController],
  providers: [
    GoodsReceiptService,
    GoodsReceiptMetaService,
    GoodsReceiptPaymentService,
    GoodsReceiptLocker,
    GoodsReceiptDraftBuilder,
    GoodsReceiptRepository,
  ],
})
export class GoodsReceiptModule {}
