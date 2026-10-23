import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { CurrentActor, type RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthzGuard } from '../../feature-auth/authz/guards/auth.guard';
import { RequirePermissions } from '../../feature-auth/permission/decorators/require-permissions.decorator';
import { PermissionGuard } from '../../feature-auth/permission/guards/permission.guard';
import {
  CancelGoodsReceiptRequest,
  CreateGoodsReceiptRequest,
  UpdateGoodsReceiptRequest,
  UpdateReceiptPaymentRequest,
} from './dtos/goods-receipt.request';
import { GoodsReceiptQuery, ReceiversQuery } from './dtos/goods-receipt.query';
import { UpdateReceiptMetaRequest } from './dtos/goods-receipt-meta.request';
import { GoodsReceiptMetaService } from './goods-receipt-meta.service';
import { GoodsReceiptPaymentService } from './goods-receipt-payment.service';
import { GoodsReceiptService } from './goods-receipt.service';

@Controller('goods-receipt')
@ApiTags('GoodsReceipt')
@ApiBearerAuth(AUTH_JWT)
@ApiResponse({
  status: 400,
  description:
    'Mã lỗi: 1600 không tồn tại/ngoài phạm vi · 1602 tham chiếu sai · 1700 thiếu hàng · 1701 sai trạng thái · ' +
    '1702 lô hết hạn · 1703 trùng số lô khác hạn · 1704 lô bị khoá · 1706 chi nhánh ngừng · 1707 lô đã xuất · ' +
    '1708 quá số dòng · 1710 NCC ngừng hợp tác',
})
@ApiResponse({ status: 403, description: '1500 thiếu quyền · 1506 chi nhánh ngoài phạm vi · 1507 chưa gán chi nhánh' })
@UseGuards(AuthzGuard, PermissionGuard)
export class GoodsReceiptController {
  constructor(
    private readonly goodsReceiptService: GoodsReceiptService,
    private readonly metaService: GoodsReceiptMetaService,
    private readonly paymentService: GoodsReceiptPaymentService,
  ) {}

  @RequirePermissions('goods-receipt:read')
  @Get()
  @ApiOperation({ description: 'Danh sách phiếu nhập. PM/nhân viên chỉ thấy chi nhánh mình.' })
  list(@Query() query: GoodsReceiptQuery, @CurrentActor() actor: RequestActor) {
    return this.goodsReceiptService.list(query, actor);
  }

  @RequirePermissions('goods-receipt:read')
  @Get('receivers')
  @ApiOperation({
    description: 'Nhân sự có thể chọn làm người nhập → [{id, fullName}]. PM/nhân viên bị ép về chi nhánh mình.',
  })
  receivers(@Query() query: ReceiversQuery, @CurrentActor() actor: RequestActor) {
    return this.metaService.listReceivers(query, actor);
  }

  @RequirePermissions('goods-receipt:read')
  @Get(':id')
  @ApiOperation({ description: 'Chi tiết phiếu kèm dòng, người lập/xác nhận/huỷ.' })
  detail(@Param('id', new ParseUUIDPipe()) id: string, @CurrentActor() actor: RequestActor) {
    return this.goodsReceiptService.getDetail(id, actor);
  }

  @RequirePermissions('goods-receipt:create')
  @Post()
  @ApiOperation({ description: 'Lập phiếu nhập NHÁP — chưa động vào kho. Trả kèm `warnings` (lô cận date).' })
  create(@Body() dto: CreateGoodsReceiptRequest, @CurrentActor() actor: RequestActor) {
    return this.goodsReceiptService.create(dto, actor);
  }

  @RequirePermissions('goods-receipt:create')
  @Put(':id')
  @ApiOperation({ description: 'Thay toàn bộ phiếu NHÁP (đầu phiếu + dòng).' })
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateGoodsReceiptRequest,
    @CurrentActor() actor: RequestActor,
  ) {
    return this.goodsReceiptService.update(id, dto, actor);
  }

  @RequirePermissions('goods-receipt:confirm')
  @Post(':id/confirm')
  @ApiOperation({ description: 'Xác nhận: sinh/gộp lô, ghi sổ kho IMPORT. Bấm hai lần → lần hai 1701.' })
  confirm(@Param('id', new ParseUUIDPipe()) id: string, @CurrentActor() actor: RequestActor) {
    return this.goodsReceiptService.confirm(id, actor);
  }

  @RequirePermissions('goods-receipt:cancel')
  @Post(':id/cancel')
  @ApiOperation({ description: 'Huỷ phiếu. Phiếu đã xác nhận thì đảo bút toán nếu lô chưa xuất (1707 nếu đã xuất).' })
  cancel(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CancelGoodsReceiptRequest,
    @CurrentActor() actor: RequestActor,
  ) {
    return this.goodsReceiptService.cancel(id, dto, actor);
  }

  @RequirePermissions('goods-receipt:create')
  @Patch(':id/meta')
  @ApiOperation({
    description:
      'Sửa người nhập / ngày nhập / ghi chú của phiếu ĐÃ NHẬP. Phiếu khác trạng thái → 1701; body rỗng → 1002; ' +
      'người nhập sai chi nhánh → 1602. Không đổi tồn, giá vốn, công nợ.',
  })
  updateMeta(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateReceiptMetaRequest,
    @CurrentActor() actor: RequestActor,
  ) {
    return this.metaService.updateMeta(id, dto, actor);
  }

  @RequirePermissions('goods-receipt:confirm')
  @Patch(':id/payment')
  @ApiOperation({
    description:
      'Cập nhật tổng số đã trả NCC. Phiếu đã xác nhận: tăng = tự lập phiếu chi (nguồn RECEIPT) — cần thêm quyền ' +
      '`supplier-debt:write` và không vượt công nợ; giảm → 1002. Lịch sử thay đổi ở audit_logs.',
  })
  updatePayment(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateReceiptPaymentRequest,
    @CurrentActor() actor: RequestActor,
  ) {
    return this.paymentService.updatePayment(id, dto, actor);
  }
}
