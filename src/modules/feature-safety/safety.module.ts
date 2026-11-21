import { Module } from '@nestjs/common';
import { AuthzModule } from '../feature-auth/authz/authz.module';
import { PermissionModule } from '../feature-auth/permission/permission.module';
import { InteractionApprovalService } from './interaction-approval.service';
import { InteractionServiceClient } from './interaction-service.client';
import { SafetyCheckService } from './safety-check.service';
import { SafetyController } from './safety.controller';
import { SaleSafetyGate } from './sale-safety.gate';

/**
 * Kiểm tra an toàn khi bán: gọi service tương tác thuốc (TTT-BE) và quản lý phiếu duyệt của dược sĩ.
 * Module bán hàng chỉ dùng `SaleSafetyGate`.
 */
@Module({
  imports: [AuthzModule, PermissionModule],
  controllers: [SafetyController],
  providers: [InteractionServiceClient, SafetyCheckService, InteractionApprovalService, SaleSafetyGate],
  exports: [SaleSafetyGate],
})
export class SafetyModule {}
