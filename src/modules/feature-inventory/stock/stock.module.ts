import { Module } from '@nestjs/common';
import { AuthzModule } from '../../feature-auth/authz/authz.module';
import { PermissionModule } from '../../feature-auth/permission/permission.module';
import { InventoryCoreModule } from '../core/inventory-core.module';
import { StockQueryRepository } from './repositories/stock-query.repository';
import { StockController } from './stock.controller';
import { StockOpeningController } from './stock-opening.controller';
import { StockOpeningService } from './stock-opening.service';
import { StockQueryService } from './stock-query.service';

@Module({
  imports: [PermissionModule, AuthzModule, InventoryCoreModule],
  controllers: [StockController, StockOpeningController],
  providers: [StockQueryService, StockQueryRepository, StockOpeningService],
})
export class StockModule {}
