import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { PrismaService } from 'src/common/databases/prisma.service';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { AuthRole } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';
import { addDaysToDateOnly, daysBetweenDateOnly, vietnamDayStartUtc } from 'src/common/utils/date-only.util';
import { afterCursorDesc, decodeCursor, toKeysetPage } from 'src/common/utils/keyset-cursor';
import { SecurityEventQuery } from './dtos/security-event.query';

const MAX_DAYS = 90;

/** Không có `userAgent` ra API (cùng nguyên tắc D6 với nhật ký thao tác). */
const EVENT_SELECT = {
  id: true,
  createdAt: true,
  type: true,
  outcome: true,
  severity: true,
  actorId: true,
  actorRoleCode: true,
  sessionId: true,
  ipAddress: true,
  requestId: true,
  metadata: true,
} satisfies Prisma.SecurityEventSelect;

function badRequest(message: string) {
  return new ErrorException({ code: ErrorCode.HTTP_BAD_REQUEST, message });
}

/** Đọc `security_events` (B.6): chỉ ADMIN/SUPER_ADMIN; ADMIN không thấy dòng của SUPER_ADMIN. Không có hàm ghi. */
@Injectable()
export class SecurityEventQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: SecurityEventQuery, actor: RequestActor) {
    if (query.fromDate && query.toDate) {
      if (query.fromDate > query.toDate) throw badRequest('fromDate phải trước hoặc bằng toDate');
      if (daysBetweenDateOnly(query.fromDate, query.toDate) + 1 > MAX_DAYS) {
        throw badRequest(`Khoảng ngày tối đa ${MAX_DAYS} ngày`);
      }
    }
    const and: Prisma.SecurityEventWhereInput[] = [];
    if (actor.user.role !== AuthRole.SUPER_ADMIN) {
      and.push({ OR: [{ actorRoleCode: null }, { actorRoleCode: { not: AuthRole.SUPER_ADMIN } }] });
    }
    if (query.type?.length) and.push({ type: { in: query.type } });
    if (query.outcome) and.push({ outcome: query.outcome });
    if (query.actorId) and.push({ actorId: query.actorId });
    if (query.ip) and.push({ ipAddress: query.ip });
    if (query.fromDate) and.push({ createdAt: { gte: vietnamDayStartUtc(query.fromDate) } });
    if (query.toDate) and.push({ createdAt: { lt: vietnamDayStartUtc(addDaysToDateOnly(query.toDate, 1)) } });
    if (query.cursor) and.push(afterCursorDesc(decodeCursor(query.cursor)));

    const rows = await this.prisma.securityEvent.findMany({
      where: { AND: and },
      select: EVENT_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const page = toKeysetPage(rows, query.limit);
    return { ...page, items: await this.present(page.items) };
  }

  /** `actorId` không có FK nên tên người dùng tra riêng, một câu cho cả trang. */
  private async present<T extends { actorId: string | null; requestId: string | null }>(items: T[]) {
    const ids = [...new Set(items.map((r) => r.actorId).filter((id): id is string => !!id))];
    const users = ids.length
      ? await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true } })
      : [];
    const names = new Map(users.map((u) => [u.id, u.fullName]));
    return items.map((row) => ({
      ...row,
      actor: row.actorId ? { id: row.actorId, fullName: names.get(row.actorId) ?? null } : null,
      traceId: row.requestId,
    }));
  }
}
