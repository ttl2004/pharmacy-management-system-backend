import { AuditAction } from '@prisma/client';
import { diffFields } from 'src/providers/audit-log/audit-diff';
import type { AuditEntry } from 'src/providers/audit-log/audit-log.types';
import type { PriceBookRow } from './repositories/price-book.repository';

/** Tên bảng dùng làm `entityType` (FE dịch nhãn theo khoá này). */
export const PRICE_BOOK_AUDIT_ENTITY = 'price_books';
/** Sửa giá chung ghi vào sản phẩm (giá chung là `product_units.salePrice`), cùng entityType với nhật ký sản phẩm. */
const PRODUCT_AUDIT_ENTITY = 'products';

const FIELDS = [
  'name', 'startAt', 'endAt', 'status', 'outOfBookPolicy', 'branchIds', 'userIds',
  'formulaBase', 'formulaOp', 'formulaAmount', 'formulaUnit',
] as const;

type Snapshot = Record<(typeof FIELDS)[number], unknown>;

/** Dạng phẳng của bảng giá cho nhật ký: phạm vi là mảng id đã sắp để so sánh ổn định. */
function snapshot(row: PriceBookRow): Snapshot {
  return {
    name: row.name,
    startAt: row.startAt,
    endAt: row.endAt,
    status: row.status,
    outOfBookPolicy: row.outOfBookPolicy,
    branchIds: row.branches.map((b) => b.branchId).sort(),
    userIds: row.users.map((u) => u.userId).sort(),
    formulaBase: row.formulaBase,
    formulaOp: row.formulaOp,
    formulaAmount: row.formulaAmount === null ? null : Number(row.formulaAmount),
    formulaUnit: row.formulaUnit,
  };
}

export function priceBookCreatedEntry(actorId: string, row: PriceBookRow): AuditEntry {
  const after = diffFields({} as Snapshot, snapshot(row), FIELDS)?.after ?? {};
  return { actorId, action: AuditAction.CREATE, entityType: PRICE_BOOK_AUDIT_ENTITY, entityId: row.id, after };
}

/** `null` khi không trường nào đổi — caller không ghi. */
export function priceBookUpdatedEntry(actorId: string, before: PriceBookRow, after: PriceBookRow): AuditEntry | null {
  const diff = diffFields(snapshot(before), snapshot(after), FIELDS);
  if (!diff) return null;
  const statusOnly = Object.keys(diff.after).length === 1 && 'status' in diff.after;
  return {
    actorId, action: statusOnly ? AuditAction.STATUS_CHANGE : AuditAction.UPDATE,
    entityType: PRICE_BOOK_AUDIT_ENTITY, entityId: before.id, before: diff.before, after: diff.after,
  };
}

export function priceBookDeletedEntry(actorId: string, row: PriceBookRow): AuditEntry {
  const before = diffFields({} as Snapshot, snapshot(row), FIELDS)?.after ?? {};
  return { actorId, action: AuditAction.DELETE, entityType: PRICE_BOOK_AUDIT_ENTITY, entityId: row.id, before };
}

/** Sửa giá chung của một đơn vị bán: ghi lên sản phẩm, kèm đơn vị để biết dòng nào đổi. */
export function generalPriceChangedEntry(
  actorId: string,
  productId: string,
  unitId: string,
  before: number,
  after: number,
): AuditEntry {
  return {
    actorId, action: AuditAction.UPDATE, entityType: PRODUCT_AUDIT_ENTITY, entityId: productId,
    before: { unitId, salePrice: before }, after: { unitId, salePrice: after },
  };
}
