import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';
import type { RequestContext } from 'src/common/decorators/request-context';
import { toAuditJson } from 'src/providers/audit-log/audit-diff';
import type { AuditJson } from 'src/providers/audit-log/audit-log.types';
import { SECURITY_EVENTS, type SecurityEventType } from './security-events';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USER_AGENT_MAX = 255;

export interface SecurityEventInput {
  type: SecurityEventType;
  actorId?: string | null;
  actorRoleCode?: string | null;
  sessionId?: string | null;
  context: RequestContext;
  /** Không bao giờ chứa tên đăng nhập, mật khẩu hay token. */
  metadata?: AuditJson | null;
}

/**
 * Ghi sự kiện bảo mật (đăng nhập, phiên, mật khẩu). Chỉ có đường thêm. Truyền `client` khi sự kiện phải cùng
 * transaction với thao tác; không truyền thì ghi độc lập (sự kiện thất bại — không có transaction nghiệp vụ nào).
 */
@Injectable()
export class SecurityEventService {
  constructor(private readonly prisma: PrismaService) {}

  async record(events: readonly SecurityEventInput[], client?: Prisma.TransactionClient): Promise<void> {
    if (!events.length) return;
    const data = events.map((event): Prisma.SecurityEventCreateManyInput => {
      const def = SECURITY_EVENTS[event.type];
      const { ip, userAgent, requestId } = event.context;
      return {
        type: event.type,
        outcome: def.outcome,
        severity: def.severity,
        actorId: event.actorId ?? null,
        actorRoleCode: event.actorRoleCode ?? null,
        sessionId: event.sessionId ?? null,
        ipAddress: ip,
        userAgent: userAgent?.slice(0, USER_AGENT_MAX) ?? null,
        requestId: requestId && UUID_RE.test(requestId) ? requestId : null,
        metadata: event.metadata == null ? Prisma.DbNull : (toAuditJson(event.metadata) as Prisma.InputJsonValue),
      };
    });
    await (client ?? this.prisma).securityEvent.createMany({ data });
  }
}
