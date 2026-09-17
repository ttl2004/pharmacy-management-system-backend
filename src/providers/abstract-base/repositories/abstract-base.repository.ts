import { ClientSession, FilterQuery, PopulateOptions, SortOrder } from 'mongoose';

export interface QueryRange {
  min?: unknown;
  max?: unknown;
}

export interface BaseFindOptions {
  page?: number;
  limit?: number;
  skip?: number;
  sort?: Record<string, SortOrder> | string;
  search?: string;
  searchFields?: string[];
  ranges?: Record<string, QueryRange>;
  populate?: Array<string | PopulateOptions>;
  session?: ClientSession | null;
}

export interface PaginationResult<T> {
  hits: T[];
  total: number;
  page: number;
  totalPages: number;
  limit: number;
}

export interface IBaseRepository<T> {
  create(data: Partial<T>, session?: ClientSession | null): Promise<T>;
  findOne(filter?: FilterQuery<T>, options?: BaseFindOptions): Promise<T | null>;
  findMany(filter?: FilterQuery<T>, options?: BaseFindOptions): Promise<T[]>;
  findManyWithPagination(filter?: FilterQuery<T>, options?: BaseFindOptions): Promise<PaginationResult<T>>;
  update(filter: FilterQuery<T>, data: Partial<T>, options?: BaseFindOptions): Promise<T | null>;
  softDelete(filter: FilterQuery<T>, options?: BaseFindOptions): Promise<boolean>;
  softDeleteMany(filter: FilterQuery<T>, options?: BaseFindOptions): Promise<boolean>;
}
