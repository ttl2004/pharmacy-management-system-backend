import { diffFields } from 'src/providers/audit-log/audit-diff';
import type { AuditEntry } from 'src/providers/audit-log/audit-log.types';
import type { PriceBookRow } from './repositories/price-book.repository';

/** Tên bảng dùng làm `entityType` (FE dịch nhãn theo khoá này). */
export const PRICE_BOOK_AUDIT_ENTITY = 'price_books';
/** Sửa giá chung ghi vào sản phẩm (giá chung là `product_units.salePrice`), cùng entityType với nhật ký sản phẩm. */
const PRODUCT_AUDIT_ENTITY = 'products';

const FIELDS = [
  'name',
  'startAt',
  'endAt',
  'status',
  'outOfBookPolicy',
  'branchIds',
  'userIds',
  'formulaBase',
  'formulaOp',
  'formulaAmount',
  'formulaUnit',
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

/** Phạm vi của bảng (A.4): danh sách chi nhánh áp dụng, `[]` = toàn chuỗi. */
function branchesOf(row: PriceBookRow): string[] {
  return row.branches.map((b) => b.branchId);
}

function base(row: PriceBookRow, branchIds: string[]) {
  return { entityType: PRICE_BOOK_AUDIT_ENTITY, entityId: row.id, entityLabel: row.name, branchIds };
}

export function priceBookCreatedEntry(row: PriceBookRow): AuditEntry {
  const after = diffFields({} as Snapshot, snapshot(row), FIELDS)?.after ?? {};
  return { event: 'PRICE_BOOK.CREATED', ...base(row, branchesOf(row)), after };
}

/**
 * `null` khi không trường nào đổi — caller không ghi. Phạm vi = hợp thuần chi nhánh trước và sau (A.4, R17): người của
 * chi nhánh bị gỡ khỏi bảng vẫn thấy dòng này; chỉ khi cả hai phía đều toàn chuỗi mới là `[]` (chỉ ADMIN thấy).
 */
export function priceBookUpdatedEntry(before: PriceBookRow, after: PriceBookRow): AuditEntry | null {
  const diff = diffFields(snapshot(before), snapshot(after), FIELDS);
  if (!diff) return null;
  const statusOnly = Object.keys(diff.after).length === 1 && 'status' in diff.after;
  const branchIds = [...new Set([...branchesOf(before), ...branchesOf(after)])];
  return {
    event: statusOnly ? 'PRICE_BOOK.STATUS_CHANGED' : 'PRICE_BOOK.UPDATED',
    ...base(after, branchIds),
    before: diff.before,
    after: diff.after,
  };
}

export function priceBookDeletedEntry(row: PriceBookRow): AuditEntry {
  const before = diffFields({} as Snapshot, snapshot(row), FIELDS)?.after ?? {};
  return { event: 'PRICE_BOOK.DELETED', ...base(row, branchesOf(row)), before };
}

/** Bảng giá gốc bị xoá → công thức của bảng phụ thuộc bị gỡ. `null` khi bảng đó vốn không có công thức. */
export function priceBookFormulaClearedEntry(row: PriceBookRow, cleared: PriceBookRow): AuditEntry | null {
  const diff = diffFields(snapshot(row), snapshot(cleared), FIELDS);
  if (!diff) return null;
  return { event: 'PRICE_BOOK.FORMULA_CLEARED', ...base(row, branchesOf(row)), before: diff.before, after: diff.after };
}

/**
 * Sửa giá chung của một đơn vị bán: ghi lên sản phẩm (danh mục toàn chuỗi → `[]`), kèm đơn vị để biết dòng nào đổi.
 * `amount` = giá mới.
 */
export function generalPriceChangedEntry(
  product: { id: string; code: string; name: string },
  unitId: string,
  before: number,
  after: number,
): AuditEntry {
  return {
    event: 'PRODUCT.PRICE_CHANGED',
    entityType: PRODUCT_AUDIT_ENTITY,
    entityId: product.id,
    entityLabel: product.code,
    branchIds: [],
    before: { unitId, salePrice: before },
    after: { unitId, salePrice: after },
    amount: BigInt(after),
    searchTerms: [product.code, product.name],
  };
}
