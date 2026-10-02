import { Logger } from '@nestjs/common';
import {
  BaseFindOptions,
  BaseRecord,
  BaseWhere,
  IBaseRepository,
  PaginationResult,
} from './repositories/abstract-base.repository';

export abstract class AbstractBaseService<T extends BaseRecord> {
  protected readonly logger = new Logger(AbstractBaseService.name);

  constructor(protected readonly repository: IBaseRepository<T>) {}

  async createRecord(dto: Partial<T>): Promise<T> {
    this.logger.log('[createRecord] START');
    const record = await this.repository.create(dto);
    this.logger.log('[createRecord] END');
    return record;
  }

  async getRecord(filter: BaseWhere<T> = {}, options?: BaseFindOptions): Promise<T | null> {
    return this.repository.findOne(filter, options);
  }

  async getRecords(filter: BaseWhere<T> = {}, options?: BaseFindOptions): Promise<T[]> {
    return this.repository.findMany(filter, options);
  }

  async getRecordsWithPagination(
    filter: BaseWhere<T> = {},
    options?: BaseFindOptions,
  ): Promise<PaginationResult<T>> {
    this.logger.log('[getRecordsWithPagination] START');
    const result = await this.repository.findManyWithPagination(filter, options);
    this.logger.log('[getRecordsWithPagination] END');
    return result;
  }

  async updateRecord(filter: BaseWhere<T>, dto: Partial<T>, options?: BaseFindOptions): Promise<T | null> {
    this.logger.log('[updateRecord] START');
    const record = await this.repository.update(filter, dto, options);
    this.logger.log('[updateRecord] END');
    return record;
  }

  async deleteRecord(filter: BaseWhere<T>, options?: BaseFindOptions): Promise<boolean> {
    this.logger.log('[deleteRecord] START');
    const result = await this.repository.softDelete(filter, options);
    this.logger.log('[deleteRecord] END');
    return result;
  }

  async deleteRecords(filter: BaseWhere<T>, options?: BaseFindOptions): Promise<boolean> {
    this.logger.log('[deleteRecords] START');
    const result = await this.repository.softDeleteMany(filter, options);
    this.logger.log('[deleteRecords] END');
    return result;
  }
}
