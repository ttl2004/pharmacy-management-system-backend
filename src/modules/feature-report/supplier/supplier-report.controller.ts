import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { CurrentActor, type RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthzGuard } from '../../feature-auth/authz/guards/auth.guard';
import { RequirePermissions } from '../../feature-auth/permission/decorators/require-permissions.decorator';
import { PermissionGuard } from '../../feature-auth/permission/guards/permission.guard';
import { SupplierReceiptsQuery } from './dtos/supplier-receipts.query';
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
      'và không thấy NCC chỉ vì nợ cũ. `byBranch`: mỗi chi nhánh trong phạm vi một dòng (kể cả 0đ), cùng các cột như totals; ' +
      'phiếu chi tính vào chi nhánh của phiếu nhập được phân bổ; tổng các dòng = totals. `topProducts` tối đa 10 theo tiền ' +
      'nhập. Cache tối đa 60 giây.',
  })
  supplier(@Query() query: SupplierReportQuery, @CurrentActor() actor: RequestActor) {
    return this.service.supplierReport(query, actor);
  }

  @RequirePermissions('report:read')
  @Get('supplier/receipts')
  @ApiOperation({
    summary: 'Danh sách phiếu nhập tạo nên báo cáo nhà cung cấp',
    description:
      'Cùng điều kiện cột "Phiếu nhập" của báo cáo NCC (CONFIRMED, chưa huỷ/xoá, confirmedAt trong kỳ giờ VN), nên `total` = số ' +
      'phiếu ở báo cáo cho cùng bộ lọc. Mới nhất trước, tối đa `limit` (mặc định 100, tối đa 500). `paidAmount` = tổng phân bổ ' +
      'phiếu chi chưa huỷ vào phiếu; `returnAmount` = Σ(tiền trả − NCC hoàn ngay) của phiếu trả NCC đã xác nhận gắn với phiếu; ' +
      '`remaining` = tiền nhập − đã trả − trả hàng. Không có quyền supplier-debt:read: `paidAmount`, `remaining` = null. Cache 60 giây.',
  })
  supplierReceipts(@Query() query: SupplierReceiptsQuery, @CurrentActor() actor: RequestActor) {
    return this.service.supplierReceipts(query, actor);
  }
}
