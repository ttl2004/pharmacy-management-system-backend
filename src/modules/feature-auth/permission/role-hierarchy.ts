import { ErrorCode } from 'src/common/types/error-code';
import { permissionError } from './permission.error';

/**
 * Rào cấp bậc — lớp phân quyền thứ ba, cạnh `PermissionGuard` (có quyền không) và `branch-scope.ts` (chi
 * nhánh nào). Luật người dùng chốt 2026-10-13: **không ai thay đổi được người dùng hay vai trò cùng cấp hoặc
 * cao hơn mình**; cấp bậc là cột `roles.level`.
 *
 * SUPER_ADMIN (100) tự động không đụng được SUPER_ADMIN khác — trùng với luật 14.
 *
 * Viết `!(target < caller)` thay vì `target >= caller` để hỏng theo hướng chặn: cấp bậc thiếu hoặc không phải
 * số (`undefined`, `NaN`) làm mọi phép so sánh ra false — dạng `>=` sẽ lặng lẽ cho qua.
 */
export function assertOutranks(callerLevel: number, targetLevel: number): void {
  if (!(targetLevel < callerLevel)) throw permissionError(ErrorCode.ROLE_LEVEL_FORBIDDEN);
}

/**
 * Chỉ được cấp **thêm** những quyền chính mình đang có — chặn leo thang đặc quyền qua ma trận quyền. Thu hồi
 * thì luôn được (thu hẹp không nguy hiểm). `callerCodes = null` nghĩa là người gọi có mọi quyền (SUPER_ADMIN).
 */
export function assertGrantable(
  wanted: readonly string[],
  currentlyGranted: ReadonlySet<string>,
  callerCodes: ReadonlySet<string> | null,
): void {
  if (!callerCodes) return;
  const added = wanted.filter((code) => !currentlyGranted.has(code));
  if (added.some((code) => !callerCodes.has(code))) throw permissionError(ErrorCode.PERMISSION_NOT_GRANTABLE);
}
