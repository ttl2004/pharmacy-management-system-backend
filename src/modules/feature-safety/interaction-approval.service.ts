import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from 'src/common/databases/prisma.service';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { AuthRole } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';
import { isInBranchScope, resolveBranchScope } from 'src/modules/feature-auth/permission/branch-scope';
import type { PermissionCode } from 'src/modules/feature-auth/permission/permission.constant';
import { PermissionService } from 'src/modules/feature-auth/permission/permission.service';
import { isStaffRole } from 'src/modules/feature-auth/permission/staff-role';
import { resolveWriteBranch } from 'src/modules/feature-inventory/core/inventory-scope';
import { badRequest } from 'src/modules/feature-inventory/core/inventory.error';
import { ApprovalTokenPayload, ApprovalTokenSigner } from './approval-token';
import type { CreateInteractionApprovalRequest } from './dtos/safety.request';
import { SafetyCheckService } from './safety-check.service';
import { safetyErrors } from './safety.error';
import type { StoredInteractionApproval } from './safety.types';

export const APPROVE_INTERACTION_PERMISSION: PermissionCode = 'order:approve-interaction';
/** Phiếu duyệt dùng được trong 10 phút — đủ để lập đơn và thu tiền ngay tại quầy. */
const APPROVAL_TTL_MS = 10 * 60 * 1000;
/** So bcrypt cả khi không có tài khoản để thời gian phản hồi không lộ username có tồn tại hay không. */
const DUMMY_HASH = '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

interface Approver {
  userId: string;
  fullName: string;
}

/** Thông tin để đối chiếu phiếu duyệt với đơn đang lập/sửa. */
export interface ApprovalContext {
  actorId: string;
  branchId: string;
  productIds: string[];
}

/**
 * Dược sĩ duyệt ngay tại quầy: nhập tài khoản + mật khẩu của mình kèm lý do → BE kiểm quyền, kiểm lại giỏ hàng, rồi cấp
 * phiếu duyệt có chữ ký. Nhân viên gửi phiếu này khi lập/sửa đơn; BE lưu nội dung duyệt vào đơn.
 */
@Injectable()
export class InteractionApprovalService {
  private readonly signer: ApprovalTokenSigner;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
    private readonly safety: SafetyCheckService,
  ) {
    this.signer = new ApprovalTokenSigner(config.getOrThrow<string>('JWT_ACCESS_SECRET'));
  }

  async approve(dto: CreateInteractionApprovalRequest, actor: RequestActor) {
    const branchId = resolveWriteBranch(resolveBranchScope(actor.user), dto.branchId);
    const approver = await this.verifyApprover(dto.username, dto.password, branchId);

    const { warningIds, warningSummaries, manual } = await this.warningsToApprove(dto.productIds);
    const payload: ApprovalTokenPayload = {
      sellerId: actor.user.userId,
      branchId,
      productIds: sortedUnique(dto.productIds),
      warningIds,
      warningSummaries,
      reason: dto.reason,
      manual,
      approverId: approver.userId,
      approverName: approver.fullName,
      expiresAt: Date.now() + APPROVAL_TTL_MS,
    };
    return {
      approvalToken: this.signer.sign(payload),
      expiresAt: new Date(payload.expiresAt).toISOString(),
      approver,
      warningIds,
      manual,
    };
  }

  /** Đọc phiếu duyệt gửi kèm đơn → nội dung lưu vào `orders.interactionOverride`. Sai/hết hạn/lệch giỏ → 1805. */
  readToken(token: string, context: ApprovalContext): StoredInteractionApproval {
    const payload = this.signer.verify(token);
    if (!payload) throw safetyErrors.approvalInvalid('sai chữ ký');
    if (payload.expiresAt < Date.now()) throw safetyErrors.approvalInvalid('đã hết hạn, nhờ dược sĩ duyệt lại');
    if (payload.sellerId !== context.actorId) throw safetyErrors.approvalInvalid('cấp cho nhân viên khác');
    if (payload.branchId !== context.branchId) throw safetyErrors.approvalInvalid('cấp cho chi nhánh khác');
    if (!sameList(payload.productIds, sortedUnique(context.productIds))) {
      throw safetyErrors.approvalInvalid('giỏ hàng đã thay đổi sau khi duyệt, nhờ dược sĩ duyệt lại');
    }
    return {
      reason: payload.reason,
      warningIds: payload.warningIds,
      warningSummaries: payload.warningSummaries,
      manual: payload.manual,
      byUserId: payload.approverId,
      byUserName: payload.approverName,
      requestedBy: payload.sellerId,
      at: new Date().toISOString(),
    };
  }

  /**
   * Cảnh báo cần duyệt = các cảnh báo nghiêm trọng hiện tại (BE tự kiểm, không tin FE gửi lên).
   * Service tương tác tắt → duyệt thủ công (dược sĩ xác nhận đã tự kiểm tra).
   */
  private async warningsToApprove(productIds: string[]) {
    try {
      const result = await this.safety.check(productIds);
      if (!result.hasMajor) throw badRequest('Giỏ hàng không có cảnh báo tương tác nghiêm trọng, không cần duyệt');
      const majors = result.warnings.filter((warning) => warning.severity === 'major');
      return { warningIds: majors.map((w) => w.id), warningSummaries: majors.map((w) => w.summary), manual: false };
    } catch (error) {
      if (error instanceof ErrorException && error.errorCode === ErrorCode.INTERACTION_SERVICE_UNAVAILABLE) {
        return { warningIds: [], warningSummaries: ['Kiểm tra thủ công: service tương tác không chạy'], manual: true };
      }
      throw error;
    }
  }

  /** Đúng mật khẩu + tài khoản nhân viên đang hoạt động + có quyền duyệt + phụ trách chi nhánh của đơn. */
  private async verifyApprover(username: string, password: string, branchId: string): Promise<Approver> {
    const credentials = await this.prisma.auth.findFirst({
      where: { username, isDeleted: false },
      select: {
        password: true,
        user: {
          select: {
            id: true,
            fullName: true,
            isDeleted: true,
            status: true,
            branchId: true,
            role: { select: { code: true } },
          },
        },
      },
    });
    const passwordOk = await bcrypt.compare(password, credentials?.password ?? DUMMY_HASH);
    const user = credentials?.user;
    if (!passwordOk || !user || user.isDeleted || user.status !== UserStatus.ACTIVE)
      throw safetyErrors.approverInvalid();

    const role = user.role.code;
    if (!isStaffRole(role)) throw safetyErrors.approverInvalid();
    if (!isInBranchScope(resolveBranchScope({ role, branchId: user.branchId }), branchId)) {
      throw safetyErrors.approverInvalid();
    }
    const allowed =
      role === String(AuthRole.SUPER_ADMIN) ||
      (await this.permissions.getGrantedCodes(role)).has(APPROVE_INTERACTION_PERMISSION);
    if (!allowed) throw safetyErrors.approverInvalid();

    return { userId: user.id, fullName: user.fullName };
  }
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
