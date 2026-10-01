import {
  Between,
  FindOptionsOrder,
  FindOptionsRelations,
  FindOptionsWhere,
  IsNull,
  LessThanOrEqual,
  MoreThanOrEqual,
  QueryDeepPartialEntity,
  Raw,
  Repository,
} from 'typeorm';
import { AbstractBaseEntity } from '../abstract-base.entity';
import {
  BaseFindOptions,
  IBaseRepository,
  PaginationResult,
  QueryRange,
  RelationOptions,
  SortDirection,
} from './abstract-base.repository';

const DEFAULT_LIMIT = 10;
const DEFAULT_SORT_FIELD = 'createdAt';

/**
 * Repository nền cho mọi entity.
 *
 * Giữ nguyên ngữ nghĩa của bản Mongoose trước đây: mọi filter luôn được chèn
 * thêm `isDeleted: false`, `limit` mặc định là 10, sort mặc định là
 * `createdAt DESC`, và các method đọc trả về plain object chứ không phải entity.
 */
export abstract class TypeormBaseRepository<T extends AbstractBaseEntity> implements IBaseRepository<T> {
  constructor(protected readonly repository: Repository<T>) {}

  protected parseOptions(options?: BaseFindOptions) {
    return {
      relations: [] as RelationOptions,
      sort: { [DEFAULT_SORT_FIELD]: -1 } as Record<string, SortDirection> | string,
      limit: DEFAULT_LIMIT,
      skip: 0,
      search: undefined as string | undefined,
      searchFields: [] as string[],
      ranges: undefined as Record<string, QueryRange> | undefined,
      ...options,
    };
  }

  /** Tên các cột hợp lệ của entity, dùng để chặn field lạ lọt vào SQL. */
  protected get columnNames(): Set<string> {
    return new Set(this.repository.metadata.columns.map((column) => column.propertyName));
  }

  /**
   * Loại bỏ `undefined` (Mongoose trước đây bỏ qua im lặng, còn TypeORM 1.x mặc
   * định ném lỗi) và chuyển `null` thành `IsNull()`.
   */
  protected sanitize(filter?: FindOptionsWhere<T>): FindOptionsWhere<T> {
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(filter ?? {})) {
      if (value === undefined) continue;
      result[key] = value === null ? IsNull() : value;
    }

    return result as FindOptionsWhere<T>;
  }

  protected buildWhere(
    filter: FindOptionsWhere<T> = {},
    search?: string,
    searchFields?: string[],
    ranges?: Record<string, QueryRange>,
  ): FindOptionsWhere<T> | FindOptionsWhere<T>[] {
    const base = { ...this.sanitize(filter), isDeleted: false } as Record<string, unknown>;

    if (ranges) {
      for (const [field, range] of Object.entries(ranges)) {
        if (!this.columnNames.has(field)) continue;

        if (range.min !== undefined && range.max !== undefined) {
          base[field] = Between(range.min, range.max);
        } else if (range.min !== undefined) {
          base[field] = MoreThanOrEqual(range.min);
        } else if (range.max !== undefined) {
          base[field] = LessThanOrEqual(range.max);
        }
      }
    }

    const fields = (searchFields ?? []).filter((field) => this.columnNames.has(field));

    if (search && fields.length) {
      const pattern = `%${this.escapeLike(search)}%`;

      return fields.map(
        (field) =>
          ({
            ...base,
            [field]: Raw((alias) => `${alias} LIKE :pattern ESCAPE '\\'`, { pattern }),
          }) as FindOptionsWhere<T>,
      );
    }

    return base as FindOptionsWhere<T>;
  }

  /** Escape ký tự đại diện của LIKE để từ khoá tìm kiếm được hiểu là văn bản thuần. */
  protected escapeLike(value: string): string {
    return value.replace(/[\\%_]/g, (char) => `\\${char}`);
  }

  protected toOrder(sort?: Record<string, SortDirection> | string): FindOptionsOrder<T> {
    const order: Record<string, 'ASC' | 'DESC'> = {};
    const columns = this.columnNames;

    const push = (field: string, direction: unknown) => {
      if (!field || !columns.has(field)) return;

      const normalized =
        typeof direction === 'string' || typeof direction === 'number' ? String(direction).toLowerCase() : 'asc';

      order[field] = normalized === 'asc' || normalized === '1' ? 'ASC' : 'DESC';
    };

    if (typeof sort === 'string') {
      for (const clause of sort.split(',')) {
        const [field, direction] = clause.trim().split(/[:\s]+/);
        push(field, direction);
      }
    } else if (sort) {
      for (const [field, direction] of Object.entries(sort)) push(field, direction);
    }

    if (!Object.keys(order).length) order[DEFAULT_SORT_FIELD] = 'DESC';

    return order as FindOptionsOrder<T>;
  }

  protected toRelations(relations?: RelationOptions): FindOptionsRelations<T> | undefined {
    if (!relations) return undefined;

    const result: Record<string, boolean> = {};

    if (Array.isArray(relations)) {
      for (const name of relations) result[name] = true;
    } else {
      Object.assign(result, relations);
    }

    return Object.keys(result).length ? (result as FindOptionsRelations<T>) : undefined;
  }

  /** Chỉ giữ lại những field thực sự là cột, bỏ quan hệ và field không xác định. */
  protected pickColumns(data: Partial<T>): Record<string, unknown> {
    const columns = this.columnNames;
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(data ?? {})) {
      if (value === undefined) continue;
      if (!columns.has(key)) continue;
      result[key] = value;
    }

    return result;
  }

  /** Caller luôn nhận plain object, không phải entity instance. */
  protected toPlain(entity: T): T {
    return { ...entity };
  }

  async create(data: Partial<T>): Promise<T> {
    const base = data as Partial<AbstractBaseEntity>;

    const entity = this.repository.create({
      ...this.pickColumns(data),
      createdAt: base.createdAt ?? Date.now(),
      isDeleted: base.isDeleted ?? false,
    } as unknown as T);

    const saved = await this.repository.save(entity);

    return this.toPlain(saved);
  }

  async findOne(filter: FindOptionsWhere<T> = {}, options?: BaseFindOptions): Promise<T | null> {
    const { relations, sort, search, searchFields, ranges } = this.parseOptions(options);

    const result = await this.repository.findOne({
      where: this.buildWhere(filter, search, searchFields, ranges),
      relations: this.toRelations(relations),
      order: this.toOrder(sort),
    });

    return result ? this.toPlain(result) : null;
  }

  async findMany(filter: FindOptionsWhere<T> = {}, options?: BaseFindOptions): Promise<T[]> {
    const { relations, sort, limit, skip, search, searchFields, ranges } = this.parseOptions(options);

    const result = await this.repository.find({
      where: this.buildWhere(filter, search, searchFields, ranges),
      relations: this.toRelations(relations),
      order: this.toOrder(sort),
      take: limit,
      skip,
    });

    return result.map((item) => this.toPlain(item));
  }

  async findManyWithPagination(
    filter: FindOptionsWhere<T> = {},
    options?: BaseFindOptions,
  ): Promise<PaginationResult<T>> {
    const finalOptions = this.parseOptions(options);
    const page = options?.page || 1;
    const { relations, sort, limit, search, searchFields, ranges } = finalOptions;

    const [hits, total] = await this.repository.findAndCount({
      where: this.buildWhere(filter, search, searchFields, ranges),
      relations: this.toRelations(relations),
      order: this.toOrder(sort),
      take: limit,
      skip: (page - 1) * limit,
    });

    return {
      hits: hits.map((item) => this.toPlain(item)),
      total,
      page,
      totalPages: Math.ceil(total / limit),
      limit,
    };
  }

  async update(filter: FindOptionsWhere<T>, data: Partial<T>, options?: BaseFindOptions): Promise<T | null> {
    const { relations } = this.parseOptions(options);

    const existing = await this.repository.findOne({ where: this.buildWhere(filter) });
    if (!existing) return null;

    await this.repository.update(
      { id: existing.id } as FindOptionsWhere<T>,
      {
        ...this.pickColumns(data),
        updatedAt: Date.now(),
      } as unknown as QueryDeepPartialEntity<T>,
    );

    const updated = await this.repository.findOne({
      where: { id: existing.id } as FindOptionsWhere<T>,
      relations: this.toRelations(relations),
    });

    return updated ? this.toPlain(updated) : null;
  }

  /**
   * Soft delete. Trả về `true` khi có ít nhất một dòng thực sự bị sửa
   * (giống `modifiedCount > 0` của Mongoose trước đây).
   */
  async softDelete(filter: FindOptionsWhere<T>): Promise<boolean> {
    return this.applySoftDelete(filter);
  }

  async softDeleteMany(filter: FindOptionsWhere<T>): Promise<boolean> {
    return this.applySoftDelete(filter);
  }

  private async applySoftDelete(filter: FindOptionsWhere<T>): Promise<boolean> {
    const result = await this.repository.update(
      { ...this.sanitize(filter), isDeleted: false } as FindOptionsWhere<T>,
      { isDeleted: true, updatedAt: Date.now() } as unknown as QueryDeepPartialEntity<T>,
    );

    return (result.affected ?? 0) > 0;
  }
}
