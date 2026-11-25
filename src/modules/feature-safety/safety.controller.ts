import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { CurrentActor, type RequestActor } from 'src/common/decorators/current-actor.decorator';
import { UserThrottlerGuard } from 'src/common/guards/user-throttler.guard';
import { AuthzGuard } from '../feature-auth/authz/guards/auth.guard';
import { RequirePermissions } from '../feature-auth/permission/decorators/require-permissions.decorator';
import { PermissionGuard } from '../feature-auth/permission/guards/permission.guard';
import { CreateInteractionApprovalRequest, SafetyCheckRequest } from './dtos/safety.request';
import { InteractionApprovalService } from './interaction-approval.service';
import { SafetyCheckService } from './safety-check.service';

/**
 * Tra tương tác theo IP: route công khai nên chưa có `req.user`. Cả quầy của một nhà thuốc thường chung một IP
 * và FE gọi lại mỗi lần giỏ đổi → hạn mức rộng; mỗi route đếm riêng.
 */
const PUBLIC_LOOKUP_THROTTLE = { default: { limit: 120, ttl: 60_000 } };

/**
 * Kiểm tra an toàn khi bán tại quầy: tương tác thuốc, trùng hoạt chất, dược sĩ duyệt.
 * - `safety-check`, `drug-warnings`: route CÔNG KHAI (chủ dự án yêu cầu, tạm thời) — cố ý không gắn
 *   AuthzGuard/PermissionGuard, không cần Bearer token; chỉ giới hạn số lần gọi theo IP.
 * - `interaction-approvals`: BẮT BUỘC đăng nhập + quyền `order:create` (chốt duyệt của dược sĩ).
 */
@Controller('sales')
@ApiTags('Sales safety')
@ApiResponse({
  status: 400,
  description:
    'Mã lỗi: INVALID_REFERENCE (1602), INTERACTION_SERVICE_UNAVAILABLE (1611 — lỗi đọc dữ liệu tương tác trong DB), ' +
    'INTERACTION_APPROVER_INVALID (1806)',
})
export class SafetyController {
  constructor(
    private readonly safety: SafetyCheckService,
    private readonly approvals: InteractionApprovalService,
  ) {}

  @Post('safety-check')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle(PUBLIC_LOOKUP_THROTTLE)
  @ApiResponse({ status: 429, description: 'Gọi quá 120 lần/phút từ cùng một IP' })
  @ApiOperation({
    description:
      'CÔNG KHAI, không cần đăng nhập. Kiểm tra giỏ hàng: cặp tương tác (nặng trước), trùng hoạt chất, hàng chưa ' +
      'kiểm tra được. `hasMajor` = true thì phải có dược sĩ duyệt mới thu tiền được. Dữ liệu DDInter tra ngay trong BE.',
  })
  check(@Body() dto: SafetyCheckRequest) {
    return this.safety.check(dto.productIds);
  }

  @Post('drug-warnings')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle(PUBLIC_LOOKUP_THROTTLE)
  @ApiResponse({ status: 429, description: 'Gọi quá 120 lần/phút từ cùng một IP' })
  @ApiOperation({
    description:
      'CÔNG KHAI, không cần đăng nhập. Lưu ý bệnh lý / thức ăn của từng hàng thuốc (tham khảo, không chặn bán).',
  })
  drugWarnings(@Body() dto: SafetyCheckRequest) {
    return this.safety.drugWarnings(dto.productIds);
  }

  @RequirePermissions('order:create')
  @Post('interaction-approvals')
  @HttpCode(200)
  @ApiBearerAuth(AUTH_JWT)
  @UseGuards(AuthzGuard, PermissionGuard, UserThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    description:
      'Dược sĩ duyệt tại quầy: nhập tài khoản + mật khẩu của mình kèm lý do. Người duyệt phải có quyền ' +
      '`order:approve-interaction` và phụ trách chi nhánh bán. Trả `approvalToken` (hạn 10 phút) để gửi kèm khi ' +
      'lập/sửa đơn. Không đọc được dữ liệu tương tác (1611) → phiếu "đã kiểm tra thủ công" (`manual: true`).',
  })
  approve(@Body() dto: CreateInteractionApprovalRequest, @CurrentActor() actor: RequestActor) {
    return this.approvals.approve(dto, actor);
  }
}
