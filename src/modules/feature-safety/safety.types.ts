import type { InteractionSeverity } from './interaction.types';

export type SafetyWarningKind = 'DRUG_DRUG' | 'DUPLICATE_INGREDIENT';

export interface ProductRef {
  productId: string;
  name: string;
}

/** Một cảnh báo của giỏ hàng. `id` cố định theo cặp hoạt chất — dùng để đối chiếu cảnh báo nào đã được duyệt. */
export interface SafetyWarning {
  id: string;
  kind: SafetyWarningKind;
  severity: InteractionSeverity;
  products: ProductRef[];
  ingredients: string[];
  /** Cơ chế (tiếng Anh, DDInter); rỗng nếu không có. */
  description: string;
  /** Cách xử trí (tiếng Anh, DDInter); rỗng nếu không có. */
  management: string;
  /** Mô tả ngắn một dòng, lưu vào đơn khi được duyệt (giữ lại dù dữ liệu tương tác đổi về sau). */
  summary: string;
}

/**
 * Hàng thuốc KHÔNG kiểm tra được đầy đủ:
 * - NOT_IN_INTERACTION_DATA: số đăng ký không có trong dữ liệu tương tác
 * - INCOMPLETE_DATA: còn hoạt chất chưa map được — kết quả có thể thiếu
 * - NO_REGISTRATION_NUMBER: thuốc trong danh mục không có số đăng ký
 */
export type UncheckedReason = 'NOT_IN_INTERACTION_DATA' | 'INCOMPLETE_DATA' | 'NO_REGISTRATION_NUMBER';

export interface UncheckedProduct extends ProductRef {
  reason: UncheckedReason;
}

export interface SafetyCheckResult {
  /** Nặng trước. */
  warnings: SafetyWarning[];
  /** Có cảnh báo mức nghiêm trọng → phải có dược sĩ duyệt mới thu tiền được. */
  hasMajor: boolean;
  majorWarningIds: string[];
  unchecked: UncheckedProduct[];
  checkedAt: string;
}

/** Bản duyệt lưu vào cột `orders.interactionOverride`. */
export interface StoredInteractionApproval {
  reason: string;
  /** Cảnh báo nghiêm trọng đã được duyệt (rỗng khi duyệt thủ công lúc không tra được dữ liệu). */
  warningIds: string[];
  warningSummaries: string[];
  /** true = không tra được dữ liệu tương tác (1611), dược sĩ xác nhận đã kiểm tra thủ công. */
  manual: boolean;
  /** Dược sĩ duyệt. */
  byUserId: string;
  byUserName: string;
  /** Nhân viên lập đơn xin duyệt. */
  requestedBy: string;
  at: string;
}
