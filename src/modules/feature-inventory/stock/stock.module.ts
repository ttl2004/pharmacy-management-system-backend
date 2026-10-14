import { Module } from '@nestjs/common';
import { AuthzModule } from '../../feature-auth/authz/authz.module';
import { PermissionModule } from '../../feature-auth/permission/permission.module';
import { StockQueryRepository } from './repositories/stock-query.repository';
import { StockController } from './stock.controller';
import { StockQueryService } from './stock-query.service';

@Module({
  imports: [PermissionModule, AuthzModule],
  controllers: [StockController],
  providers: [StockQueryService, StockQueryRepository],
})
export class StockModule {}
