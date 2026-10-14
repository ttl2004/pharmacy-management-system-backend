import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { CurrentActor, type RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthzGuard } from '../../feature-auth/authz/guards/auth.guard';
import { RequirePermissions } from '../../feature-auth/permission/decorators/require-permissions.decorator';
import { PermissionGuard } from '../../feature-auth/permission/guards/permission.guard';
import { AdjustmentService } from './adjustment.service';
import { AdjustmentQuery, CancelAdjustmentRequest, CreateAdjustmentRequest } from './dtos/adjustment.request';

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
  constructor(private readonly adjustmentService: AdjustmentService) {}

  @RequirePermissions('stock-adjustment:read')
  @Get()
  @ApiOperation({ description: 'Phiếu kiểm kê / huỷ hàng / trả NCC / điều chỉnh khác.' })
  list(@Query() query: AdjustmentQuery, @CurrentActor() actor: RequestActor) {
    return this.adjustmentService.list(query, actor);
  }

  @RequirePermissions('stock-adjustment:read')
  @Get(':id')
  @ApiOperation({ description: 'Chi tiết phiếu: số sổ sách, số thực đếm, chênh lệch, giá vốn từng dòng.' })
  detail(@Param('id', new ParseUUIDPipe()) id: string, @CurrentActor() actor: RequestActor) {
    return this.adjustmentService.getDetail(id, actor);
  }

  @RequirePermissions('stock-adjustment:create')
  @Post()
  @ApiOperation({ description: 'Lập phiếu NHÁP. Kiểm kê gửi actualQuantity; huỷ/trả NCC gửi quantity dương.' })
  create(@Body() dto: CreateAdjustmentRequest, @CurrentActor() actor: RequestActor) {
    return this.adjustmentService.create(dto, actor);
  }

  @RequirePermissions('stock-adjustment:confirm')
  @Post(':id/confirm')
  @ApiOperation({ description: 'Xác nhận: chốt số sổ sách và ghi sổ kho (ADJUST / DISPOSE / RETURN_OUT).' })
  confirm(@Param('id', new ParseUUIDPipe()) id: string, @CurrentActor() actor: RequestActor) {
    return this.adjustmentService.confirm(id, actor);
  }

  @RequirePermissions('stock-adjustment:cancel')
  @Post(':id/cancel')
  @ApiOperation({ description: 'Huỷ phiếu NHÁP. Phiếu đã xác nhận không huỷ — lập phiếu bù.' })
  cancel(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CancelAdjustmentRequest,
    @CurrentActor() actor: RequestActor,
  ) {
    return this.adjustmentService.cancel(id, dto, actor);
  }
}
