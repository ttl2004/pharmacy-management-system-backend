import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { CurrentActor, type RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthzGuard } from '../../feature-auth/authz/guards/auth.guard';
import { RequirePermissions } from '../../feature-auth/permission/decorators/require-permissions.decorator';
import { PermissionGuard } from '../../feature-auth/permission/guards/permission.guard';
import { OpeningStockRequest } from './dtos/opening-stock.request';
import { StockOpeningService } from './stock-opening.service';

@Controller('stock')
@ApiTags('Stock')
@ApiBearerAuth(AUTH_JWT)
@UseGuards(AuthzGuard, PermissionGuard)
export class StockOpeningController {
  constructor(private readonly stockOpeningService: StockOpeningService) {}

  // Tạo hàng (product:create) kèm đưa hàng vào kho như xác nhận phiếu nhập (goods-receipt:confirm).
  @RequirePermissions('product:create', 'goods-receipt:confirm')
  @Post('opening')
  @ApiOperation({ description: 'Tồn đầu cho hàng không theo lô, một lần mỗi chi nhánh (lô KHONG-LO).' })
  @ApiResponse({ status: 400, description: '1709 đã phát sinh kho · 1602 chi nhánh không hợp lệ · 1506 ngoài phạm vi' })
  create(@Body() dto: OpeningStockRequest, @CurrentActor() actor: RequestActor) {
    return this.stockOpeningService.create(dto, actor);
  }
}
