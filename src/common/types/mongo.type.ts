import { ClientSession, PopulateOptions, ProjectionType, QueryOptions } from 'mongoose';

export interface IFindOptions<T> {
  populate?: PopulateOptions | PopulateOptions[];
  sort?: QueryOptions['sort'];
  limit?: number;
  skip?: number;
  lean?: boolean;
  session?: ClientSession | null;
}

export interface ExtendedOptions {
  search?: string;
  searchFields?: string[];
  ranges?: Record<string, { min?: any; max?: any }>;
}

export type PaginateOpts<T> = {
  page?: number;
  limit?: number;
  sort?: QueryOptions['sort'];
  populate?: PopulateOptions | PopulateOptions[];
  lean?: boolean;
  session?: ClientSession | null;
} & ExtendedOptions;
