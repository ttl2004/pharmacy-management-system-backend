import type { AuditJson } from 'src/providers/audit-log/audit-log.types';
import type { OrderHead } from '../order/repositories/order.repository';

/** Quyền xử lý (sửa/thu/huỷ) đơn chờ thu do nhân viên khác lập. SUPER_ADMIN luôn có. */
export const HANDLE_OTHERS_PERMISSION = 'order:handle-others';

/** Người lập đơn: `staffId` (gán lúc tạo), thiếu thì `createdBy` (dữ liệu cũ). */
export function orderCreatorId(head: Pick<OrderHead, 'staffId' | 'createdBy'>): string | null {
  return head.staffId ?? head.createdBy;
}

/** Đơn của chính người thao tác? Không rõ người lập (dữ liệu cũ) coi như của người khác. */
export function isOwnOrder(head: Pick<OrderHead, 'staffId' | 'createdBy'>, actorId: string): boolean {
  return orderCreatorId(head) === actorId;
}

/**
 * Phần `metadata` cho nhật ký khi người thao tác không phải người lập đơn: `onBehalfOf` = người lập đơn.
 * Tự thao tác đơn của mình (hoặc không rõ người lập) → `{}` để spread vào entry mà không đổi gì.
 */
export function onBehalfOfMetadata(
  head: Pick<OrderHead, 'staffId' | 'createdBy' | 'staffName'>,
  actorId: string,
): { metadata?: { [key: string]: AuditJson } } {
  const creatorId = orderCreatorId(head);
  if (!creatorId || creatorId === actorId) return {};
  return { metadata: { onBehalfOf: { userId: creatorId, fullName: head.staffName } } };
}
