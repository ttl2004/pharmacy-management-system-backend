import { AuthRole } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';
import { permissionError } from './permission.error';

/**
 * Phạm vi dữ liệu theo chi nhánh — lớp phân quyền thứ hai.
 *
 * `PermissionGuard` trả lời "vai trò này có được gọi API này không"; file này trả lời "được đụng tới dữ liệu
 * của chi nhánh nào". Dùng ở tầng service — sau ValidationPipe, khi đã có DTO sạch và đã đọc được bản ghi —
 * không dùng trong guard. Luật đầy đủ: docs/plans/2026-10-12-branch-scope-plan-and-spec.md, mục A4.
 */

/** Vai trò thấy dữ liệu của mọi chi nhánh. */
export const CHAIN_WIDE_ROLES: readonly string[] = [AuthRole.SUPER_ADMIN, AuthRole.ADMIN];

/**
 * Vai trò gắn với đúng một chi nhánh. Cũng là nguồn của luật 10 (`UserService.assertBranchRule`): vai trò
 * trong danh sách này bắt buộc có `branchId`, vai trò ngoài danh sách bắt buộc để trống.
 */
export const BRANCH_BOUND_ROLES: readonly string[] = [AuthRole.PHARMACY_MANAGER, AuthRole.SALES_STAFF];

export type BranchScopeKind = 'ALL' | 'BRANCH' | 'NONE';

export type BranchScope = { kind: 'ALL' } | { kind: 'BRANCH'; branchId: string };

/** Loại phạm vi của một vai trò, không ném lỗi — dùng để hiển thị (ví dụ `GET /permission/me`). */
export function branchScopeKindOf(role: string): BranchScopeKind {
  if (CHAIN_WIDE_ROLES.includes(role)) return 'ALL';
  if (BRANCH_BOUND_ROLES.includes(role)) return 'BRANCH';
  return 'NONE';
}

/**
 * Phạm vi của người gọi. Hỏng theo hướng chặn, giống `PermissionGuard`:
 * - nhân viên mà `branchId` trống (dữ liệu lỗi) → 1507, KHÔNG được hiểu thành "mọi chi nhánh";
 * - vai trò không có phạm vi chi nhánh (CUSTOMER, vai trò lạ) → 1500.
 */
export function resolveBranchScope(user: { role: string; branchId: string | null }): BranchScope {
  const kind = branchScopeKindOf(user.role);
  if (kind === 'ALL') return { kind: 'ALL' };
  if (kind === 'BRANCH') {
    if (!user.branchId) throw permissionError(ErrorCode.BRANCH_NOT_ASSIGNED);
    return { kind: 'BRANCH', branchId: user.branchId };
  }
  throw permissionError(ErrorCode.PERMISSION_DENIED);
}

/**
 * Chi nhánh dùng để lọc API danh sách (BS-04).
 * - ALL: trả đúng giá trị client gửi; `undefined` nghĩa là không lọc.
 * - BRANCH: không gửi → chi nhánh của người gọi; gửi đúng chi nhánh mình → giữ; gửi chi nhánh khác → 1506.
 */
export function scopedBranchFilter(scope: BranchScope, requested?: string): string | undefined {
  if (scope.kind === 'ALL') return requested;
  if (requested !== undefined && requested !== scope.branchId) {
    throw permissionError(ErrorCode.BRANCH_ACCESS_DENIED);
  }
  return scope.branchId;
}

/** Bản ghi thuộc chi nhánh `branchId` có nằm trong phạm vi không. `null` chỉ nằm trong phạm vi ALL. */
export function isInBranchScope(scope: BranchScope, branchId: string | null | undefined): boolean {
  return scope.kind === 'ALL' || branchId === scope.branchId;
}

/** Chặn ghi vào chi nhánh ngoài phạm vi (BS-06) — dùng cho chi nhánh mà client chỉ định khi tạo/sửa. */
export function assertBranchInScope(scope: BranchScope, branchId: string | null | undefined): void {
  if (!isInBranchScope(scope, branchId)) throw permissionError(ErrorCode.BRANCH_ACCESS_DENIED);
}
