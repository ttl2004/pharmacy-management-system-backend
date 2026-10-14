import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { CurrentActor, type RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthzGuard } from '../../feature-auth/authz/guards/auth.guard';
import { RequirePermissions } from '../../feature-auth/permission/decorators/require-permissions.decorator';
import { PermissionGuard } from '../../feature-auth/permission/guards/permission.guard';
import { CancelTransferRequest, CreateTransferRequest, TransferQuery } from './dtos/transfer.request';
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

  @RequirePermissions('transfer:read')
  @Get(':id')
  @ApiOperation({ description: 'Chi tiết phiếu kèm lô gửi và lô nhận (toBatchId).' })
  detail(@Param('id', new ParseUUIDPipe()) id: string, @CurrentActor() actor: RequestActor) {
    return this.transferService.getDetail(id, actor);
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
  @ApiOperation({ description: 'Nhận đủ hàng (không hỗ trợ nhận thiếu): cộng kho nhận (TRANSFER_IN).' })
  receive(@Param('id', new ParseUUIDPipe()) id: string, @CurrentActor() actor: RequestActor) {
    return this.transferService.receive(id, actor);
  }

  @RequirePermissions('transfer:cancel')
  @Post(':id/cancel')
  @ApiOperation({ description: 'Huỷ. Đang trên đường thì hoàn hàng về đúng lô gửi.' })
  cancel(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CancelTransferRequest,
    @CurrentActor() actor: RequestActor,
  ) {
    return this.transferService.cancel(id, dto, actor);
  }
}
