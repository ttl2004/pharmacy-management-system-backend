import { assertBranchInScope, type BranchScope } from 'src/modules/feature-auth/permission/branch-scope';
import { badRequest } from './inventory.error';

/**
 * Điều kiện phạm vi chi nhánh để NHÉT THẲNG vào `where` của truy vấn đọc/ghi theo id — không tải bản ghi về rồi mới
 * kiểm. Bản ghi ngoài phạm vi vì thế "không tồn tại" (1600) chứ không lộ ra là có (BS-05).
 */
export function branchWhere(scope: BranchScope): { branchId?: string } {
  return scope.kind === 'ALL' ? {} : { branchId: scope.branchId };
}

/** Phía của phiếu điều chuyển mà một thao tác thuộc về. */
export type TransferSide = 'from' | 'to' | 'either';

/**
 * Phạm vi cho phiếu điều chuyển — bản ghi có HAI chi nhánh. Đọc: thấy phiếu mình gửi HOẶC nhận. Xuất/huỷ: chỉ chi
 * nhánh gửi. Nhận: chỉ chi nhánh nhận. Cùng một phiếu, hai luật khác nhau — phải nói rõ phía khi gọi.
 */
export function transferWhere(
  scope: BranchScope,
  side: TransferSide,
): { fromBranchId?: string; toBranchId?: string; OR?: ({ fromBranchId: string } | { toBranchId: string })[] } {
  if (scope.kind === 'ALL') return {};
  if (side === 'from') return { fromBranchId: scope.branchId };
  if (side === 'to') return { toBranchId: scope.branchId };
  return { OR: [{ fromBranchId: scope.branchId }, { toBranchId: scope.branchId }] };
}

/**
 * Chi nhánh mà một thao tác GHI nhắm tới. PM/nhân viên: luôn là chi nhánh mình (chỉ định chi nhánh khác → 1506).
 * ADMIN (toàn chuỗi): bắt buộc chỉ định — không có "chi nhánh mặc định" nào hợp lý.
 */
export function resolveWriteBranch(
  scope: BranchScope,
  requested: string | undefined,
  missingMessage = 'Cần chọn chi nhánh (branchId)',
): string {
  if (scope.kind === 'BRANCH') {
    assertBranchInScope(scope, requested ?? scope.branchId);
    return scope.branchId;
  }
  if (!requested) throw badRequest(missingMessage);
  return requested;
}
