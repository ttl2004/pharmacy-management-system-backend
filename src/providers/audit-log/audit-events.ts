import type { AdjustmentType, AuditAction } from '@prisma/client';

export type AuditSeverity = 0 | 1 | 2;

interface AuditEventDef {
  action: AuditAction;
  severity: AuditSeverity;
  reasonRequired: boolean;
}

/**
 * Danh mục sự kiện nhật ký (plan v2 A.4 + v2.1 B.3). `action` giữ cho FE cũ, `severity` là mức nền
 * (entry chỉ được nâng), `reasonRequired` bắt buộc `reason` ở compile-time và lúc chạy (lỗi 1002).
 */
export const AUDIT_EVENTS = {
  'ORDER.CREATED': { action: 'CREATE', severity: 0, reasonRequired: false },
  'ORDER.ITEMS_REPLACED': { action: 'UPDATE', severity: 0, reasonRequired: false },
  'ORDER.DISCOUNT_APPLIED': { action: 'UPDATE', severity: 1, reasonRequired: false },
  'ORDER.INTERACTION_OVERRIDE': { action: 'UPDATE', severity: 1, reasonRequired: false },
  'ORDER.PAID': { action: 'STATUS_CHANGE', severity: 0, reasonRequired: false },
  'ORDER.CANCELLED': { action: 'STATUS_CHANGE', severity: 0, reasonRequired: false },
  'ORDER.AUTO_EXPIRED': { action: 'STATUS_CHANGE', severity: 0, reasonRequired: false },
  'ORDER.VOID_PAID': { action: 'STATUS_CHANGE', severity: 2, reasonRequired: true },
  'PAYMENT.REFUNDED': { action: 'STATUS_CHANGE', severity: 1, reasonRequired: true },
  'CUSTOMER.CREATED': { action: 'CREATE', severity: 0, reasonRequired: false },
  'GOODS_RECEIPT.CREATED': { action: 'CREATE', severity: 0, reasonRequired: false },
  'GOODS_RECEIPT.UPDATED': { action: 'UPDATE', severity: 0, reasonRequired: false },
  'GOODS_RECEIPT.CONFIRMED': { action: 'STATUS_CHANGE', severity: 0, reasonRequired: false },
  'GOODS_RECEIPT.META_UPDATED': { action: 'UPDATE', severity: 0, reasonRequired: false },
  'GOODS_RECEIPT.PAYMENT_UPDATED': { action: 'UPDATE', severity: 0, reasonRequired: false },
  'GOODS_RECEIPT.CANCELLED': { action: 'STATUS_CHANGE', severity: 1, reasonRequired: false },
  'SUPPLIER_PAYMENT.CREATED': { action: 'CREATE', severity: 0, reasonRequired: false },
  'SUPPLIER_PAYMENT.CANCELLED': { action: 'STATUS_CHANGE', severity: 1, reasonRequired: false },
  'SUPPLIER_DEBT.ADJUSTED': { action: 'CREATE', severity: 1, reasonRequired: false },
  'SUPPLIER_DEBT.ADJUSTMENT_CANCELLED': { action: 'STATUS_CHANGE', severity: 1, reasonRequired: false },
  'BRANCH_PRODUCT.UPSERTED': { action: 'UPDATE', severity: 0, reasonRequired: false },
  'BRANCH_PRODUCT.DELETED': { action: 'DELETE', severity: 0, reasonRequired: false },
  'BATCH.STATUS_CHANGED': { action: 'STATUS_CHANGE', severity: 1, reasonRequired: false },
  'BATCH.RECALLED': { action: 'STATUS_CHANGE', severity: 2, reasonRequired: true },
  'STOCK_ADJUSTMENT.CREATED': { action: 'CREATE', severity: 0, reasonRequired: false },
  'STOCK_ADJUSTMENT.UPDATED': { action: 'UPDATE', severity: 0, reasonRequired: false },
  'STOCK_ADJUSTMENT.CONFIRMED': { action: 'STATUS_CHANGE', severity: 0, reasonRequired: false },
  'STOCK_ADJUSTMENT.CANCELLED': { action: 'STATUS_CHANGE', severity: 0, reasonRequired: false },
  'DISPOSAL.CREATED': { action: 'CREATE', severity: 1, reasonRequired: true },
  'DISPOSAL.UPDATED': { action: 'UPDATE', severity: 1, reasonRequired: true },
  'DISPOSAL.CONFIRMED': { action: 'STATUS_CHANGE', severity: 1, reasonRequired: true },
  'DISPOSAL.CANCELLED': { action: 'STATUS_CHANGE', severity: 1, reasonRequired: true },
  'PURCHASE_RETURN.CREATED': { action: 'CREATE', severity: 1, reasonRequired: true },
  'PURCHASE_RETURN.UPDATED': { action: 'UPDATE', severity: 1, reasonRequired: true },
  'PURCHASE_RETURN.CONFIRMED': { action: 'STATUS_CHANGE', severity: 1, reasonRequired: true },
  'PURCHASE_RETURN.CANCELLED': { action: 'STATUS_CHANGE', severity: 1, reasonRequired: true },
  'TRANSFER.CREATED': { action: 'CREATE', severity: 1, reasonRequired: true },
  'TRANSFER.SHIPPED': { action: 'STATUS_CHANGE', severity: 1, reasonRequired: true },
  'TRANSFER.RECEIVED_SHORT': { action: 'STATUS_CHANGE', severity: 1, reasonRequired: true },
  'TRANSFER.UPDATED': { action: 'UPDATE', severity: 0, reasonRequired: false },
  'TRANSFER.RECEIVED': { action: 'STATUS_CHANGE', severity: 0, reasonRequired: false },
  'TRANSFER.CANCELLED': { action: 'STATUS_CHANGE', severity: 1, reasonRequired: false },
  'STOCK.OPENING': { action: 'CREATE', severity: 0, reasonRequired: false },
  'PRICE_BOOK.CREATED': { action: 'CREATE', severity: 0, reasonRequired: false },
  'PRICE_BOOK.UPDATED': { action: 'UPDATE', severity: 0, reasonRequired: false },
  'PRICE_BOOK.STATUS_CHANGED': { action: 'STATUS_CHANGE', severity: 0, reasonRequired: false },
  'PRICE_BOOK.DELETED': { action: 'DELETE', severity: 0, reasonRequired: false },
  'PRICE_BOOK.FORMULA_CLEARED': { action: 'UPDATE', severity: 0, reasonRequired: false },
  'PRICE_BOOK.ITEMS_SET': { action: 'UPDATE', severity: 0, reasonRequired: false },
  'PRICE_BOOK.FORMULA_APPLIED': { action: 'UPDATE', severity: 0, reasonRequired: false },
  'PRODUCT.CREATED': { action: 'CREATE', severity: 0, reasonRequired: false },
  'PRODUCT.UPDATED': { action: 'UPDATE', severity: 0, reasonRequired: false },
  'PRODUCT.STATUS_CHANGED': { action: 'STATUS_CHANGE', severity: 0, reasonRequired: false },
  'PRODUCT.DELETED': { action: 'DELETE', severity: 0, reasonRequired: false },
  'PRODUCT.CONTROL_FLAGS_CHANGED': { action: 'UPDATE', severity: 2, reasonRequired: false },
  'PRODUCT.PRICE_CHANGED': { action: 'UPDATE', severity: 1, reasonRequired: false },
  'SUPPLIER.CREATED': { action: 'CREATE', severity: 0, reasonRequired: false },
  'SUPPLIER.UPDATED': { action: 'UPDATE', severity: 0, reasonRequired: false },
  'SUPPLIER.STATUS_CHANGED': { action: 'STATUS_CHANGE', severity: 0, reasonRequired: false },
  'SUPPLIER.DELETED': { action: 'DELETE', severity: 0, reasonRequired: false },
  'SUPPLIER_GROUP.CREATED': { action: 'CREATE', severity: 0, reasonRequired: false },
  'SUPPLIER_GROUP.UPDATED': { action: 'UPDATE', severity: 0, reasonRequired: false },
  'SUPPLIER_GROUP.STATUS_CHANGED': { action: 'STATUS_CHANGE', severity: 0, reasonRequired: false },
  'SUPPLIER_GROUP.DELETED': { action: 'DELETE', severity: 0, reasonRequired: false },
  'CATEGORY.CREATED': { action: 'CREATE', severity: 0, reasonRequired: false },
  'CATEGORY.UPDATED': { action: 'UPDATE', severity: 0, reasonRequired: false },
  'CATEGORY.STATUS_CHANGED': { action: 'STATUS_CHANGE', severity: 0, reasonRequired: false },
  'CATEGORY.DELETED': { action: 'DELETE', severity: 0, reasonRequired: false },
  'MANUFACTURER.CREATED': { action: 'CREATE', severity: 0, reasonRequired: false },
  'MANUFACTURER.UPDATED': { action: 'UPDATE', severity: 0, reasonRequired: false },
  'MANUFACTURER.STATUS_CHANGED': { action: 'STATUS_CHANGE', severity: 0, reasonRequired: false },
  'MANUFACTURER.DELETED': { action: 'DELETE', severity: 0, reasonRequired: false },
  'UNIT.CREATED': { action: 'CREATE', severity: 0, reasonRequired: false },
  'UNIT.UPDATED': { action: 'UPDATE', severity: 0, reasonRequired: false },
  'UNIT.STATUS_CHANGED': { action: 'STATUS_CHANGE', severity: 0, reasonRequired: false },
  'UNIT.DELETED': { action: 'DELETE', severity: 0, reasonRequired: false },
  'INTERNAL_USE_TYPE.CREATED': { action: 'CREATE', severity: 0, reasonRequired: false },
  'INTERNAL_USE_TYPE.UPDATED': { action: 'UPDATE', severity: 0, reasonRequired: false },
  'INTERNAL_USE_TYPE.STATUS_CHANGED': { action: 'STATUS_CHANGE', severity: 0, reasonRequired: false },
  'INTERNAL_USE_TYPE.DELETED': { action: 'DELETE', severity: 0, reasonRequired: false },
  'LOCATION.CREATED': { action: 'CREATE', severity: 0, reasonRequired: false },
  'ROUTE.CREATED': { action: 'CREATE', severity: 0, reasonRequired: false },
  'BRANCH.CREATED': { action: 'CREATE', severity: 1, reasonRequired: false },
  'BRANCH.UPDATED': { action: 'UPDATE', severity: 1, reasonRequired: false },
  'BRANCH.DELETED': { action: 'DELETE', severity: 1, reasonRequired: false },
  'USER.CREATED': { action: 'CREATE', severity: 1, reasonRequired: false },
  'USER.UPDATED': { action: 'UPDATE', severity: 1, reasonRequired: false },
  'USER.STATUS_CHANGED': { action: 'STATUS_CHANGE', severity: 1, reasonRequired: false },
  'USER.DELETED': { action: 'DELETE', severity: 1, reasonRequired: false },
  'USER.ROLE_CHANGED': { action: 'UPDATE', severity: 2, reasonRequired: true },
  'ROLE.CREATED': { action: 'CREATE', severity: 2, reasonRequired: false },
  'ROLE.DELETED': { action: 'DELETE', severity: 2, reasonRequired: false },
  'ROLE.PERMISSIONS_CHANGED': { action: 'UPDATE', severity: 2, reasonRequired: true },
  'DRUG.SYNCED': { action: 'UPDATE', severity: 1, reasonRequired: false },
} as const satisfies Record<string, AuditEventDef>;

export type AuditEvent = keyof typeof AUDIT_EVENTS;

/** Các event bắt buộc có `reason` không rỗng. */
export type ReasonRequiredEvent = {
  [K in AuditEvent]: (typeof AUDIT_EVENTS)[K]['reasonRequired'] extends true ? K : never;
}[AuditEvent];

const ADJUSTMENT_GROUP = {
  STOCK_TAKE: 'STOCK_ADJUSTMENT',
  OTHER: 'STOCK_ADJUSTMENT',
  DISPOSE: 'DISPOSAL',
  RETURN_TO_SUPPLIER: 'PURCHASE_RETURN',
} as const satisfies Record<AdjustmentType, string>;

type AdjustmentSuffix = 'CREATED' | 'UPDATED' | 'CONFIRMED' | 'CANCELLED';

/** Kiểu event theo loại phiếu: DISPOSE/RETURN_TO_SUPPLIER → event bắt buộc lý do, STOCK_TAKE/OTHER → không. */
export type AdjustmentEventOf<
  T extends AdjustmentType,
  S extends AdjustmentSuffix = AdjustmentSuffix,
> = `${(typeof ADJUSTMENT_GROUP)[T]}.${S}` extends infer E extends AuditEvent ? E : never;

/**
 * Event của phiếu điều chỉnh kho theo loại phiếu. Kiểu trả về thu hẹp theo literal truyền vào, nên
 * `AuditEntry` kiểm được `reason` mà không cần ép kiểu. Truyền `AdjustmentType` rộng thì nhận hợp của các nhóm
 * (12 event): caller luôn phải kèm `reason: string` mới biên dịch được.
 */
export function adjustmentEvent<T extends AdjustmentType, S extends AdjustmentSuffix>(
  type: T,
  suffix: S,
): AdjustmentEventOf<T, S> {
  return `${ADJUSTMENT_GROUP[type]}.${suffix}` as AdjustmentEventOf<T, S>;
}
