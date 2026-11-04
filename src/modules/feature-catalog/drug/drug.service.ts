import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Drug, Prisma } from '@prisma/client';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';
import { AbstractBaseService } from 'src/providers/abstract-base/abstract-base.service';
import { BaseWhere } from 'src/providers/abstract-base/repositories/abstract-base.repository';
import { auditActorOf } from 'src/providers/audit-log/audit-actor';
import { AuditLogService } from 'src/providers/audit-log/audit-log.service';
import type { AuditEntry } from 'src/providers/audit-log/audit-log.types';
import { DrugSourceClient } from './drug-source.client';
import { DrugQuery } from './dtos/drug.query';
import { DrugRepository, PrescriptionChange } from './repositories/drug.repository';

export interface DrugSyncResult {
  total: number;
  upserted: number;
  deactivated: number;
  /** Hàng hoá được sửa cờ kê đơn cho khớp danh mục. */
  productsUpdated: number;
  syncedAt: Date;
}

/**
 * Hàng hoá đang dùng thuốc này — ADMIN thấy ngay thuốc đã có những quy cách nào trước khi tạo thêm (đi cùng câu truy vấn
 * danh sách, không thêm API).
 */
const LINKED_PRODUCTS = {
  products: {
    where: { isDeleted: false },
    orderBy: { code: 'asc' },
    select: { id: true, code: true, name: true, packagingSpec: true, status: true },
  },
} satisfies Prisma.DrugInclude;

/** Một lần đồng bộ chuyển INACTIVE quá tỉ lệ này của thuốc đang ACTIVE thì coi là nghi nguồn lỗi, phải `force`. */
export const MAX_DEACTIVATE_RATIO = 0.1;

const SYNC_AUDIT_LABEL = 'Đồng bộ CSDL Dược';

/** Một dòng `DRUG.SYNCED` cho cả lần chạy + một dòng `PRODUCT.CONTROL_FLAGS_CHANGED` cho mỗi hàng bị đổi cờ (D10). */
function syncAuditEntries(
  result: Omit<DrugSyncResult, 'syncedAt'>,
  changed: readonly PrescriptionChange[],
  force: boolean,
): AuditEntry[] {
  const syncId = randomUUID();
  return [
    {
      event: 'DRUG.SYNCED',
      entityType: 'drugs',
      entityId: syncId,
      entityLabel: SYNC_AUDIT_LABEL,
      branchIds: [],
      metadata: { syncId, ...result, force },
    },
    ...changed.map((product): AuditEntry => ({
      event: 'PRODUCT.CONTROL_FLAGS_CHANGED',
      entityType: 'products',
      entityId: product.id,
      entityLabel: product.code,
      branchIds: [],
      before: { requiresPrescription: product.before },
      after: { requiresPrescription: product.after },
      metadata: { syncId },
    })),
  ];
}

@Injectable()
export class DrugService extends AbstractBaseService<Drug> {
  constructor(
    private readonly drugRepository: DrugRepository,
    private readonly drugSource: DrugSourceClient,
    private readonly audit: AuditLogService,
  ) {
    super(drugRepository);
  }

  async list(query: DrugQuery) {
    const filter: BaseWhere<Drug> = {};
    if (query.status) filter.status = query.status;
    if (query.isPrescription !== undefined) filter.isPrescription = query.isPrescription;

    return this.drugRepository.findManyWithPagination(filter, {
      page: query.page,
      limit: query.limit,
      sort: query.sort ?? 'name:asc',
      search: query.search,
      searchFields: ['code', 'name', 'ingredients', 'registrationNumber'],
      relations: LINKED_PRODUCTS,
    });
  }

  async getDetail(id: string): Promise<Drug> {
    const drug = await this.drugRepository.findOne({ id }, { relations: LINKED_PRODUCTS });
    if (!drug) throw new ErrorException({ code: ErrorCode.RECORD_NOT_FOUND, message: 'Thuốc không tồn tại' });
    return drug;
  }

  /**
   * Kéo toàn bộ danh mục từ nguồn CSDL Dược và ghi đè bản sao cục bộ. Cả lần chạy giữ khoá đồng bộ từ TRƯỚC khi tải
   * nguồn, nên hai lần bấm gần nhau không thể để snapshot cũ ghi sau snapshot mới. Mọi lỗi giữa chừng (kể cả rào tỉ lệ
   * INACTIVE) đều rollback — không bao giờ để lại danh mục ghi dở. Nhật ký ghi trong cùng transaction.
   */
  sync(actor: RequestActor, force = false): Promise<DrugSyncResult> {
    const callerId = actor.user.userId;
    return this.drugRepository.withSyncLock(async (tx) => {
      const drugs = await this.drugSource.fetchAll();
      // Nguồn rỗng gần như chắc chắn là sự cố phía nguồn — ghi vào sẽ chuyển INACTIVE toàn bộ danh mục.
      if (!drugs.length) {
        throw new ErrorException({
          code: ErrorCode.DRUG_SOURCE_UNAVAILABLE,
          message: 'Nguồn CSDL Dược trả danh mục rỗng, huỷ đồng bộ',
        });
      }

      const syncedAt = new Date();
      const activeBefore = await this.drugRepository.countActive(tx);
      const upserted = await this.drugRepository.upsertAll(tx, drugs, syncedAt, callerId);
      const stale = await this.drugRepository.countStale(tx, syncedAt);
      if (!force && stale > activeBefore * MAX_DEACTIVATE_RATIO) {
        throw new ErrorException({
          code: ErrorCode.DRUG_SYNC_SUSPICIOUS,
          message:
            `Lần đồng bộ này sẽ chuyển INACTIVE ${stale}/${activeBefore} thuốc đang hoạt động — nghi nguồn trả thiếu. ` +
            'Kiểm tra nguồn rồi gọi lại với force=true nếu đúng',
        });
      }
      const deactivated = await this.drugRepository.deactivateStale(tx, syncedAt, callerId);
      const changed = await this.drugRepository.syncProductPrescription(tx, syncedAt, callerId);
      const counts = { total: drugs.length, upserted, deactivated, productsUpdated: changed.length };
      await this.audit.record(tx, auditActorOf(actor), syncAuditEntries(counts, changed, force));
      return { ...counts, syncedAt };
    });
  }
}
