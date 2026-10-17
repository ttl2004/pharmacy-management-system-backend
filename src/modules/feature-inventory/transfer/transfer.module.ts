import { Module } from '@nestjs/common';
import { AuthzModule } from '../../feature-auth/authz/authz.module';
import { PermissionModule } from '../../feature-auth/permission/permission.module';
import { InventoryCoreModule } from '../core/inventory-core.module';
import { TransferRepository } from './repositories/transfer.repository';
import { TransferController } from './transfer.controller';
import { TransferService } from './transfer.service';

@Module({
  imports: [InventoryCoreModule, PermissionModule, AuthzModule],
  controllers: [TransferController],
  providers: [TransferService, TransferRepository],
})
export class TransferModule {}
