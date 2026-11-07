import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { CurrentActor, type RequestActor } from 'src/common/decorators/current-actor.decorator';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';
import { daysBetweenDateOnly, todayInVietnam } from 'src/common/utils/date-only.util';
import { AuthzGuard } from '../feature-auth/authz/guards/auth.guard';
import { RequirePermissions } from '../feature-auth/permission/decorators/require-permissions.decorator';
import { PermissionGuard } from '../feature-auth/permission/guards/permission.guard';
import { ReconcileRequest, ReconcileRunsQuery } from './dtos/reconcile.request';
import { ReconcileRunsService } from './reconcile-runs.service';
import { ReconcileService } from './reconcile.service';

export const RECONCILE_MAX_DAYS = 31;

@Controller('reports')
@ApiTags('Report')
@ApiBearerAuth(AUTH_JWT)
@ApiResponse({ status: 403, description: '1500 thiếu quyền report:reconcile' })
@UseGuards(AuthzGuard, PermissionGuard)
export class ReconcileRunsController {
  constructor(
    private readonly reconcile: ReconcileService,
    private readonly runs: ReconcileRunsService,
  ) {}

  @RequirePermissions('report:reconcile')
  @Get('reconcile-runs')
  @ApiOperation({
    summary: 'Nhật ký đối soát doanh thu (mới nhất trước)',
    description:
      'Phân trang page/limit; lọc `status` (RUNNING | SUCCESS | FAILED) và `hasMismatch`. Danh sách không kèm `mismatches`.',
  })
  list(@Query() query: ReconcileRunsQuery) {
    return this.runs.list(query);
  }

  @RequirePermissions('report:reconcile')
  @Get('reconcile-runs/:id')
  @ApiOperation({ summary: 'Chi tiết một lần đối soát, đủ `mismatches` (tối đa 100 phần tử)' })
  @ApiResponse({ status: 404, description: '1600 không tìm thấy' })
  detail(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.runs.detail(id);
  }

  @RequirePermissions('report:reconcile')
  @Post('reconcile')
  @ApiOperation({
    summary: 'Chạy đối soát doanh thu ngay (đồng bộ)',
    description:
      'Dựng lại tổng hợp cho [fromDate, toDate] từ đơn gốc và báo các dòng đang lệch. Tối đa 31 ngày, toDate không quá hôm nay. ' +
      'Trả bản ghi lần chạy (có thể status FAILED kèm errorMessage). 400 "Đối soát đang chạy" nếu lần khác chưa xong.',
  })
  @ApiResponse({ status: 400, description: '1002 khoảng ngày sai / Đối soát đang chạy' })
  async trigger(@Body() body: ReconcileRequest, @CurrentActor() actor: RequestActor) {
    const { fromDate, toDate } = body;
    if (fromDate > toDate) {
      throw new ErrorException({ code: ErrorCode.HTTP_BAD_REQUEST, message: 'fromDate phải trước hoặc bằng toDate' });
    }
    if (toDate > todayInVietnam()) {
      throw new ErrorException({ code: ErrorCode.HTTP_BAD_REQUEST, message: 'toDate không được ở tương lai' });
    }
    if (daysBetweenDateOnly(fromDate, toDate) + 1 > RECONCILE_MAX_DAYS) {
      throw new ErrorException({
        code: ErrorCode.HTTP_BAD_REQUEST,
        message: `Khoảng đối soát tối đa ${RECONCILE_MAX_DAYS} ngày`,
      });
    }
    return this.reconcile.run('MANUAL', actor, fromDate, toDate);
  }
}
