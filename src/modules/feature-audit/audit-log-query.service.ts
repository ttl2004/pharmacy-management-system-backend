import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { PrismaService } from 'src/common/databases/prisma.service';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';
import { addDaysToDateOnly, vietnamDayStartUtc } from 'src/common/utils/date-only.util';
import { escapeLike } from 'src/common/utils/like-pattern.util';
import { assertBranchInScope, resolveBranchScope, scopedBranchFilter } from 'src/modules/feature-auth/permission/branch-scope';
import { afterCursorDesc, decodeCursor, toKeysetPage } from 'src/common/utils/keyset-cursor';
import { resolveAuditLabels } from './audit-entity-labels';
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

/** Tìm theo nội dung quét JSON trước/sau — giới hạn số dòng khớp để không quét cả bảng khi từ khoá quá chung. */
const SEARCH_MATCH_CAP = 2000;

/**
 * Đọc nhật ký thao tác. PM thấy dòng gắn chi nhánh mình và dòng không gắn chi nhánh (danh mục dùng chung như nhà
 * cung cấp, sản phẩm); không thấy chi nhánh khác. Không có hàm ghi: ghi chỉ qua `AuditLogService.record` trong
 * transaction nghiệp vụ.
 */
@Injectable()
export class AuditLogQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: AuditLogQuery, actor: RequestActor) {
    if (query.fromDate && query.toDate && query.fromDate > query.toDate) {
      throw new ErrorException({ code: ErrorCode.HTTP_BAD_REQUEST, message: 'fromDate phải trước hoặc bằng toDate' });
    }
    const scope = resolveBranchScope(actor.user);
    const branchId = scopedBranchFilter(scope, query.branchId);
    const conditions: Prisma.AuditLogWhereInput[] = [];
    // PM không chọn chi nhánh: thấy chi nhánh mình + dữ liệu dùng chung (NCC, nhóm NCC, danh mục — branchId null).
    if (scope.kind === 'BRANCH' && !query.branchId) conditions.push({ OR: [{ branchId }, { branchId: null }] });
    else if (branchId) conditions.push({ branchId });
    if (query.branchIds?.length) {
      for (const id of query.branchIds) assertBranchInScope(scope, id);
      conditions.push({ branchId: { in: query.branchIds } });
    }
    if (query.entityType) conditions.push({ entityType: query.entityType });
    if (query.entityId) conditions.push({ entityId: query.entityId });
    if (query.actorId) conditions.push({ actorId: query.actorId });
    if (query.action) conditions.push({ action: query.action });
    if (query.fromDate) conditions.push({ createdAt: { gte: vietnamDayStartUtc(query.fromDate) } });
    if (query.toDate) conditions.push({ createdAt: { lt: vietnamDayStartUtc(addDaysToDateOnly(query.toDate, 1)) } });
    if (query.search?.trim()) conditions.push({ id: { in: await this.searchIds(query.search.trim()) } });
    if (query.cursor) conditions.push(afterCursorDesc(decodeCursor(query.cursor)));

    const rows = await this.prisma.auditLog.findMany({
      where: { AND: conditions },
      select: LOG_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const page = toKeysetPage(rows, query.limit);
    // `entityLabel`: mã/tên đối tượng tra lúc đọc (log chỉ lưu id); null = loại chưa hỗ trợ hoặc đã xoá hẳn.
    const labels = await resolveAuditLabels(this.prisma, page.items);
    return { ...page, items: page.items.map((row) => ({ ...row, entityLabel: labels.get(row.entityId) ?? null })) };
  }

  /** Dòng log có lý do hoặc nội dung trước/sau chứa từ khoá (mới nhất trước, tối đa SEARCH_MATCH_CAP). */
  private async searchIds(term: string): Promise<string[]> {
    const pattern = `%${escapeLike(term)}%`;
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "audit_logs"
      WHERE "reason" ILIKE ${pattern} OR "before"::text ILIKE ${pattern} OR "after"::text ILIKE ${pattern}
      ORDER BY "createdAt" DESC
      LIMIT ${SEARCH_MATCH_CAP}`;
    return rows.map((r) => r.id);
  }
}
