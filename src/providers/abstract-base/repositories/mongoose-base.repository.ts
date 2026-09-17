import { ClientSession, FilterQuery, Model } from 'mongoose';
import { BaseFindOptions, IBaseRepository, PaginationResult } from './abstract-base.repository';

type SoftDeleteFields = {
  isDeleted?: boolean;
  updatedAt?: number;
};

export abstract class MongooseBaseRepository<T extends SoftDeleteFields> implements IBaseRepository<T> {
  constructor(protected readonly model: Model<T>) {}

  protected parseOptions(options?: BaseFindOptions) {
    return {
      populate: [],
      sort: { createdAt: -1 as const },
      limit: 10,
      skip: 0,
      session: null,
      search: undefined,
      searchFields: [],
      ranges: undefined,
      ...options,
    };
  }

  protected buildQuery(
    filter: FilterQuery<T>,
    search?: string,
    searchFields?: string[],
    ranges?: Record<string, { min?: unknown; max?: unknown }>,
  ): FilterQuery<T> {
    const query: FilterQuery<T> = { ...filter, isDeleted: false } as FilterQuery<T>;

    if (search && searchFields?.length) {
      query.$or = searchFields.map((field: string) => ({
        [field]: { $regex: search, $options: 'i' },
      })) as FilterQuery<T>['$or'];
    }

    if (ranges) {
      for (const [field, range] of Object.entries(ranges)) {
        const rangeCondition: Record<string, unknown> = {};
        if (range.min !== undefined) rangeCondition.$gte = range.min;
        if (range.max !== undefined) rangeCondition.$lte = range.max;
        if (Object.keys(rangeCondition).length) {
          (query as Record<string, unknown>)[field] = rangeCondition;
        }
      }
    }

    return query;
  }

  async create(data: Partial<T>, session?: ClientSession | null): Promise<T> {
    const docs = await this.model.create([data], {
      session: session ?? undefined,
    });
    return docs[0].toObject() as unknown as T;
  }

  async findOne(filter: FilterQuery<T> = {}, options?: BaseFindOptions): Promise<T | null> {
    const finalOptions = this.parseOptions(options);
    const { populate, sort, session, search, searchFields, ranges } = finalOptions;
    const query = this.buildQuery(filter, search, searchFields, ranges);

    const result = await this.model
      .findOne(query)
      .populate(populate)
      .sort(sort)
      .lean()
      .session(session);

    return result as T | null;
  }

  async findMany(filter: FilterQuery<T> = {}, options?: BaseFindOptions): Promise<T[]> {
    const finalOptions = this.parseOptions(options);
    const { populate, sort, limit, skip, session, search, searchFields, ranges } = finalOptions;
    const query = this.buildQuery(filter, search, searchFields, ranges);

    const result = await this.model
      .find(query)
      .populate(populate)
      .sort(sort)
      .limit(limit)
      .skip(skip)
      .lean()
      .session(session);

    return result as T[];
  }

  async findManyWithPagination(
    filter: FilterQuery<T> = {},
    options?: BaseFindOptions,
  ): Promise<PaginationResult<T>> {
    const finalOptions = this.parseOptions(options);
    const page = options?.page || 1;
    const { populate, sort, limit, session, search, searchFields, ranges } = finalOptions;
    const query = this.buildQuery(filter, search, searchFields, ranges);

    const [hits, total] = await Promise.all([
      this.model
        .find(query)
        .populate(populate)
        .sort(sort)
        .limit(limit)
        .skip((page - 1) * limit)
        .lean()
        .session(session),
      this.model.countDocuments(query),
    ]);

    return {
      hits: hits as T[],
      total,
      page,
      totalPages: Math.ceil(total / limit),
      limit,
    };
  }

  async update(filter: FilterQuery<T>, data: Partial<T>, options?: BaseFindOptions): Promise<T | null> {
    const session = options?.session ?? null;
    const result = await this.model.findOneAndUpdate(
      { ...filter, isDeleted: false },
      { ...data, updatedAt: Date.now() },
      { new: true, lean: true, session },
    );
    return result as T | null;
  }

  async softDelete(filter: FilterQuery<T>, options?: BaseFindOptions): Promise<boolean> {
    const session = options?.session ?? undefined;
    const result = await this.model.updateOne(
      { ...filter, isDeleted: false },
      { isDeleted: true, updatedAt: Date.now() },
      { session },
    );
    return result.modifiedCount > 0;
  }

  async softDeleteMany(filter: FilterQuery<T>, options?: BaseFindOptions): Promise<boolean> {
    const session = options?.session ?? undefined;
    const result = await this.model.updateMany(
      { ...filter, isDeleted: false },
      { isDeleted: true, updatedAt: Date.now() },
      { session },
    );
    return result.modifiedCount > 0;
  }
}
