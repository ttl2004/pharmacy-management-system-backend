import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { assertBranchInScope, resolveBranchScope } from '../feature-auth/permission/branch-scope';

export interface ReportScope {
  /** `undefined` = toàn chuỗi (chỉ ADMIN/SUPER_ADMIN không lọc). */
  branchIds: string[] | undefined;
  /** Phạm vi người gọi, đưa vào khoá cache để PM không đọc nhầm cache của ADMIN. */
  scopeKey: string;
}

/**
 * Phạm vi chi nhánh của một lượt gọi báo cáo. Kiểm quyền TRƯỚC khi nhìn cache: PM xin chi nhánh khác luôn bị 1506,
 * dù có ai đó đã làm nóng khoá. PM bỏ trống = chi nhánh mình; ADMIN bỏ trống = toàn chuỗi.
 */
export function resolveReportScope(actor: RequestActor, requestedIds: string[] | undefined): ReportScope {
  const scope = resolveBranchScope(actor.user);
  const requested = [...new Set(requestedIds ?? [])].sort();
  for (const branchId of requested) assertBranchInScope(scope, branchId);
  const branchIds = requested.length ? requested : scope.kind === 'BRANCH' ? [scope.branchId] : undefined;
  const scopeKey = scope.kind === 'ALL' ? 'ALL' : `BRANCH:${scope.branchId}`;
  return { branchIds, scopeKey };
}
