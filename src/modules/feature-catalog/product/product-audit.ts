import { diffFields, pickAuditFields } from 'src/providers/audit-log/audit-diff';
import type { AuditEntry, AuditJson } from 'src/providers/audit-log/audit-log.types';

/** Tên bảng dùng làm `entityType` (FE dịch nhãn theo khoá này). */
export const PRODUCT_AUDIT_ENTITY = 'products';

/**
 * Trường đưa vào nhật ký: định danh, phân loại, giá trị ảnh hưởng bán/kho. Bỏ văn bản dài (mô tả, chỉ định…) và
 * cấu hình đơn vị (đã có trong chi tiết sản phẩm) để dòng log gọn.
 */
const FIELDS = [
  'code',
  'name',
  'barcode',
  'categoryId',
  'manufacturerId',
  'baseUnitId',
  'status',
  'type',
  'trackBatches',
  'requiresPrescription',
  'isControlled',
  'minStockLevel',
  'maxStockLevel',
  'routeId',
  'dosageForm',
  'drugId',
] as const;

/** Cờ kiểm soát (kê đơn, thuốc kiểm soát đặc biệt): đổi thì ghi riêng `PRODUCT.CONTROL_FLAGS_CHANGED` (mức 2). */
const CONTROL_FLAGS = ['requiresPrescription', 'isControlled'] as const;
const CONTROL_FLAG_SET: ReadonlySet<string> = new Set(CONTROL_FLAGS);

type Row = Partial<Record<(typeof FIELDS)[number], unknown>> & { code: string; name: string };
/** Dòng đơn vị bán tối thiểu để so giá chung. */
type UnitPrice = {
  salePrice: number;
  unit: { id: string };
  conversionRate?: number;
  barcode?: string | null;
};

const UNIT_FIELDS = ['conversionRate', 'salePrice', 'barcode'] as const;
/** Trường so ở dòng đã có: giá đổi đã có `PRODUCT.PRICE_CHANGED` riêng nên không ghi trùng ở đây. */
const UNIT_DIFF_FIELDS = ['conversionRate', 'barcode'] as const;

/** Một dòng đơn vị gọn để ghi nhật ký: khoá theo `unitId`, kèm quy đổi / giá / mã vạch. */
function unitSnapshot(row: UnitPrice, fields: readonly (typeof UNIT_FIELDS)[number][] = UNIT_FIELDS) {
  return { unitId: row.unit.id, ...Object.fromEntries(fields.map((field) => [field, row[field] ?? null])) };
}

/**
 * So cấu hình đơn vị bán trước/sau (theo `unit.id`): dòng thêm → chỉ có ở `after`, dòng bỏ → chỉ có ở `before`, dòng sửa
 * → cả hai, chỉ gồm trường đổi. Trả `null` khi không có gì đổi.
 */
function diffUnits(before: readonly UnitPrice[] = [], after: readonly UnitPrice[] = []) {
  const oldRows = new Map(before.map((row) => [row.unit.id, row]));
  const newRows = new Map(after.map((row) => [row.unit.id, row]));
  const unitsBefore: AuditJson[] = [];
  const unitsAfter: AuditJson[] = [];
  for (const [id, row] of oldRows) {
    if (!newRows.has(id)) unitsBefore.push(unitSnapshot(row));
  }
  for (const [id, row] of newRows) {
    const previous = oldRows.get(id);
    if (!previous) {
      unitsAfter.push(unitSnapshot(row));
      continue;
    }
    const changed = UNIT_DIFF_FIELDS.filter(
      (field) => previous[field] !== undefined && (previous[field] ?? null) !== (row[field] ?? null),
    );
    if (!changed.length) continue;
    unitsBefore.push(unitSnapshot(previous, changed));
    unitsAfter.push(unitSnapshot(row, changed));
  }
  return unitsBefore.length || unitsAfter.length ? { before: unitsBefore, after: unitsAfter } : null;
}

/** Nhãn, phạm vi và từ khoá chung của mọi dòng sản phẩm: danh mục toàn chuỗi → `[]`; tìm theo mã + tên (D8). */
function base(id: string, row: Row) {
  const { code, name } = row;
  return {
    entityType: PRODUCT_AUDIT_ENTITY,
    entityId: id,
    entityLabel: code,
    branchIds: [] as string[],
    searchTerms: [code, name].filter(Boolean),
  };
}

function split(record: Record<string, AuditJson>, inControl: boolean): Record<string, AuditJson> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => CONTROL_FLAG_SET.has(key) === inControl));
}

export function productCreatedEntry(id: string, row: Row): AuditEntry {
  return { event: 'PRODUCT.CREATED', ...base(id, row), after: pickAuditFields(row, FIELDS) };
}

/**
 * Các dòng nhật ký của một lần sửa (rỗng khi không có gì đáng ghi — vd. chỉ đổi mô tả hoặc bấm sao):
 * - `PRODUCT.UPDATED` / `STATUS_CHANGED` (chỉ đổi `status`) cho trường thường; đổi cấu hình đơn vị bán (thêm / bỏ dòng, quy
 *   đổi, mã vạch; giá đổi đã có `PRICE_CHANGED`) ghi chung vào đây dưới khoá `units` (luôn là `PRODUCT.UPDATED`);
 * - `PRODUCT.CONTROL_FLAGS_CHANGED` khi đổi cờ kê đơn / kiểm soát đặc biệt;
 * - `PRODUCT.PRICE_CHANGED` cho mỗi đơn vị bán (có cả trước và sau) đổi giá chung, `amount` = giá mới.
 */
export function productUpdatedEntries(
  id: string,
  before: Row & { units?: readonly UnitPrice[] },
  after: Row & { units?: readonly UnitPrice[] },
): AuditEntry[] {
  const entries: AuditEntry[] = [];
  const common = base(id, after);
  const diff = diffFields(before, after, FIELDS);
  const unitDiff = diffUnits(before.units, after.units);
  let unitsLogged = false;
  if (diff) {
    const fieldBefore = split(diff.before, false);
    const fieldAfter = split(diff.after, false);
    const changedKeys = Object.keys(fieldAfter);
    if (changedKeys.length) {
      const statusOnly = changedKeys.length === 1 && changedKeys[0] === 'status' && !unitDiff;
      entries.push({
        event: statusOnly ? 'PRODUCT.STATUS_CHANGED' : 'PRODUCT.UPDATED',
        ...common,
        before: unitDiff ? { ...fieldBefore, units: unitDiff.before } : fieldBefore,
        after: unitDiff ? { ...fieldAfter, units: unitDiff.after } : fieldAfter,
      });
      unitsLogged = Boolean(unitDiff);
    }
    const flagsAfter = split(diff.after, true);
    if (Object.keys(flagsAfter).length) {
      entries.push({
        event: 'PRODUCT.CONTROL_FLAGS_CHANGED',
        ...common,
        before: split(diff.before, true),
        after: flagsAfter,
      });
    }
  }

  if (unitDiff && !unitsLogged) {
    entries.push({
      event: 'PRODUCT.UPDATED',
      ...common,
      before: { units: unitDiff.before },
      after: { units: unitDiff.after },
    });
  }

  const oldPrice = new Map((before.units ?? []).map((row) => [row.unit.id, row.salePrice]));
  for (const row of after.units ?? []) {
    const previous = oldPrice.get(row.unit.id);
    if (previous === undefined || previous === row.salePrice) continue;
    entries.push({
      event: 'PRODUCT.PRICE_CHANGED',
      ...common,
      before: { unitId: row.unit.id, salePrice: previous },
      after: { unitId: row.unit.id, salePrice: row.salePrice },
      amount: BigInt(row.salePrice),
    });
  }
  return entries;
}

export function productRestoredEntry(id: string, row: Row): AuditEntry {
  return { event: 'PRODUCT.RESTORED', ...base(id, row), after: pickAuditFields(row, FIELDS) };
}

export function productDeletedEntry(id: string, row: Row): AuditEntry {
  return { event: 'PRODUCT.DELETED', ...base(id, row), before: pickAuditFields(row, FIELDS) };
}
