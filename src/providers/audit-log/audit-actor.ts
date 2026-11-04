import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { SYSTEM_ACTOR_ID } from 'src/common/constants/app.constant';

/** Người thực hiện thao tác, chụp một lần cho cả lô entry. Không có userAgent (D6). */
export interface AuditActor {
  userId: string;
  type: 'USER' | 'SYSTEM' | 'JOB';
  roleCode: string | null;
  branchId: string | null;
  ip: string | null;
  requestId: string | null;
}

export function auditActorOf(actor: RequestActor): AuditActor {
  // Script seed/tác vụ chạy bằng tác nhân hệ thống: ghi là SYSTEM chứ không phải người dùng.
  if (actor.user.userId === SYSTEM_ACTOR_ID) return { ...systemActor(), requestId: actor.requestId };
  return {
    userId: actor.user.userId,
    type: 'USER',
    roleCode: actor.user.role ?? null,
    branchId: actor.user.branchId ?? null,
    ip: actor.ip,
    requestId: actor.requestId,
  };
}

/** Tác vụ nền (cron, job): không có request. */
export function jobActor(): AuditActor {
  return { userId: SYSTEM_ACTOR_ID, type: 'JOB', roleCode: null, branchId: null, ip: null, requestId: null };
}

/** Script seed/bảo trì chạy bằng tác nhân hệ thống (không phải job định kỳ). */
export function systemActor(): AuditActor {
  return { userId: SYSTEM_ACTOR_ID, type: 'SYSTEM', roleCode: null, branchId: null, ip: null, requestId: null };
}
