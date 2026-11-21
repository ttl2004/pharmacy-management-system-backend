import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { CurrentActor, type RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthzGuard } from '../../feature-auth/authz/guards/auth.guard';
import { RequirePermissions } from '../../feature-auth/permission/decorators/require-permissions.decorator';
import { PermissionGuard } from '../../feature-auth/permission/guards/permission.guard';
import {
  CancelTransferRequest, CreateTransferRequest, ReceiveTransferRequest, TransferQuery, UpdateTransferRequest,
} from './dtos/transfer.request';
import { TransferService } from './transfer.service';

@Controller('transfer')
@ApiTags('Transfer')
@ApiBearerAuth(AUTH_JWT)
@ApiResponse({
  status: 400,
  description:
    '1600 không tồn tại · 1602 lô không thuộc chi nhánh gửi · 1700 thiếu hàng · 1701 sai trạng thái · ' +
    '1703 lô nhận trùng số khác hạn · 1704 lô khoá/hết hạn · 1705 cùng chi nhánh · 1706 chi nhánh ngừng',
})
@ApiResponse({ status: 403, description: '1500 thiếu quyền · 1506 thao tác sai phía (gửi/nhận) hoặc ngoài phạm vi' })
@UseGuards(AuthzGuard, PermissionGuard)
export class TransferController {
  constructor(private readonly transferService: TransferService) {}

  @RequirePermissions('transfer:read')
  @Get()
  @ApiOperation({ description: 'Phiếu điều chuyển. PM thấy phiếu chi nhánh mình gửi hoặc nhận.' })
  list(@Query() query: TransferQuery, @CurrentActor() actor: RequestActor) {
    return this.transferService.list(query, actor);
  }

  // Khai báo trước `:id` để không bị bắt làm id.
  @RequirePermissions('transfer:create')
  @Get('destinations')
  @ApiOperation({ description: 'Mọi chi nhánh đang hoạt động {id, code, name} — nơi nhận khi lập phiếu (cả cho PM).' })
  destinations() {
    return this.transferService.destinations();
  }

  @RequirePermissions('transfer:read')
  @Get('in-transit')
  @ApiOperation({ description: 'Phiếu IN_TRANSIT (kèm dòng, lô) mà chi nhánh gửi đi hoặc sẽ nhận — hàng đi đường.' })
  inTransit(
    @Query('branchId', new ParseUUIDPipe({ optional: true })) branchId: string | undefined,
    @CurrentActor() actor: RequestActor,
  ) {
    return this.transferService.inTransit(branchId, actor);
  }

  @RequirePermissions('transfer:read')
  @Get(':id')
  @ApiOperation({ description: 'Chi tiết phiếu kèm lô gửi và lô nhận (toBatchId).' })
  detail(@Param('id', new ParseUUIDPipe()) id: string, @CurrentActor() actor: RequestActor) {
    return this.transferService.getDetail(id, actor);
  }

  @RequirePermissions('transfer:create')
  @Put(':id')
  @ApiOperation({ description: 'Sửa phiếu PENDING (phía gửi): chi nhánh nhận, ghi chú, toàn bộ dòng. 1701 nếu đã gửi/huỷ.' })
  update(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: UpdateTransferRequest, @CurrentActor() actor: RequestActor) {
    return this.transferService.update(id, dto, actor);
  }

  @RequirePermissions('transfer:create')
  @Post()
  @ApiOperation({ description: 'Lập phiếu PENDING từ chi nhánh gửi — chưa trừ kho.' })
  create(@Body() dto: CreateTransferRequest, @CurrentActor() actor: RequestActor) {
    return this.transferService.create(dto, actor);
  }

  @RequirePermissions('transfer:ship')
  @Post(':id/ship')
  @ApiOperation({ description: 'Xuất hàng: trừ kho gửi ngay (TRANSFER_OUT).' })
  ship(@Param('id', new ParseUUIDPipe()) id: string, @CurrentActor() actor: RequestActor) {
    return this.transferService.ship(id, actor);
  }

  @RequirePermissions('transfer:receive')
  @Post(':id/receive')
  @ApiOperation({
    description: 'Nhận hàng: body rỗng = nhận đủ; `lines` = số thực nhận từng dòng, nhận thiếu bắt buộc lý do. Tồn kho nhận tăng đúng số thực nhận; phần thiếu ghi hao hụt (DISPOSE) ở chi nhánh nhận theo giá chốt lúc xuất, nhật ký TRANSFER.RECEIVED_SHORT ghi tiền hao hụt (≥ 1.000.000đ hoặc ≥ 10% số gửi → mức cao).',
  })
  receive(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ReceiveTransferRequest,
    @CurrentActor() actor: RequestActor,
  ) {
    return this.transferService.receive(id, actor, dto);
  }

  @RequirePermissions('transfer:cancel')
  @Post(':id/cancel')
  @ApiOperation({
    description:
      'Huỷ. Chưa xuất (PENDING): chi nhánh gửi huỷ được. Đã xuất (IN_TRANSIT): chỉ quản trị chuỗi (ADMIN) — hoàn hàng về đúng lô gửi; chi nhánh khác → 1500.',
  })
  cancel(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CancelTransferRequest,
    @CurrentActor() actor: RequestActor,
  ) {
    return this.transferService.cancel(id, dto, actor);
  }
}
