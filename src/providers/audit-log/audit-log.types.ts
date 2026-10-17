import type { AuditAction } from '@prisma/client';

/** Giá trị đã chuẩn hoá để ghi vào cột `jsonb`: không còn `Date`, `bigint`, `undefined`. */
export type AuditJson = string | number | boolean | null | AuditJson[] | { [key: string]: AuditJson };

export interface AuditEntry {
  actorId: string;
  action: AuditAction;
  /** Tên bảng, ví dụ `goods_receipts`. */
  entityType: string;
  entityId: string;
  branchId?: string | null;
  before?: Record<string, AuditJson> | null;
  after?: Record<string, AuditJson> | null;
  reason?: string | null;
  ipAddress?: string | null;
}
