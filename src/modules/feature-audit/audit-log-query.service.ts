import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { PrismaService } from 'src/common/databases/prisma.service';
import { addDaysToDateOnly, vietnamDayStartUtc } from 'src/common/utils/date-only.util';
import { resolveBranchScope, scopedBranchFilter } from 'src/modules/feature-auth/permission/branch-scope';
import { afterCursorDesc, decodeCursor, toKeysetPage } from 'src/common/utils/keyset-cursor';
import { AuditLogQuery } from './dtos/audit-log.query';

const LOG_SELECT = {
  id: true,
  createdAt: true,
  action: true,
  entityType: true,
  entityId: true,
  before: true,
  after: true,
  reason: true,
  ipAddress: true,
  branch: { select: { id: true, code: true, name: true } },
  actor: { select: { id: true, fullName: true } },
} satisfies Prisma.AuditLogSelect;

/**
 * Đọc nhật ký thao tác. PM chỉ thấy dòng gắn chi nhánh mình — dòng không gắn chi nhánh (danh mục dùng chung như nhà
 * cung cấp) chỉ ADMIN thấy. Không có hàm ghi: ghi chỉ qua `AuditLogService.record` trong transaction nghiệp vụ.
 */
@Injectable()
export class AuditLogQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: AuditLogQuery, actor: RequestActor) {
    const branchId = scopedBranchFilter(resolveBranchScope(actor.user), query.branchId);
    const conditions: Prisma.AuditLogWhereInput[] = [];
    if (branchId) conditions.push({ branchId });
    if (query.entityType) conditions.push({ entityType: query.entityType });
    if (query.entityId) conditions.push({ entityId: query.entityId });
    if (query.actorId) conditions.push({ actorId: query.actorId });
    if (query.action) conditions.push({ action: query.action });
    if (query.fromDate) conditions.push({ createdAt: { gte: vietnamDayStartUtc(query.fromDate) } });
    if (query.toDate) conditions.push({ createdAt: { lt: vietnamDayStartUtc(addDaysToDateOnly(query.toDate, 1)) } });
    if (query.cursor) conditions.push(afterCursorDesc(decodeCursor(query.cursor)));

    const rows = await this.prisma.auditLog.findMany({
      where: { AND: conditions },
      select: LOG_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    return toKeysetPage(rows, query.limit);
  }
}
