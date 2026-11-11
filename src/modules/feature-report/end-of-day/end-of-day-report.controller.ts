import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { CurrentActor, type RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthzGuard } from '../../feature-auth/authz/guards/auth.guard';
import { RequirePermissions } from '../../feature-auth/permission/decorators/require-permissions.decorator';
import { PermissionGuard } from '../../feature-auth/permission/guards/permission.guard';
import { EndOfDayReportQuery } from './dtos/end-of-day-report.query';
import { EndOfDayReportService } from './end-of-day-report.service';

@Controller('reports/end-of-day')
@ApiTags('Report')
@ApiBearerAuth(AUTH_JWT)
@ApiResponse({ status: 400, description: '1002 ngày sai định dạng hoặc ở tương lai' })
@ApiResponse({ status: 403, description: '1500 thiếu quyền · 1506 chi nhánh ngoài phạm vi' })
@UseGuards(AuthzGuard, PermissionGuard)
export class EndOfDayReportController {
  constructor(private readonly service: EndOfDayReportService) {}

  @RequirePermissions('report:read')
  @Get()
  @ApiOperation({
    summary: 'Báo cáo cuối ngày (chốt két)',
    description:
      'DÒNG TIỀN theo ngày tiền đi/đến (giờ VN), KHÁC báo cáo doanh thu: doanh thu trừ tiền hoàn về NGÀY THU GỐC, còn báo cáo này ' +
      'trừ tiền hoàn vào ngày hoàn thực tế (kể cả hoàn cho đơn thu hôm trước). `sales.grossAmount`/`refundAmount` = Σ thanh toán ' +
      'thành công (PAYMENT/REFUND) có paidAt trong ngày; `byMethod` luôn đủ CASH, BANK_TRANSFER, CARD (`net` của CASH = tiền mặt ' +
      'két phải tăng). `orderCount` = đơn thu trong ngày còn COMPLETED; `cancelledCount` = đơn huỷ trong ngày đã từng thu. ' +
      '`supplier`: phiếu nhập xác nhận và phiếu chi NCC (chưa huỷ, theo paidAt) trong ngày, lọc theo chi nhánh của phiếu. ' +
      '`topProducts` ≤ 10 theo tiền của đơn thu trong ngày còn COMPLETED. `byStaff` theo nhân viên lập đơn (ròng = thu − hoàn ' +
      'của các payment trong ngày gắn với đơn của họ), giảm dần theo ròng; đơn không gán nhân viên không vào mục này. ' +
      'Cache tối đa 60 giây.',
  })
  endOfDay(@Query() query: EndOfDayReportQuery, @CurrentActor() actor: RequestActor) {
    return this.service.endOfDay(query, actor);
  }
}
