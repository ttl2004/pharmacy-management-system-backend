import { Module } from '@nestjs/common';
import { InventoryCoreModule } from 'src/modules/feature-inventory/core/inventory-core.module';
import { OrderStockRepository } from './order-stock.repository';
import { OrderStockService } from './order-stock.service';

/**
 * Lõi dùng chung của mọi module bán hàng. Re-export `InventoryCoreModule` vì đơn hàng cần transaction kho, bộ sinh mã và nhật
 * ký; `OrderStockRepository` cố ý không export — module khác chỉ đi qua `OrderStockService`.
 */
@Module({
  imports: [InventoryCoreModule],
  providers: [OrderStockRepository, OrderStockService],
  exports: [OrderStockService, InventoryCoreModule],
})
export class SalesCoreModule {}
