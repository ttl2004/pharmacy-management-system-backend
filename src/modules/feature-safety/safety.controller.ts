import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { CurrentActor, type RequestActor } from 'src/common/decorators/current-actor.decorator';
import { UserThrottlerGuard } from 'src/common/guards/user-throttler.guard';
import { AuthzGuard } from '../feature-auth/authz/guards/auth.guard';
import { RequirePermissions } from '../feature-auth/permission/decorators/require-permissions.decorator';
import { PermissionGuard } from '../feature-auth/permission/guards/permission.guard';
import { CreateInteractionApprovalRequest, SafetyCheckRequest } from './dtos/safety.request';
import { InteractionApprovalService } from './interaction-approval.service';
import { SafetyCheckService } from './safety-check.service';

/** Kiểm tra an toàn khi bán tại quầy: tương tác thuốc, trùng hoạt chất, dược sĩ duyệt. */
@Controller('sales')
@ApiTags('Sales safety')
@ApiBearerAuth(AUTH_JWT)
@ApiResponse({
  status: 400,
  description:
    'Mã lỗi: INVALID_REFERENCE (1602), INTERACTION_SERVICE_UNAVAILABLE (1611), INTERACTION_APPROVER_INVALID (1806)',
})
@UseGuards(AuthzGuard, PermissionGuard)
export class SafetyController {
  constructor(
    private readonly safety: SafetyCheckService,
    private readonly approvals: InteractionApprovalService,
  ) {}

  @RequirePermissions('order:create')
  @Post('safety-check')
  @HttpCode(200)
  @ApiOperation({
    description:
      'Kiểm tra giỏ hàng: cặp tương tác (nặng trước), trùng hoạt chất, hàng chưa kiểm tra được. ' +
      '`hasMajor` = true thì phải có dược sĩ duyệt mới thu tiền được.',
  })
  check(@Body() dto: SafetyCheckRequest) {
    return this.safety.check(dto.productIds);
  }

  @RequirePermissions('order:create')
  @Post('drug-warnings')
  @HttpCode(200)
  @ApiOperation({ description: 'Lưu ý bệnh lý / thức ăn của từng hàng thuốc (tham khảo, không chặn bán).' })
  drugWarnings(@Body() dto: SafetyCheckRequest) {
    return this.safety.drugWarnings(dto.productIds);
  }

  @RequirePermissions('order:create')
  @Post('interaction-approvals')
  @HttpCode(200)
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    description:
      'Dược sĩ duyệt tại quầy: nhập tài khoản + mật khẩu của mình kèm lý do. Người duyệt phải có quyền ' +
      '`order:approve-interaction` và phụ trách chi nhánh bán. Trả `approvalToken` (hạn 10 phút) để gửi kèm khi ' +
      'lập/sửa đơn. Service tương tác tắt → phiếu "đã kiểm tra thủ công" (`manual: true`).',
  })
  approve(@Body() dto: CreateInteractionApprovalRequest, @CurrentActor() actor: RequestActor) {
    return this.approvals.approve(dto, actor);
  }
}
