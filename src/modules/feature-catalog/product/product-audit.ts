import { AuditAction } from '@prisma/client';
import { diffFields, pickAuditFields } from 'src/providers/audit-log/audit-diff';
import type { AuditEntry } from 'src/providers/audit-log/audit-log.types';

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

type Row = Partial<Record<(typeof FIELDS)[number], unknown>>;

export function productCreatedEntry(actorId: string, id: string, row: Row): AuditEntry {
  return {
    actorId,
    action: AuditAction.CREATE,
    entityType: PRODUCT_AUDIT_ENTITY,
    entityId: id,
    after: pickAuditFields(row, FIELDS),
  };
}

/** `null` khi không trường nào trong FIELDS đổi (vd. chỉ đổi mô tả hoặc bấm sao) — caller không ghi. */
export function productUpdatedEntry(actorId: string, id: string, before: Row, after: Row): AuditEntry | null {
  const diff = diffFields(before, after, FIELDS);
  if (!diff) return null;
  const statusOnly = Object.keys(diff.after).length === 1 && 'status' in diff.after;
  return {
    actorId,
    action: statusOnly ? AuditAction.STATUS_CHANGE : AuditAction.UPDATE,
    entityType: PRODUCT_AUDIT_ENTITY,
    entityId: id,
    before: diff.before,
    after: diff.after,
  };
}

export function productDeletedEntry(actorId: string, id: string, row: Row): AuditEntry {
  return {
    actorId,
    action: AuditAction.DELETE,
    entityType: PRODUCT_AUDIT_ENTITY,
    entityId: id,
    before: pickAuditFields(row, FIELDS),
  };
}
