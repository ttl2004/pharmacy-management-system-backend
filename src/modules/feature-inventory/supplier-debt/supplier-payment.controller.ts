import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { CurrentActor, type RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthzGuard } from '../../feature-auth/authz/guards/auth.guard';
import { RequirePermissions } from '../../feature-auth/permission/decorators/require-permissions.decorator';
import { PermissionGuard } from '../../feature-auth/permission/guards/permission.guard';
import { CancelDebtDocumentRequest, CreateSupplierPaymentRequest } from './dtos/supplier-payment.request';
import { SupplierPaymentService } from './supplier-payment.service';

@Controller('supplier-payment')
@ApiTags('SupplierPayment')
@ApiBearerAuth(AUTH_JWT)
@ApiResponse({
  status: 400,
  description:
    'Mã lỗi: 1002 dữ liệu sai · 1600 không tồn tại · 1602 phiếu nhập/NCC không hợp lệ · 1701 phiếu đã huỷ · 1714 trả vượt nợ',
})
@ApiResponse({ status: 403, description: '1500 thiếu quyền · 1506 chi nhánh ngoài phạm vi · 1507 chưa gán chi nhánh' })
@UseGuards(AuthzGuard, PermissionGuard)
export class SupplierPaymentController {
  constructor(private readonly service: SupplierPaymentService) {}

  @RequirePermissions('supplier-debt:write')
  @Post()
  @ApiOperation({
    description:
      'Lập phiếu chi (TTPN) phân bổ vào các phiếu nhập CONFIRMED còn nợ của một NCC. Sai một dòng → rollback cả phiếu.',
  })
  create(@Body() dto: CreateSupplierPaymentRequest, @CurrentActor() actor: RequestActor) {
    return this.service.create(dto, actor);
  }

  @RequirePermissions('supplier-debt:read')
  @Get(':id')
  @ApiOperation({ description: 'Chi tiết phiếu chi kèm phân bổ và `canCancel`.' })
  detail(@Param('id', new ParseUUIDPipe()) id: string, @CurrentActor() actor: RequestActor) {
    return this.service.getDetail(id, actor);
  }

  @RequirePermissions('supplier-debt:write')
  @Post(':id/cancel')
  @ApiOperation({
    description: 'Huỷ phiếu chi: hoàn lại số đã trả của từng phiếu nhập. Cần quyền trên MỌI chi nhánh liên quan (1506).',
  })
  cancel(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CancelDebtDocumentRequest,
    @CurrentActor() actor: RequestActor,
  ) {
    return this.service.cancel(id, dto, actor);
  }
}
