import { Module } from '@nestjs/common';
import { InventoryCoreModule } from './core/inventory-core.module';
import { GoodsReceiptModule } from './goods-receipt/goods-receipt.module';
import { SupplierModule } from './supplier/supplier.module';

/**
 * Gốc của module kho. Mỗi giai đoạn thêm một module con vào `imports` (nhà cung cấp, phiếu nhập, tồn kho,
 * điều chuyển, điều chỉnh) — `AppModule` chỉ import đúng module này.
 */
@Module({
  imports: [InventoryCoreModule, SupplierModule, GoodsReceiptModule],
})
export class InventoryModule {}
