import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { CurrentActor, type RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthzGuard } from '../../feature-auth/authz/guards/auth.guard';
import { RequirePermissions } from '../../feature-auth/permission/decorators/require-permissions.decorator';
import { PermissionGuard } from '../../feature-auth/permission/guards/permission.guard';
import { LedgerQuery, OpenReceiptsQuery } from './dtos/supplier-debt.query';
import { SupplierDebtLedgerService } from './supplier-debt-ledger.service';

@Controller('supplier-debt')
@ApiTags('SupplierDebt')
@ApiBearerAuth(AUTH_JWT)
@ApiResponse({ status: 400, description: 'Mã lỗi: 1600 không tồn tại/ngoài phạm vi' })
@ApiResponse({ status: 403, description: '1500 thiếu quyền · 1507 chưa gán chi nhánh' })
@UseGuards(AuthzGuard, PermissionGuard)
export class SupplierDebtController {
  constructor(private readonly service: SupplierDebtLedgerService) {}

  @RequirePermissions('supplier-debt:read')
  @Get(':supplierId/ledger')
  @ApiOperation({
    description:
      'Sổ nợ NCC, mới nhất trước. Dòng điều chỉnh chỉ gồm điều chỉnh của chi nhánh trong phạm vi. `balanceAfter` cộng dồn, dòng huỷ không đổi số dư.',
  })
  ledger(
    @Param('supplierId', new ParseUUIDPipe()) supplierId: string,
    @Query() query: LedgerQuery,
    @CurrentActor() actor: RequestActor,
  ) {
    return this.service.ledger(supplierId, query, actor);
  }

  @RequirePermissions('supplier-debt:write')
  @Get(':supplierId/open-receipts')
  @ApiOperation({
    description:
      'Phiếu nhập còn nợ (cũ trước) + `payCap` mức trả tối đa + `debt` nợ của chi nhánh trong phạm vi (đã gồm điều chỉnh của chi nhánh) — dữ liệu cho dialog thanh toán/điều chỉnh.',
  })
  openReceipts(
    @Param('supplierId', new ParseUUIDPipe()) supplierId: string,
    @Query() query: OpenReceiptsQuery,
    @CurrentActor() actor: RequestActor,
  ) {
    return this.service.openReceipts(supplierId, query, actor);
  }

  @RequirePermissions('supplier-debt:read')
  @Get('receipts/:receiptId/payments')
  @ApiOperation({ description: 'Từng lần trả của một phiếu nhập (phần phân bổ), kể cả phiếu chi đã huỷ.' })
  receiptPayments(@Param('receiptId', new ParseUUIDPipe()) receiptId: string, @CurrentActor() actor: RequestActor) {
    return this.service.receiptPayments(receiptId, actor);
  }
}
