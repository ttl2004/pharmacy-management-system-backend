import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';
import { foldVn } from 'src/common/utils/vn-fold.util';
import type { AuditActor } from './audit-actor';
import { toAuditJson } from './audit-diff';
import { AUDIT_EVENTS } from './audit-events';
import type { AuditEntry, AuditJson } from './audit-log.types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEARCH_TEXT_MAX = 500;

function jsonOrNull(value: AuditJson | null | undefined): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value == null ? Prisma.DbNull : (toAuditJson(value) as Prisma.InputJsonValue);
}

/**
 * Ghi nhật ký thao tác. Chỉ có đường **thêm**: không API sửa/xoá, repository không có hàm update/delete.
 *
 * Luôn nhận `tx` của transaction nghiệp vụ và ghi chung một transaction — thao tác rollback thì log cũng mất,
 * không bao giờ có thao tác đã commit mà thiếu log. Một câu `createMany` cho cả lô entry, nên số câu lệnh
 * không tăng theo số dòng chứng từ (mỗi câu ~100 ms qua pooler).
 *
 * `action`, `severity` suy từ danh mục sự kiện; actor chụp một lần cho cả lô.
 *
 * Về sau đẩy log sang hệ thống riêng (ELK, RabbitMQ): giữ nguyên chữ ký `record`, chỉ đổi phần thân.
 */
@Injectable()
export class AuditLogService {
  async record(tx: Prisma.TransactionClient, actor: AuditActor, entries: readonly AuditEntry[]): Promise<void> {
    if (!entries.length) return;

    const requestId = actor.requestId && UUID_RE.test(actor.requestId) ? actor.requestId : null;

    const data = entries.map((entry): Prisma.AuditLogCreateManyInput => {
      const def = AUDIT_EVENTS[entry.event];
      const reason = entry.reason?.trim() ? entry.reason : null;
      if (def.reasonRequired && !reason) {
        throw new ErrorException({
          code: ErrorCode.HTTP_BAD_REQUEST,
          message: `Thiếu lý do cho thao tác ${entry.event}`,
        });
      }

      return {
        event: entry.event,
        action: def.action,
        severity: Math.max(def.severity, entry.severity ?? 0),
        actorId: actor.userId,
        actorType: actor.type,
        actorRoleCode: actor.roleCode,
        actorBranchId: actor.branchId,
        ipAddress: actor.ip,
        requestId,
        entityType: entry.entityType,
        entityId: entry.entityId,
        entityLabel: entry.entityLabel ?? null,
        branchIds: [...entry.branchIds],
        branchId: entry.branchIds.length === 1 ? entry.branchIds[0] : null,
        before: jsonOrNull(entry.before),
        after: jsonOrNull(entry.after),
        metadata: jsonOrNull(entry.metadata),
        amount: entry.amount ?? null,
        reason,
        searchText: foldVn([entry.entityLabel, reason, ...(entry.searchTerms ?? [])].filter(Boolean).join(' ')).slice(
          0,
          SEARCH_TEXT_MAX,
        ),
      };
    });

    await tx.auditLog.createMany({ data });
  }
}
