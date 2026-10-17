import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { CurrentActor, type RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthzGuard } from '../../feature-auth/authz/guards/auth.guard';
import { RequirePermissions } from '../../feature-auth/permission/decorators/require-permissions.decorator';
import { PermissionGuard } from '../../feature-auth/permission/guards/permission.guard';
import {
  CancelOrderRequest,
  CreatePosOrderRequest,
  OrderQuery,
  PayOrderRequest,
  PosProductQuery,
  ReplaceOrderItemsRequest,
} from './dtos/order.request';
import { OrderService } from './order.service';
import { PosProductService } from './pos-product.service';

@Controller('order')
@ApiTags('Order')
@ApiBearerAuth(AUTH_JWT)
@ApiResponse({
  status: 400,
  description:
    '1600 không tồn tại · 1601 mã giao dịch trùng · 1602 SĐT thuộc nhân viên/tài khoản khoá, chi nhánh không hợp lệ · 1700 thiếu hàng · ' +
    '1701 sai trạng thái · 1704 lô đã giữ bị khoá/hết hạn · 1706 chi nhánh ngừng · 1800 thiếu đơn thuốc · 1801 sản phẩm ngừng bán',
})
@ApiResponse({ status: 403, description: '1500 thiếu quyền · 1506 ngoài phạm vi chi nhánh' })
@UseGuards(AuthzGuard, PermissionGuard)
export class OrderController {
  constructor(
    private readonly orderService: OrderService,
    private readonly posProductService: PosProductService,
  ) {}

  @RequirePermissions('order:read')
  @Get()
  @ApiOperation({ description: 'Đơn hàng. PM/SS chỉ thấy chi nhánh mình; tìm theo mã đơn hoặc SĐT khách.' })
  list(@Query() query: OrderQuery, @CurrentActor() actor: RequestActor) {
    return this.orderService.list(query, actor);
  }

  // Khai trước `:id` để đường tĩnh không bị hiểu là id đơn.
  @RequirePermissions('order:create')
  @Get('pos-products')
  @ApiOperation({
    description:
      'Tra hàng cho màn bán tại quầy: `barcode` (quét mã — trả đúng đơn vị vừa quét ở `matchedUnitId`), `search` (gõ tên/mã), ' +
      '`categoryId` (lưới sản phẩm). Kèm lượng bán được tại chi nhánh theo từng đơn vị.',
  })
  posProducts(@Query() query: PosProductQuery, @CurrentActor() actor: RequestActor) {
    return this.posProductService.search(query, actor);
  }

  @RequirePermissions('order:read')
  @Get(':id')
  @ApiOperation({ description: 'Chi tiết đơn: dòng, lô đã giữ/đã trừ kèm giá vốn, thanh toán.' })
  detail(@Param('id', new ParseUUIDPipe()) id: string, @CurrentActor() actor: RequestActor) {
    return this.orderService.getDetail(id, actor);
  }

  @RequirePermissions('order:create')
  @Post('pos')
  @ApiOperation({ description: 'Lập đơn tại quầy (PENDING) — giữ hàng FEFO ngay, chưa trừ kho.' })
  createPos(@Body() dto: CreatePosOrderRequest, @CurrentActor() actor: RequestActor) {
    return this.orderService.createPos(dto, actor);
  }

  @RequirePermissions('order:create')
  @Put(':id/items')
  @ApiOperation({ description: 'Thay toàn bộ dòng của đơn tại quầy đang PENDING — chọn lô lại.' })
  replaceItems(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ReplaceOrderItemsRequest,
    @CurrentActor() actor: RequestActor,
  ) {
    return this.orderService.replacePosItems(id, dto, actor);
  }

  @RequirePermissions('order:pay')
  @Post(':id/pay')
  @ApiOperation({ description: 'Thu tiền một lần đủ tổng (tiền mặt/chuyển khoản) — trừ kho, đơn COMPLETED.' })
  pay(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: PayOrderRequest, @CurrentActor() actor: RequestActor) {
    return this.orderService.payPos(id, dto, actor);
  }

  @RequirePermissions('order:cancel')
  @Post(':id/cancel')
  @ApiOperation({ description: 'Huỷ đơn tại quầy đang PENDING — nhả hàng đang giữ.' })
  cancel(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CancelOrderRequest,
    @CurrentActor() actor: RequestActor,
  ) {
    return this.orderService.cancel(id, dto, actor);
  }
}
