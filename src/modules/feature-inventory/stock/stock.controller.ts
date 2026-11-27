import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { CurrentActor, type RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthzGuard } from '../../feature-auth/authz/guards/auth.guard';
import { RequirePermissions } from '../../feature-auth/permission/decorators/require-permissions.decorator';
import { PermissionGuard } from '../../feature-auth/permission/guards/permission.guard';
import {
  ExpirySummaryQuery,
  LowStockQuery,
  MovementSummaryQuery,
  NearExpiryQuery,
  StockBatchQuery,
  StockMovementQuery,
  StockProductQuery,
} from './dtos/stock.query';
import { StockQueryService } from './stock-query.service';
import { BranchProductListService } from './branch-product-list.service';
import { BranchProductListQuery } from './dtos/branch-product-list.query';
import { BRANCH_PRODUCT_CHAIN_EXAMPLE, BRANCH_PRODUCT_LIST_EXAMPLE } from './dtos/branch-product-list.response';

@Controller('stock')
@ApiTags('Stock')
@ApiBearerAuth(AUTH_JWT)
@ApiResponse({ status: 403, description: '1500 thiếu quyền · 1506 lọc chi nhánh ngoài phạm vi' })
@UseGuards(AuthzGuard, PermissionGuard)
@RequirePermissions('stock:read')
export class StockController {
  constructor(
    private readonly stockQueryService: StockQueryService,
    private readonly branchProductList: BranchProductListService,
  ) {}

  @Get('branch-products')
  @RequirePermissions('stock:read', 'product:read')
  @ApiOperation({
    summary: 'Hàng hoá chi nhánh (lọc/sắp xếp/phân trang ở BE)',
    description: [
      'Chỉ hàng ĐÃ TỪNG CÓ LÔ (lô chưa xoá) trong phạm vi, kể cả tồn 0. Mỗi dòng = trường sản phẩm (như `GET /product`',
      'với bộ lọc mới: đơn vị bán, vị trí, thuốc liên kết…) + `qtyOnHand`, `sellable`, `avgCost`, `lastPurchaseCost`,',
      '`soldLast30Days`, `stockoutDate`, `nearestExpiry`, `minStock`, `maxStock`, `branches`.',
      '',
      '- **Chi nhánh** (gửi `branchId`, hoặc PM/nhân viên): số liệu của chi nhánh; `branches` = null.',
      '- **Toàn chuỗi** (ADMIN/SUPER_ADMIN không gửi `branchId`): mỗi hàng một dòng, tồn cộng cả chuỗi, giá vốn bình quân',
      '  gia quyền theo tồn AVAILABLE cả chuỗi, giá nhập cuối = phiếu CONFIRMED mới nhất cả chuỗi; `minStock`/`maxStock` = null;',
      '  `branches` = từng chi nhánh có lô (xếp theo mã chi nhánh).',
      '',
      'Giá vốn = bình quân giá nhập lô AVAILABLE còn tồn; giá nhập cuối = (đơn giá − giảm giá)/hệ số của dòng phiếu nhập',
      'CONFIRMED mới nhất — CÙNG định nghĩa với Thiết lập giá, theo đơn vị gốc, làm tròn đồng. Không được xem giá vốn',
      '(thiếu goods-receipt:create và price-book:update) → hai giá = null, sắp xếp theo hai cột đó bị bỏ qua.',
      'Dự kiến hết hàng = hôm nay + floor(tồn × 30 / lượng bán ròng 30 ngày gần nhất); null khi tồn ≤ 0 hoặc không bán.',
      '`summary.totalQtyOnHand` = tổng tồn của TOÀN BỘ kết quả lọc (không chỉ trang).',
    ].join('\n'),
  })
  @ApiOkResponse({
    description: 'Trang hàng hoá chi nhánh. Ví dụ ở chế độ chi nhánh; chế độ toàn chuỗi xem `x-chain-example`.',
    schema: { example: BRANCH_PRODUCT_LIST_EXAMPLE, 'x-chain-example': BRANCH_PRODUCT_CHAIN_EXAMPLE } as object,
  })
  @ApiResponse({ status: 400, description: '1002/400 tham số không hợp lệ (enum, uuid, ngày YYYY-MM-DD, page/limit)' })
  branchProducts(@Query() query: BranchProductListQuery, @CurrentActor() actor: RequestActor) {
    return this.branchProductList.list(query, actor);
  }

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
  @ApiOperation({
    description:
      'Sổ kho, mới nhất trước. Phân trang bằng cursor (gửi lại nextCursor). Mỗi dòng có balanceAfter (tồn của riêng lô sau bút toán) và productBalanceAfter (tồn thuốc của chi nhánh, cộng mọi lô, ngay sau bút toán — tính cùng ảnh chụp dữ liệu với trang, kể cả khi lọc theo lô/loại/chứng từ).',
  })
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

  @Get('reports/expiry-summary')
  @ApiOperation({
    description:
      'Số lô còn tồn đã hết hạn / cận hạn (còn 1..days ngày), tổng và từng chi nhánh (byBranch, chỉ chi nhánh có lô). ADMIN bỏ trống branchId = toàn chuỗi.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        days: 30,
        expired: 3,
        expiring: 5,
        byBranch: [{ branchId: 'uuid', branchCode: 'CN001', branchName: 'Chi nhánh 1', expired: 3, expiring: 5 }],
      },
    },
  })
  expirySummary(@Query() query: ExpirySummaryQuery, @CurrentActor() actor: RequestActor) {
    return this.stockQueryService.expirySummary(query, actor);
  }

  @Get('reports/movement-summary')
  @ApiOperation({ description: 'Nhập–xuất–tồn theo kỳ (ngày giờ VN), tối đa 366 ngày.' })
  movementSummary(@Query() query: MovementSummaryQuery, @CurrentActor() actor: RequestActor) {
    return this.stockQueryService.movementSummary(query, actor);
  }
}
