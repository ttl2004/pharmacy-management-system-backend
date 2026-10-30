import { Injectable } from '@nestjs/common';
import { Drug } from '@prisma/client';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';
import { AbstractBaseService } from 'src/providers/abstract-base/abstract-base.service';
import { BaseWhere } from 'src/providers/abstract-base/repositories/abstract-base.repository';
import { DrugSourceClient } from './drug-source.client';
import { DrugQuery } from './dtos/drug.query';
import { DrugRepository } from './repositories/drug.repository';

export interface DrugSyncResult {
  total: number;
  upserted: number;
  deactivated: number;
  /** Hàng hoá được sửa cờ kê đơn cho khớp danh mục. */
  productsUpdated: number;
  syncedAt: Date;
}

/** Một lần đồng bộ chuyển INACTIVE quá tỉ lệ này của thuốc đang ACTIVE thì coi là nghi nguồn lỗi, phải `force`. */
export const MAX_DEACTIVATE_RATIO = 0.1;

@Injectable()
export class DrugService extends AbstractBaseService<Drug> {
  constructor(
    private readonly drugRepository: DrugRepository,
    private readonly drugSource: DrugSourceClient,
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
    });
  }

  async getDetail(id: string): Promise<Drug> {
    const drug = await this.drugRepository.findOne({ id });
    if (!drug) throw new ErrorException({ code: ErrorCode.RECORD_NOT_FOUND, message: 'Thuốc không tồn tại' });
    return drug;
  }

  /**
   * Kéo toàn bộ danh mục từ nguồn CSDL Dược và ghi đè bản sao cục bộ. Cả lần chạy giữ khoá đồng bộ từ TRƯỚC khi tải
   * nguồn, nên hai lần bấm gần nhau không thể để snapshot cũ ghi sau snapshot mới. Mọi lỗi giữa chừng (kể cả rào tỉ lệ
   * INACTIVE) đều rollback — không bao giờ để lại danh mục ghi dở.
   */
  sync(callerId: string, force = false): Promise<DrugSyncResult> {
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
      const productsUpdated = await this.drugRepository.syncProductPrescription(tx, syncedAt, callerId);
      return { total: drugs.length, upserted, deactivated, productsUpdated, syncedAt };
    });
  }
}
