import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { CurrentActor, type RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthzGuard } from '../../feature-auth/authz/guards/auth.guard';
import { RequirePermissions } from '../../feature-auth/permission/decorators/require-permissions.decorator';
import { PermissionGuard } from '../../feature-auth/permission/guards/permission.guard';
import { StaffReportQuery } from './dtos/staff-report.query';
import { StaffReportService } from './staff-report.service';

@Controller('reports')
@ApiTags('Report')
@ApiBearerAuth(AUTH_JWT)
@ApiResponse({ status: 400, description: '1002 khoảng ngày sai (from > to hoặc quá 92 ngày)' })
@ApiResponse({ status: 403, description: '1500 thiếu quyền · 1506 chi nhánh ngoài phạm vi' })
@UseGuards(AuthzGuard, PermissionGuard)
export class StaffReportController {
  constructor(private readonly service: StaffReportService) {}

  @RequirePermissions('report:read')
  @Get('staff')
  @ApiOperation({
    summary: 'Báo cáo theo nhân viên',
    description:
      'Tập đơn: `completedAt` (giờ VN) trong khoảng, chưa xoá, gộp theo nhân viên lập đơn; đơn không có nhân viên bị bỏ. ' +
      '`orderCount` = đơn COMPLETED; `cancelledCount` = đơn huỷ sau khi thu; `refundAmount` = tổng tiền hoàn của các đơn trong tập ' +
      '(gán về đơn gốc, bất kể ngày hoàn). `revenue` = tiền thực giữ lại (đơn COMPLETED tính tổng đơn, đơn huỷ tính tổng − hoàn), ' +
      'khớp doanh thu của /reports/sales. `cogs` = giá vốn các đơn COMPLETED, `grossProfit` = revenue − cogs. `branchName` là ' +
      'chi nhánh của nhân viên (null với ADMIN). Sắp theo revenue giảm dần. Cache tối đa 60 giây.',
  })
  staffReport(@Query() query: StaffReportQuery, @CurrentActor() actor: RequestActor) {
    return this.service.staffReport(query, actor);
  }
}
