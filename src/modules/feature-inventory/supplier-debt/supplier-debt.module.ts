import { Module } from '@nestjs/common';
import { AuthzModule } from '../../feature-auth/authz/authz.module';
import { PermissionModule } from '../../feature-auth/permission/permission.module';
import { InventoryCoreModule } from '../core/inventory-core.module';
import { SupplierDebtRepository } from './repositories/supplier-debt.repository';
import { SupplierDebtAdjustmentRepository } from './repositories/supplier-debt-adjustment.repository';
import { SupplierPaymentRepository } from './repositories/supplier-payment.repository';
import { SupplierDebtAdjustmentController } from './supplier-debt-adjustment.controller';
import { SupplierDebtAdjustmentService } from './supplier-debt-adjustment.service';
import { SupplierDebtController } from './supplier-debt.controller';
import { SupplierDebtLedgerService } from './supplier-debt-ledger.service';
import { SupplierPaymentController } from './supplier-payment.controller';
import { SupplierPaymentService } from './supplier-payment.service';
import { SupplierPaymentWriter } from './supplier-payment.writer';

/** Công nợ NCC. Xuất `SupplierPaymentWriter` + `SupplierDebtRepository` (khoá NCC, đọc nợ) cho `GoodsReceiptModule` (một chiều, không vòng). */
@Module({
  imports: [InventoryCoreModule, PermissionModule, AuthzModule],
  controllers: [SupplierPaymentController, SupplierDebtAdjustmentController, SupplierDebtController],
  providers: [
    SupplierPaymentService,
    SupplierDebtAdjustmentService,
    SupplierDebtLedgerService,
    SupplierPaymentWriter,
    SupplierPaymentRepository,
    SupplierDebtAdjustmentRepository,
    SupplierDebtRepository,
  ],
  exports: [SupplierPaymentWriter, SupplierDebtRepository],
})
export class SupplierDebtModule {}
