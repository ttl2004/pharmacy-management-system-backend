import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuditEntry } from './audit-log.types';

/**
 * Ghi nhật ký thao tác. Chỉ có đường **thêm**: không API sửa/xoá, repository không có hàm update/delete.
 *
 * Luôn nhận `tx` của transaction nghiệp vụ và ghi chung một transaction — thao tác rollback thì log cũng mất,
 * không bao giờ có thao tác đã commit mà thiếu log. Một câu `createMany` cho cả lô entry, nên số câu lệnh
 * không tăng theo số dòng chứng từ (mỗi câu ~100 ms qua pooler).
 *
 * Về sau đẩy log sang hệ thống riêng (ELK, RabbitMQ): giữ nguyên chữ ký `record`, chỉ đổi phần thân.
 */
@Injectable()
export class AuditLogService {
  async record(tx: Prisma.TransactionClient, entries: readonly AuditEntry[]): Promise<void> {
    if (!entries.length) return;

    await tx.auditLog.createMany({
      data: entries.map((entry) => ({
        actorId: entry.actorId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        branchId: entry.branchId ?? null,
        before: entry.before ?? Prisma.DbNull,
        after: entry.after ?? Prisma.DbNull,
        reason: entry.reason ?? null,
        ipAddress: entry.ipAddress ?? null,
      })),
    });
  }
}
