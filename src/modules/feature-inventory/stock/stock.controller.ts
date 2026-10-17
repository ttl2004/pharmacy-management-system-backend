import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { CurrentActor, type RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthzGuard } from '../../feature-auth/authz/guards/auth.guard';
import { RequirePermissions } from '../../feature-auth/permission/decorators/require-permissions.decorator';
import { PermissionGuard } from '../../feature-auth/permission/guards/permission.guard';
import {
  LowStockQuery,
  MovementSummaryQuery,
  NearExpiryQuery,
  StockBatchQuery,
  StockMovementQuery,
  StockProductQuery,
} from './dtos/stock.query';
import { StockQueryService } from './stock-query.service';

@Controller('stock')
@ApiTags('Stock')
@ApiBearerAuth(AUTH_JWT)
@ApiResponse({ status: 403, description: '1500 thiếu quyền · 1506 lọc chi nhánh ngoài phạm vi' })
@UseGuards(AuthzGuard, PermissionGuard)
@RequirePermissions('stock:read')
export class StockController {
  constructor(private readonly stockQueryService: StockQueryService) {}

  @Get('batches')
  @ApiOperation({ description: 'Tồn theo lô, sắp theo hạn dùng gần nhất trước (FEFO). Mặc định chỉ lô còn hàng.' })
  batches(@Query() query: StockBatchQuery, @CurrentActor() actor: RequestActor) {
    return this.stockQueryService.listBatches(query, actor);
  }

  @Get('batches/:id')
  @ApiOperation({ description: 'Chi tiết một lô. Lô chi nhánh khác → 1600.' })
  batch(@Param('id', new ParseUUIDPipe()) id: string, @CurrentActor() actor: RequestActor) {
    return this.stockQueryService.getBatch(id, actor);
  }

  @Get('products')
  @ApiOperation({ description: 'Tồn gộp theo sản phẩm tại từng chi nhánh, kèm ngưỡng và cờ isLow.' })
  products(@Query() query: StockProductQuery, @CurrentActor() actor: RequestActor) {
    return this.stockQueryService.listProducts(query, actor);
  }

  @Get('movements')
  @ApiOperation({ description: 'Sổ kho, mới nhất trước. Phân trang bằng cursor (gửi lại nextCursor).' })
  movements(@Query() query: StockMovementQuery, @CurrentActor() actor: RequestActor) {
    return this.stockQueryService.listMovements(query, actor);
  }

  @Get('reports/low-stock')
  @ApiOperation({ description: 'Sản phẩm dưới ngưỡng tại một chi nhánh, thiếu nhiều nhất trước.' })
  lowStock(@Query() query: LowStockQuery, @CurrentActor() actor: RequestActor) {
    return this.stockQueryService.lowStock(query, actor);
  }

  @Get('reports/near-expiry')
  @ApiOperation({ description: 'Lô còn hàng hết hạn trong N ngày tới (gồm cả lô đã hết hạn).' })
  nearExpiry(@Query() query: NearExpiryQuery, @CurrentActor() actor: RequestActor) {
    return this.stockQueryService.nearExpiry(query, actor);
  }

  @Get('reports/movement-summary')
  @ApiOperation({ description: 'Nhập–xuất–tồn theo kỳ (ngày giờ VN), tối đa 366 ngày.' })
  movementSummary(@Query() query: MovementSummaryQuery, @CurrentActor() actor: RequestActor) {
    return this.stockQueryService.movementSummary(query, actor);
  }
}
