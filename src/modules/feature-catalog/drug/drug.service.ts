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
  syncedAt: Date;
}

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

  /** Kéo toàn bộ danh mục từ nguồn CSDL Dược và ghi đè bản sao cục bộ. */
  async sync(callerId: string): Promise<DrugSyncResult> {
    const drugs = await this.drugSource.fetchAll();
    // Nguồn rỗng gần như chắc chắn là sự cố phía nguồn — ghi vào sẽ chuyển INACTIVE toàn bộ danh mục.
    if (!drugs.length) {
      throw new ErrorException({
        code: ErrorCode.DRUG_SOURCE_UNAVAILABLE,
        message: 'Nguồn CSDL Dược trả danh mục rỗng, huỷ đồng bộ',
      });
    }

    const syncedAt = new Date();
    const { upserted, deactivated } = await this.drugRepository.replaceFromSource(drugs, syncedAt, callerId);
    return { total: drugs.length, upserted, deactivated, syncedAt };
  }
}
