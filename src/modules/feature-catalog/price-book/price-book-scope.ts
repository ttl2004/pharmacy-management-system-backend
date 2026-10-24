import { ErrorCode } from 'src/common/types/error-code';
import { BranchScope } from '../../feature-auth/permission/branch-scope';
import { permissionError } from '../../feature-auth/permission/permission.error';

/**
 * Phạm vi chi nhánh của BẢNG GIÁ (quyết định D2).
 *
 * `branchIds` rỗng nghĩa là "toàn hệ thống" nên KHÔNG được hiểu thành "không thuộc chi nhánh nào": quản lý chi
 * nhánh không sửa được bảng toàn hệ thống. Chỉ vai trò toàn chuỗi (ADMIN/SUPER_ADMIN) sửa được mọi bảng.
 */

/** Người gọi có được sửa / xoá / ghi giá vào bảng có phạm vi `branchIds` không. */
export function canEditBook(scope: BranchScope, branchIds: readonly string[]): boolean {
  if (scope.kind === 'ALL') return true;
  return branchIds.length > 0 && branchIds.every((branchId) => branchId === scope.branchId);
}

/** Người gọi có được XEM bảng này không: bảng toàn hệ thống, hoặc bảng có áp dụng chi nhánh của mình. */
export function canReadBook(scope: BranchScope, branchIds: readonly string[]): boolean {
  if (scope.kind === 'ALL') return true;
  return branchIds.length === 0 || branchIds.includes(scope.branchId);
}

/**
 * Chặn ghi phạm vi sai khi tạo/sửa: quản lý chi nhánh phải gửi đúng `[chi nhánh của mình]` — gửi rỗng (toàn hệ
 * thống) hoặc kèm chi nhánh khác đều bị từ chối. Vai trò toàn chuỗi gửi tuỳ ý.
 */
export function assertWritableBranchIds(scope: BranchScope, branchIds: readonly string[]): void {
  if (canEditBook(scope, branchIds)) return;
  throw permissionError(
    ErrorCode.BRANCH_ACCESS_DENIED,
    'Quản lý chi nhánh chỉ được tạo, sửa bảng giá áp dụng cho chi nhánh của mình',
  );
}
