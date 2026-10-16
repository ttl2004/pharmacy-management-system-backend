import { Module } from '@nestjs/common';
import { AuthzModule } from '../../feature-auth/authz/authz.module';
import { PermissionModule } from '../../feature-auth/permission/permission.module';
import { SalesCoreModule } from '../core/sales-core.module';
import { OrderExpiryJob } from './order-expiry.job';
import { OrderController } from './order.controller';
import { OrderService } from './order.service';
import { PosProductService } from './pos-product.service';
import { OrderRepository } from './repositories/order.repository';
import { PosProductRepository } from './repositories/pos-product.repository';

@Module({
  imports: [SalesCoreModule, PermissionModule, AuthzModule],
  controllers: [OrderController],
  providers: [OrderService, OrderRepository, PosProductService, PosProductRepository, OrderExpiryJob],
})
export class OrderModule {}
