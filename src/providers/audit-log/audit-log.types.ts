import type { AuditEvent, AuditSeverity, ReasonRequiredEvent } from './audit-events';

/** Giá trị đã chuẩn hoá để ghi vào cột `jsonb`: không còn `Date`, `bigint`, `undefined`. */
export type AuditJson = string | number | boolean | null | AuditJson[] | { [key: string]: AuditJson };

type AuditEntryBase = {
  /** Tên bảng, ví dụ `goods_receipts`. */
  entityType: string;
  entityId: string;
  /** Nhãn người đọc được (mã phiếu, tên NCC…), tối đa 120 ký tự. */
  entityLabel?: string | null;
  /** Chi nhánh liên quan; `[]` = toàn chuỗi. Bắt buộc để không quên phạm vi. */
  branchIds: readonly string[];
  before?: AuditJson | null;
  after?: AuditJson | null;
  metadata?: AuditJson | null;
  /** Tiền, bigint. */
  amount?: bigint | null;
  /** Chỉ được nâng so với mức nền của event. */
  severity?: AuditSeverity;
  /** Từ khoá thêm cho `searchText` (chỉ dữ liệu trong danh sách trắng D8). */
  searchTerms?: readonly string[];
};

export type AuditEntry = AuditEntryBase &
  (
    | { event: ReasonRequiredEvent; reason: string }
    | { event: Exclude<AuditEvent, ReasonRequiredEvent>; reason?: string | null }
  );
