import { Module } from '@nestjs/common';
import { AdjustmentModule } from './adjustment/adjustment.module';
import { BatchStatusModule } from './batch-status/batch-status.module';
import { BranchProductModule } from './branch-product/branch-product.module';
import { InventoryCoreModule } from './core/inventory-core.module';
import { GoodsReceiptModule } from './goods-receipt/goods-receipt.module';
import { StockModule } from './stock/stock.module';
import { SupplierModule } from './supplier/supplier.module';
import { TransferModule } from './transfer/transfer.module';

/**
 * Gốc của module kho. Mỗi giai đoạn thêm một module con vào `imports` (nhà cung cấp, phiếu nhập, tồn kho,
 * điều chuyển, điều chỉnh) — `AppModule` chỉ import đúng module này.
 */
@Module({
  imports: [
    InventoryCoreModule,
    SupplierModule,
    GoodsReceiptModule,
    StockModule,
    BranchProductModule,
    TransferModule,
    AdjustmentModule,
    BatchStatusModule,
  ],
})
export class InventoryModule {}
