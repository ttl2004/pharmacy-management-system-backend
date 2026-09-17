import { Logger } from '@nestjs/common';
import { ClientSession, FilterQuery } from 'mongoose';
import { BaseFindOptions, IBaseRepository, PaginationResult } from './repositories/abstract-base.repository';

export abstract class AbstractBaseService<T> {
  protected readonly logger = new Logger(AbstractBaseService.name);

  constructor(protected readonly repository: IBaseRepository<T>) {}

  async createRecord(dto: Partial<T>, session?: ClientSession | null): Promise<T> {
    this.logger.log('[createRecord] START');
    const record = await this.repository.create(dto, session);
    this.logger.log('[createRecord] END');
    return record;
  }

  async getRecord(filter: FilterQuery<T> = {}, options?: BaseFindOptions): Promise<T | null> {
    return this.repository.findOne(filter, options);
  }

  async getRecords(filter: FilterQuery<T> = {}, options?: BaseFindOptions): Promise<T[]> {
    return this.repository.findMany(filter, options);
  }

  async getRecordsWithPagination(
    filter: FilterQuery<T> = {},
    options?: BaseFindOptions,
  ): Promise<PaginationResult<T>> {
    this.logger.log('[getRecordsWithPagination] START');
    const result = await this.repository.findManyWithPagination(filter, options);
    this.logger.log('[getRecordsWithPagination] END');
    return result;
  }

  async updateRecord(filter: FilterQuery<T>, dto: Partial<T>, options?: BaseFindOptions): Promise<T | null> {
    this.logger.log('[updateRecord] START');
    const record = await this.repository.update(filter, dto, options);
    this.logger.log('[updateRecord] END');
    return record;
  }

  async deleteRecord(filter: FilterQuery<T>, options?: BaseFindOptions): Promise<boolean> {
    this.logger.log('[deleteRecord] START');
    const result = await this.repository.softDelete(filter, options);
    this.logger.log('[deleteRecord] END');
    return result;
  }

  async deleteRecords(filter: FilterQuery<T>, options?: BaseFindOptions): Promise<boolean> {
    this.logger.log('[deleteRecords] START');
    const result = await this.repository.softDeleteMany(filter, options);
    this.logger.log('[deleteRecords] END');
    return result;
  }
}
