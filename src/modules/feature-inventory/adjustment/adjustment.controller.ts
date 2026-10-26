import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { CurrentActor, type RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthzGuard } from '../../feature-auth/authz/guards/auth.guard';
import { RequirePermissions } from '../../feature-auth/permission/decorators/require-permissions.decorator';
import { PermissionGuard } from '../../feature-auth/permission/guards/permission.guard';
import { resolveBranchScope, scopedBranchFilter } from '../../feature-auth/permission/branch-scope';
import { AdjustmentService } from './adjustment.service';
import { PurchaseReturnMoneyService } from './purchase-return-money.service';
import {
  AdjustmentQuery,
  CancelAdjustmentRequest,
  CreateAdjustmentRequest,
  FavouriteAdjustmentRequest,
  UpdateAdjustmentRequest,
} from './dtos/adjustment.request';

@Controller('stock-adjustment')
@ApiTags('StockAdjustment')
@ApiBearerAuth(AUTH_JWT)
@ApiResponse({
  status: 400,
  description:
    '1002 dữ liệu dòng sai theo loại phiếu · 1600 không tồn tại · 1602 lô/NCC sai · 1700 điều chỉnh làm tồn âm hoặc dưới phần đang giữ · 1701 sai trạng thái · 1706 chi nhánh ngừng · 1708 quá 200 dòng',
})
@UseGuards(AuthzGuard, PermissionGuard)
export class AdjustmentController {
  constructor(
    private readonly adjustmentService: AdjustmentService,
    private readonly returnMoney: PurchaseReturnMoneyService,
  ) {}

  @RequirePermissions('stock-adjustment:read')
  @Get()
  @ApiOperation({ description: 'Phiếu kiểm kê / huỷ hàng / trả NCC / điều chỉnh khác.' })
  list(@Query() query: AdjustmentQuery, @CurrentActor() actor: RequestActor) {
    return this.adjustmentService.list(query, actor);
  }

  // Khai báo trước `:id`.
  @RequirePermissions('stock-adjustment:read')
  @Get('staff')
  @ApiOperation({ description: 'Nhân sự chọn làm người xuất/trả/nhận → [{id, fullName}]. PM bị ép về chi nhánh mình.' })
  staff(@Query('branchId', new ParseUUIDPipe({ optional: true })) branchId: string | undefined, @CurrentActor() actor: RequestActor) {
    return this.adjustmentService.staff(branchId, actor);
  }

  @RequirePermissions('stock-adjustment:create')
  @Get('returnable/:receiptId')
  @ApiOperation({
    description:
      'Trả NCC theo phiếu nhập: từng dòng nhập (nhập / đã trả / tồn lô / còn trả được, giá vốn đã phân bổ) + chi phí NCC còn hoàn được.',
  })
  returnable(@Param('receiptId', new ParseUUIDPipe()) receiptId: string, @CurrentActor() actor: RequestActor) {
    return this.returnMoney.returnable(receiptId, scopedBranchFilter(resolveBranchScope(actor.user), undefined));
  }

  @RequirePermissions('stock-adjustment:read')
  @Get(':id/warnings')
  @ApiOperation({ description: 'Phiếu kiểm kê: {newLots, movedLots} — lô mới tạo sau lúc lập, lô đã đổi tồn so với số chụp.' })
  warnings(@Param('id', new ParseUUIDPipe()) id: string, @CurrentActor() actor: RequestActor) {
    return this.adjustmentService.stockTakeWarnings(id, actor);
  }

  @RequirePermissions('stock-adjustment:read')
  @Post(':id/favourite')
  @ApiOperation({ description: 'Bật/tắt sao của phiếu (cờ chung) → {isFavourite}.' })
  favourite(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: FavouriteAdjustmentRequest,
    @CurrentActor() actor: RequestActor,
  ) {
    return this.adjustmentService.setFavourite(id, dto.isFavourite, actor);
  }

  @RequirePermissions('stock-adjustment:read')
  @Get(':id')
  @ApiOperation({ description: 'Chi tiết phiếu: số sổ sách, số thực đếm, chênh lệch, giá vốn từng dòng.' })
  detail(@Param('id', new ParseUUIDPipe()) id: string, @CurrentActor() actor: RequestActor) {
    return this.adjustmentService.getDetail(id, actor);
  }

  @RequirePermissions('stock-adjustment:create')
  @Post()
  @ApiOperation({
    description:
      'Lập phiếu NHÁP (chốt sổ sách lúc lập). Kiểm kê gửi actualQuantity; huỷ/trả NCC gửi quantity dương. 1711 lô đang có phiếu kiểm kê nháp.',
  })
  create(@Body() dto: CreateAdjustmentRequest, @CurrentActor() actor: RequestActor) {
    return this.adjustmentService.create(dto, actor);
  }

  @RequirePermissions('stock-adjustment:create')
  @Put(':id')
  @ApiOperation({ description: 'Sửa phiếu NHÁP: thay toàn bộ dòng + thông tin đầu phiếu (không đổi chi nhánh, loại). 1701 nếu không còn nháp.' })
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateAdjustmentRequest,
    @CurrentActor() actor: RequestActor,
  ) {
    return this.adjustmentService.update(id, dto, actor);
  }

  @RequirePermissions('stock-adjustment:confirm')
  @Post(':id/confirm')
  @ApiOperation({
    description: 'Xác nhận: chốt giá vốn, ghi chênh lệch đã chốt lúc lập vào sổ kho (ADJUST / DISPOSE / RETURN_OUT).',
  })
  confirm(@Param('id', new ParseUUIDPipe()) id: string, @CurrentActor() actor: RequestActor) {
    return this.adjustmentService.confirm(id, actor);
  }

  @RequirePermissions('stock-adjustment:cancel')
  @Post(':id/cancel')
  @ApiOperation({
    description:
      'Huỷ phiếu NHÁP; hoặc phiếu ĐÃ XÁC NHẬN loại xuất huỷ / trả NCC / xuất nội bộ (đảo bút toán về đúng lô, 1700 nếu thiếu tồn). Kiểm kê đã xác nhận không huỷ.',
  })
  cancel(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CancelAdjustmentRequest,
    @CurrentActor() actor: RequestActor,
  ) {
    return this.adjustmentService.cancel(id, dto, actor);
  }
}
