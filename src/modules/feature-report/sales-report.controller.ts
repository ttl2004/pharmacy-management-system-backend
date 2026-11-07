import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { CurrentActor, type RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthzGuard } from '../feature-auth/authz/guards/auth.guard';
import { RequirePermissions } from '../feature-auth/permission/decorators/require-permissions.decorator';
import { PermissionGuard } from '../feature-auth/permission/guards/permission.guard';
import { InventoryReportQuery } from './dtos/inventory-report.query';
import { InventoryReportService } from './inventory-report.service';
import { SalesReportQuery } from './dtos/sales-report.query';
import { SalesReportService } from './sales-report.service';

@Controller('reports')
@ApiTags('Report')
@ApiBearerAuth(AUTH_JWT)
@ApiResponse({ status: 400, description: '1002 khoảng ngày sai (from > to hoặc quá 366 ngày)' })
@ApiResponse({ status: 403, description: '1500 thiếu quyền · 1506 chi nhánh ngoài phạm vi' })
@UseGuards(AuthzGuard, PermissionGuard)
export class SalesReportController {
  constructor(
    private readonly service: SalesReportService,
    private readonly inventory: InventoryReportService,
  ) {}

  @RequirePermissions('report:read')
  @Get('sales')
  @ApiOperation({
    summary: 'Báo cáo doanh thu và top sản phẩm',
    description:
      'Ngày = ngày giờ VN lúc thu tiền. Doanh thu = tiền thực giữ lại: đơn đã thu tính theo tổng đơn; đơn huỷ sau khi thu trừ ' +
      'đúng số tiền đã hoàn, vào NGÀY THU GỐC; số đơn không tính đơn đã huỷ. Top sản phẩm theo doanh thu giảm dần rồi số lượng ' +
      '(đơn vị gốc), tối đa 10; đơn huỷ trừ toàn bộ dòng. Lưu ý: huỷ hoàn MỘT PHẦN thì tổng doanh thu vẫn giữ phần không hoàn, ' +
      'còn doanh thu theo sản phẩm đã trừ hết — hai số lệch nhau đúng bằng phần không hoàn (chủ ý). `daily` đủ mọi ngày kể cả ' +
      '0đ; `byBranch` gồm mọi chi nhánh trong phạm vi, giảm dần theo doanh thu. Kết quả được cache tối đa 60 giây.',
  })
  sales(@Query() query: SalesReportQuery, @CurrentActor() actor: RequestActor) {
    return this.service.salesReport(query, actor);
  }

  @RequirePermissions('report:read')
  @Get('inventory')
  @ApiOperation({
    summary: 'Báo cáo tồn kho (ảnh chụp tại thời điểm gọi)',
    description:
      'Lô tính vào: còn tồn (> 0), chưa xoá, kể cả lô cách ly/thu hồi. Giá trị = Σ tồn × giá nhập của lô. Hạn dùng theo ngày giờ VN: ' +
      '≤ 0 ngày expired, 1–30 critical, 31–60 warning, 61–90 info, > 90 ok. `inTransitQty` = Σ số lượng (đơn vị gốc) phiếu đang ' +
      'chuyển có chi nhánh gửi HOẶC nhận trong phạm vi, mỗi dòng đếm một lần. `byBranch` gồm mọi chi nhánh trong phạm vi, kể cả 0 tồn, ' +
      'giảm dần theo giá trị. Cache tối đa 60 giây.',
  })
  inventoryReport(@Query() query: InventoryReportQuery, @CurrentActor() actor: RequestActor) {
    return this.inventory.inventoryReport(query, actor);
  }
}
