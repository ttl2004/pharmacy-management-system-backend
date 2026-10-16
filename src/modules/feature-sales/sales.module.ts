import { Module } from '@nestjs/common';
import { SalesCoreModule } from './core/sales-core.module';
import { OrderModule } from './order/order.module';

/** Gốc của module bán hàng. Hiện là bán tại quầy; bán online (giỏ hàng, đặt hàng, giao hàng) thêm module con sau. */
@Module({
  imports: [SalesCoreModule, OrderModule],
})
export class SalesModule {}
