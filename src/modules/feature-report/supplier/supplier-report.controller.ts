import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { CurrentActor, type RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthzGuard } from '../../feature-auth/authz/guards/auth.guard';
import { RequirePermissions } from '../../feature-auth/permission/decorators/require-permissions.decorator';
import { PermissionGuard } from '../../feature-auth/permission/guards/permission.guard';
import { SupplierReportQuery } from './dtos/supplier-report.query';
import { SupplierReportService } from './supplier-report.service';

@Controller('reports')
@ApiTags('Report')
@ApiBearerAuth(AUTH_JWT)
@ApiResponse({ status: 400, description: '1002 tham số sai (from > to hoặc quá 366 ngày)' })
@ApiResponse({ status: 403, description: '1500 thiếu quyền · 1506 chi nhánh ngoài phạm vi' })
@UseGuards(AuthzGuard, PermissionGuard)
export class SupplierReportController {
  constructor(private readonly service: SupplierReportService) {}

  @RequirePermissions('report:read')
  @Get('supplier')
  @ApiOperation({
    summary: 'Báo cáo nhà cung cấp (nhập, trả, chi, nợ đầu/cuối kỳ)',
    description:
      'Ngày = ngày giờ VN. Nợ cuối kỳ = nợ đầu kỳ + nhập − trả (phần NCC chưa hoàn) − chi + điều chỉnh, cùng công thức sổ nợ NCC; ' +
      'chứng từ đã huỷ/xoá tính 0. NCC hiện nếu có phát sinh trong kỳ hoặc nợ đầu kỳ khác 0, giảm dần theo tiền nhập. ' +
      'Người không có quyền supplier-debt:read nhận null ở openingDebt, closingDebt, paidAmount, adjustmentAmount (cả totals) ' +
      'và không thấy NCC chỉ vì nợ cũ. `topProducts` tối đa 10 theo tiền nhập. Cache tối đa 60 giây.',
  })
  supplier(@Query() query: SupplierReportQuery, @CurrentActor() actor: RequestActor) {
    return this.service.supplierReport(query, actor);
  }
}
