import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';
import { ApprovalContext, InteractionApprovalService } from './interaction-approval.service';
import { SafetyCheckService } from './safety-check.service';
import { safetyErrors } from './safety.error';
import type { StoredInteractionApproval } from './safety.types';

/** Kết quả kiểm tra giỏ trước khi thu tiền. `available = false`: không tra được dữ liệu tương tác (1611). */
export type PayPrecheck =
  | { available: true; productIds: string[]; majorWarningIds: string[]; majorSummaries: string[] }
  | { available: false; productIds: string[] };

/**
 * Chốt chặn an toàn của luồng bán hàng — OrderService chỉ gọi qua đây:
 * 1. Lập/sửa đơn: đọc phiếu duyệt (nếu có) thành nội dung lưu vào đơn.
 * 2. Thu tiền: `precheck` (tra tương tác, NGOÀI transaction) rồi `assertPayAllowed` (trong transaction).
 */
@Injectable()
export class SaleSafetyGate {
  constructor(
    private readonly safety: SafetyCheckService,
    private readonly approvals: InteractionApprovalService,
  ) {}

  /** Giá trị cột `interactionOverride` khi lập/sửa đơn. Không gửi phiếu → null (sửa đơn thì xoá bản duyệt cũ). */
  approvalForOrder(token: string | undefined, context: ApprovalContext): Prisma.InputJsonValue | null {
    if (!token) return null;
    return this.approvals.readToken(token, context) as unknown as Prisma.InputJsonValue;
  }

  async precheck(productIds: string[]): Promise<PayPrecheck> {
    try {
      const result = await this.safety.check(productIds);
      const majors = result.warnings.filter((warning) => warning.severity === 'major');
      return {
        available: true,
        productIds,
        majorWarningIds: majors.map((w) => w.id),
        majorSummaries: majors.map((w) => w.summary),
      };
    } catch (error) {
      if (error instanceof ErrorException && error.errorCode === ErrorCode.INTERACTION_SERVICE_UNAVAILABLE) {
        return { available: false, productIds };
      }
      throw error;
    }
  }

  /**
   * Mọi cảnh báo nghiêm trọng hiện tại phải nằm trong bản duyệt của đơn. Service tắt → chỉ cho thu khi dược sĩ đã
   * xác nhận kiểm tra thủ công. Thiếu → 1804.
   */
  assertPayAllowed(precheck: PayPrecheck, stored: unknown): void {
    const approval = toApproval(stored);
    if (!precheck.available) {
      if (!approval?.manual && !approval?.warningIds.length) throw safetyErrors.manualCheckRequired();
      return;
    }
    const approved = new Set(approval?.warningIds ?? []);
    const missing = precheck.majorWarningIds
      .map((id, index) => ({ id, summary: precheck.majorSummaries[index] }))
      .filter((warning) => !approved.has(warning.id));
    if (missing.length) throw safetyErrors.approvalRequired(missing.map((warning) => warning.summary));
  }
}

function toApproval(value: unknown): StoredInteractionApproval | null {
  if (!value || typeof value !== 'object' || !Array.isArray((value as StoredInteractionApproval).warningIds)) {
    return null;
  }
  return value as StoredInteractionApproval;
}
