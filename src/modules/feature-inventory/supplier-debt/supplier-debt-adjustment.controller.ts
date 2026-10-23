import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { CurrentActor, type RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthzGuard } from '../../feature-auth/authz/guards/auth.guard';
import { RequirePermissions } from '../../feature-auth/permission/decorators/require-permissions.decorator';
import { PermissionGuard } from '../../feature-auth/permission/guards/permission.guard';
import { CreateSupplierDebtAdjustmentRequest } from './dtos/supplier-debt-adjustment.request';
import { CancelDebtDocumentRequest } from './dtos/supplier-payment.request';
import { SupplierDebtAdjustmentService } from './supplier-debt-adjustment.service';

@Controller('supplier-debt-adjustment')
@ApiTags('SupplierDebtAdjustment')
@ApiBearerAuth(AUTH_JWT)
@ApiResponse({
  status: 400,
  description: 'Mã lỗi: 1002 dữ liệu sai / nợ không đổi · 1600 không tồn tại · 1602 NCC không hợp lệ · 1701 đã huỷ',
})
@ApiResponse({ status: 403, description: '1500 thiếu quyền · 1506 chi nhánh ngoài phạm vi · 1507 chưa gán chi nhánh' })
@UseGuards(AuthzGuard, PermissionGuard)
export class SupplierDebtAdjustmentController {
  constructor(private readonly service: SupplierDebtAdjustmentService) {}

  @RequirePermissions('supplier-debt:write')
  @Post()
  @ApiOperation({
    description:
      'Điều chỉnh nợ NCC (DCN) về `debtAfter`. `debtBefore` = nợ của CHI NHÁNH lúc lập; `expectedDebtBefore` lệch nợ thật → 1715. Chi nhánh: nhân viên bị ép về ' +
      'chi nhánh mình, ADMIN phải gửi branchId (hợp lệ, còn hoạt động → sai 1602).',
  })
  create(@Body() dto: CreateSupplierDebtAdjustmentRequest, @CurrentActor() actor: RequestActor) {
    return this.service.create(dto, actor);
  }

  @RequirePermissions('supplier-debt:read')
  @Get(':id')
  @ApiOperation({ description: 'Chi tiết phiếu điều chỉnh. Chi nhánh của phiếu ngoài phạm vi → 1506.' })
  detail(@Param('id', new ParseUUIDPipe()) id: string, @CurrentActor() actor: RequestActor) {
    return this.service.getDetail(id, actor);
  }

  @RequirePermissions('supplier-debt:write')
  @Post(':id/cancel')
  @ApiOperation({ description: 'Huỷ phiếu điều chỉnh. Đã huỷ → 1701; chi nhánh ngoài phạm vi → 1506.' })
  cancel(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CancelDebtDocumentRequest,
    @CurrentActor() actor: RequestActor,
  ) {
    return this.service.cancel(id, dto, actor);
  }
}
