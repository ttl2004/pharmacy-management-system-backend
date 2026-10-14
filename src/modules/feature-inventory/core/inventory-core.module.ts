import { Module } from '@nestjs/common';
import { AuditLogModule } from 'src/providers/audit-log/audit-log.module';
import { DocumentCodeService } from './document-code.service';
import { InventoryEvents } from './inventory-events';
import { InventoryTransactions } from './inventory-transactions';
import { StockBatchRepository } from './stock-batch.repository';
import { StockIntakeService } from './stock-intake.service';
import { StockLedgerRepository } from './stock-ledger.repository';
import { StockLedgerService } from './stock-ledger.service';

/**
 * Hạ tầng dùng chung của mọi module kho. `StockLedgerRepository` cố ý KHÔNG export: module khác chỉ được đi qua
 * `StockLedgerService` (chỗ duy nhất đổi tồn). `StockBatchRepository` được export vì không đổi tồn — thu hồi lô dùng
 * chung khoá số lô với lúc đưa hàng vào.
 */
@Module({
  imports: [AuditLogModule],
  providers: [
    InventoryTransactions,
    InventoryEvents,
    DocumentCodeService,
    StockLedgerRepository,
    StockLedgerService,
    StockBatchRepository,
    StockIntakeService,
  ],
  exports: [
    InventoryTransactions,
    InventoryEvents,
    DocumentCodeService,
    StockLedgerService,
    StockBatchRepository,
    StockIntakeService,
    AuditLogModule,
  ],
})
export class InventoryCoreModule {}
