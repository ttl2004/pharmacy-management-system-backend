import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { PrismaService } from 'src/common/databases/prisma.service';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';
import { addDaysToDateOnly, daysBetweenDateOnly, vietnamDayStartUtc } from 'src/common/utils/date-only.util';
import { afterCursorDesc, decodeCursor, toKeysetPage, type KeysetCursor } from 'src/common/utils/keyset-cursor';
import { escapeLike } from 'src/common/utils/like-pattern.util';
import { foldVn } from 'src/common/utils/vn-fold.util';
import {
  assertBranchInScope,
  resolveBranchScope,
  scopedBranchFilter,
  type BranchScope,
} from 'src/modules/feature-auth/permission/branch-scope';
import { resolveAuditLabels } from './audit-entity-labels';
import { AuditLogQuery } from './dtos/audit-log.query';

/** Không có `searchText`, `userAgent` (D8, D6): hai trường này không bao giờ ra API. */
const LOG_SELECT = {
  id: true,
  createdAt: true,
  action: true,
  event: true,
  severity: true,
  amount: true,
  actorType: true,
  actorRoleCode: true,
  entityType: true,
  entityId: true,
  entityLabel: true,
  branchIds: true,
  before: true,
  after: true,
  metadata: true,
  reason: true,
  ipAddress: true,
  requestId: true,
  branch: { select: { id: true, code: true, name: true } },
  actor: { select: { id: true, fullName: true } },
} satisfies Prisma.AuditLogSelect;

const SEARCH_MIN_LENGTH = 3;
const SEARCH_MAX_DAYS = 90;

function badRequest(message: string) {
  return new ErrorException({ code: ErrorCode.HTTP_BAD_REQUEST, message });
}

/**
 * Phạm vi chi nhánh (B.6): PM chỉ thấy dòng có `branchIds` chứa chi nhánh mình — dòng toàn chuỗi (`branchIds = []`)
 * và dòng chi nhánh khác đều ẩn. Chi nhánh ngoài phạm vi trong bộ lọc → 1506.
 */
export function buildScopeWhere(scope: BranchScope, query: AuditLogQuery): Prisma.AuditLogWhereInput {
  const and: Prisma.AuditLogWhereInput[] = [];
  const branchId = scopedBranchFilter(scope, query.branchId);
  for (const id of query.branchIds ?? []) assertBranchInScope(scope, id);
  if (scope.kind === 'BRANCH') and.push({ branchIds: { has: scope.branchId } });
  else if (branchId) and.push({ branchIds: { has: branchId } });
  if (query.branchIds?.length) and.push({ branchIds: { hasSome: query.branchIds } });
  return { AND: and };
}

/** Khoảng ngày giờ VN → `[gte, lt)` UTC. */
function dateRange(query: AuditLogQuery) {
  return {
    gte: query.fromDate ? vietnamDayStartUtc(query.fromDate) : undefined,
    lt: query.toDate ? vietnamDayStartUtc(addDaysToDateOnly(query.toDate, 1)) : undefined,
  };
}

/** `search` hợp lệ → chuỗi đã bỏ dấu; không hợp lệ → 1002. */
function validateSearch(query: AuditLogQuery): string | null {
  const raw = query.search?.trim();
  if (!raw) return null;
  if (!query.fromDate || !query.toDate) throw badRequest('Tìm kiếm cần có fromDate và toDate');
  if (daysBetweenDateOnly(query.fromDate, query.toDate) + 1 > SEARCH_MAX_DAYS) {
    throw badRequest(`Khoảng ngày khi tìm kiếm tối đa ${SEARCH_MAX_DAYS} ngày`);
  }
  const folded = foldVn(raw);
  if (folded.length < SEARCH_MIN_LENGTH) throw badRequest(`Từ khoá cần ít nhất ${SEARCH_MIN_LENGTH} ký tự`);
  return folded;
}

/**
 * Đọc nhật ký thao tác. Không có hàm ghi: ghi chỉ qua `AuditLogService.record` trong transaction nghiệp vụ.
 */
@Injectable()
export class AuditLogQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: AuditLogQuery, actor: RequestActor) {
    if (query.fromDate && query.toDate && query.fromDate > query.toDate) {
      throw badRequest('fromDate phải trước hoặc bằng toDate');
    }
    const term = validateSearch(query);
    const scope = resolveBranchScope(actor.user);
    const scopeWhere = buildScopeWhere(scope, query);
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;

    const rows = term
      ? await this.searchRows(scope, query, term, cursor)
      : await this.prisma.auditLog.findMany({
          where: { AND: [scopeWhere, ...this.filterConditions(query), ...(cursor ? [afterCursorDesc(cursor)] : [])] },
          select: LOG_SELECT,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: query.limit + 1,
        });
    const page = toKeysetPage(rows, query.limit);
    return { ...page, items: await this.present(page.items) };
  }

  /** Chi tiết một dòng; ngoài phạm vi hoặc không tồn tại → 404 (không lộ sự tồn tại). */
  async get(id: string, actor: RequestActor) {
    const scopeWhere = buildScopeWhere(resolveBranchScope(actor.user), new AuditLogQuery());
    const row = await this.prisma.auditLog.findFirst({ where: { AND: [{ id }, scopeWhere] }, select: LOG_SELECT });
    if (!row) throw new NotFoundException({ code: ErrorCode.RECORD_NOT_FOUND, message: 'Không tìm thấy dòng nhật ký' });
    return (await this.present([row]))[0];
  }

  /** Lịch sử của một đối tượng: `list()` có cursor, cố định `entityType` + `entityId`. */
  listByEntity(entityType: string, entityId: string, query: AuditLogQuery, actor: RequestActor) {
    return this.list(Object.assign(new AuditLogQuery(), query, { entityType, entityId }), actor);
  }

  /** Điều kiện lọc ngoài phạm vi và cursor, dạng Prisma. */
  private filterConditions(query: AuditLogQuery): Prisma.AuditLogWhereInput[] {
    const { gte, lt } = dateRange(query);
    const c: Prisma.AuditLogWhereInput[] = [];
    if (query.entityType) c.push({ entityType: query.entityType });
    if (query.entityId) c.push({ entityId: query.entityId });
    if (query.actorId) c.push({ actorId: query.actorId });
    if (query.action) c.push({ action: query.action });
    if (query.event?.length) c.push({ event: { in: query.event } });
    if (query.severity !== undefined) c.push({ severity: { gte: query.severity } });
    if (gte) c.push({ createdAt: { gte } });
    if (lt) c.push({ createdAt: { lt } });
    return c;
  }

  /**
   * Tìm kiếm: MỘT câu raw mang đủ mọi điều kiện (phạm vi, ngày, bộ lọc, cursor) cùng `searchText LIKE` để index
   * trigram thu hẹp trước rồi mới lấy trang; sau đó nạp dòng theo id và giữ thứ tự của câu raw.
   */
  private async searchRows(scope: BranchScope, query: AuditLogQuery, term: string, cursor?: KeysetCursor) {
    const sql = this.buildSearchSql(scope, query, term, cursor);
    const ids = (await this.prisma.$queryRaw<{ id: string }[]>(sql)).map((r) => r.id);
    if (!ids.length) return [];
    const rows = await this.prisma.auditLog.findMany({ where: { id: { in: ids } }, select: LOG_SELECT });
    const order = new Map(ids.map((id, i) => [id, i]));
    return rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  }

  private buildSearchSql(scope: BranchScope, query: AuditLogQuery, term: string, cursor?: KeysetCursor): Prisma.Sql {
    const { gte, lt } = dateRange(query);
    const w: Prisma.Sql[] = [Prisma.sql`"searchText" LIKE ${`%${escapeLike(term)}%`}`];
    const branchId = scopedBranchFilter(scope, query.branchId);
    if (scope.kind === 'BRANCH') w.push(Prisma.sql`"branchIds" @> ARRAY[${scope.branchId}::uuid]`);
    else if (branchId) w.push(Prisma.sql`"branchIds" @> ARRAY[${branchId}::uuid]`);
    if (query.branchIds?.length) w.push(Prisma.sql`"branchIds" && ${query.branchIds}::uuid[]`);
    if (gte) w.push(Prisma.sql`"createdAt" >= ${gte}::timestamptz`);
    if (lt) w.push(Prisma.sql`"createdAt" < ${lt}::timestamptz`);
    if (query.event?.length) w.push(Prisma.sql`"event" = ANY(${query.event}::text[])`);
    if (query.severity !== undefined) w.push(Prisma.sql`"severity" >= ${query.severity}`);
    if (query.actorId) w.push(Prisma.sql`"actorId" = ${query.actorId}::uuid`);
    if (query.action) w.push(Prisma.sql`"action"::text = ${query.action}`);
    if (query.entityType) w.push(Prisma.sql`"entityType" = ${query.entityType}`);
    if (query.entityId) w.push(Prisma.sql`"entityId" = ${query.entityId}::uuid`);
    if (cursor) {
      w.push(
        Prisma.sql`("createdAt" < ${cursor.createdAt}::timestamptz OR ("createdAt" = ${cursor.createdAt}::timestamptz AND "id" < ${cursor.id}::uuid))`,
      );
    }
    return Prisma.sql`SELECT "id" FROM "audit_logs" WHERE ${Prisma.join(w, ' AND ')}
      ORDER BY "createdAt" DESC, "id" DESC LIMIT ${query.limit + 1}`;
  }

  /** `amount` → chuỗi (bigint không đi qua JSON), `traceId` = `requestId`, nhãn tra lúc đọc chỉ cho dòng thiếu. */
  private async present<
    T extends {
      entityType: string;
      entityId: string;
      entityLabel: string | null;
      amount: bigint | null;
      requestId: string | null;
    },
  >(items: T[]) {
    const labels = await resolveAuditLabels(
      this.prisma,
      items.filter((r) => r.entityLabel === null),
    );
    return items.map((row) => ({
      ...row,
      amount: row.amount === null ? null : row.amount.toString(),
      entityLabel: row.entityLabel ?? labels.get(row.entityId) ?? null,
      traceId: row.requestId,
    }));
  }
}
