import { Prisma, PrismaClient } from '@prisma/client';
import {
  BaseFindOptions,
  BaseRecord,
  BaseWhere,
  IBaseRepository,
  PaginationResult,
  QueryRange,
  RelationOptions,
  SortDirection,
} from './abstract-base.repository';

const DEFAULT_LIMIT = 10;
const DEFAULT_SORT_FIELD = 'createdAt';

/** Prisma không expose kiểu chung cho mọi delegate; đây là phần tối thiểu base cần. */
interface Delegate {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
  findFirst(args: Record<string, unknown>): Promise<unknown>;
  findMany(args: Record<string, unknown>): Promise<unknown[]>;
  count(args: Record<string, unknown>): Promise<number>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

/**
 * Repository nền cho mọi model Prisma.
 *
 * Giữ nguyên ngữ nghĩa của bản TypeORM trước đây: mọi filter luôn được chèn thêm
 * `isDeleted: false`, `limit` mặc định là 10, sort mặc định là `createdAt DESC`,
 * và các method đọc trả về plain object.
 */
export abstract class PrismaBaseRepository<T extends BaseRecord> implements IBaseRepository<T> {
  constructor(
    protected readonly prisma: PrismaClient,
    private readonly modelName: Prisma.ModelName,
  ) {}

  /** Delegate của model, ví dụ `prisma.user` cho `'User'`. */
  protected get delegate(): Delegate {
    const key = this.modelName.charAt(0).toLowerCase() + this.modelName.slice(1);
    return (this.prisma as unknown as Record<string, Delegate>)[key];
  }

  private columns?: Set<string>;

  /** Tên các cột hợp lệ của model, dùng để chặn field lạ lọt vào truy vấn. */
  protected get columnNames(): Set<string> {
    if (!this.columns) {
      const model = Prisma.dmmf.datamodel.models.find((item) => item.name === this.modelName);
      this.columns = new Set(
        (model?.fields ?? []).filter((field) => field.kind === 'scalar').map((field) => field.name),
      );
    }
    return this.columns;
  }

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

  /** Bỏ `undefined` (Prisma ném lỗi với giá trị này); `null` giữ nguyên vì Prisma hiểu là IS NULL. */
  protected sanitize(filter?: BaseWhere<T>): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(filter ?? {})) {
      if (value === undefined) continue;
      result[key] = value;
    }

    return result;
  }

  protected buildWhere(
    filter: BaseWhere<T> = {},
    search?: string,
    searchFields?: string[],
    ranges?: Record<string, QueryRange>,
  ): Record<string, unknown> {
    const base = { ...this.sanitize(filter), isDeleted: false } as Record<string, unknown>;

    if (ranges) {
      for (const [field, range] of Object.entries(ranges)) {
        if (!this.columnNames.has(field)) continue;

        const condition: Record<string, unknown> = {};
        if (range.min !== undefined) condition.gte = range.min;
        if (range.max !== undefined) condition.lte = range.max;
        if (Object.keys(condition).length) base[field] = condition;
      }
    }

    const fields = (searchFields ?? []).filter((field) => this.columnNames.has(field));

    if (search && fields.length) {
      const value = this.escapeLike(search);
      return { AND: [base, { OR: fields.map((field) => ({ [field]: { contains: value } })) }] };
    }

    return base;
  }

  /** Escape ký tự đại diện của LIKE để từ khoá tìm kiếm được hiểu là văn bản thuần. */
  protected escapeLike(value: string): string {
    return value.replace(/[\\%_]/g, (char) => `\\${char}`);
  }

  protected toOrder(sort?: Record<string, SortDirection> | string): Record<string, 'asc' | 'desc'>[] {
    const order: Record<string, 'asc' | 'desc'>[] = [];
    const columns = this.columnNames;

    const push = (field: string, direction: unknown) => {
      if (!field || !columns.has(field)) return;

      const normalized =
        typeof direction === 'string' || typeof direction === 'number' ? String(direction).toLowerCase() : 'asc';

      order.push({ [field]: normalized === 'asc' || normalized === '1' ? 'asc' : 'desc' });
    };

    if (typeof sort === 'string') {
      for (const clause of sort.split(',')) {
        const [field, direction] = clause.trim().split(/[:\s]+/);
        push(field, direction);
      }
    } else if (sort) {
      for (const [field, direction] of Object.entries(sort)) push(field, direction);
    }

    if (!order.length) order.push({ [DEFAULT_SORT_FIELD]: 'desc' });

    return order;
  }

  protected toInclude(relations?: RelationOptions): Record<string, boolean> | undefined {
    if (!relations) return undefined;

    const result: Record<string, boolean> = {};

    if (Array.isArray(relations)) {
      for (const name of relations) result[name] = true;
    } else {
      Object.assign(result, relations);
    }

    return Object.keys(result).length ? result : undefined;
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
  protected toPlain(row: unknown): T {
    return { ...(row as T) };
  }

  async create(data: Partial<T>): Promise<T> {
    const base = data as Partial<BaseRecord>;

    const created = await this.delegate.create({
      data: {
        ...this.pickColumns(data),
        createdAt: base.createdAt ?? new Date(),
        isDeleted: base.isDeleted ?? false,
      },
    });

    return this.toPlain(created);
  }

  async findOne(filter: BaseWhere<T> = {}, options?: BaseFindOptions): Promise<T | null> {
    const { relations, sort, search, searchFields, ranges } = this.parseOptions(options);

    const row = await this.delegate.findFirst({
      where: this.buildWhere(filter, search, searchFields, ranges),
      include: this.toInclude(relations),
      orderBy: this.toOrder(sort),
    });

    return row ? this.toPlain(row) : null;
  }

  async findMany(filter: BaseWhere<T> = {}, options?: BaseFindOptions): Promise<T[]> {
    const { relations, sort, limit, skip, search, searchFields, ranges } = this.parseOptions(options);

    const rows = await this.delegate.findMany({
      where: this.buildWhere(filter, search, searchFields, ranges),
      include: this.toInclude(relations),
      orderBy: this.toOrder(sort),
      take: limit,
      skip,
    });

    return rows.map((row) => this.toPlain(row));
  }

  async findManyWithPagination(
    filter: BaseWhere<T> = {},
    options?: BaseFindOptions,
  ): Promise<PaginationResult<T>> {
    const finalOptions = this.parseOptions(options);
    const page = options?.page || 1;
    const { relations, sort, limit, search, searchFields, ranges } = finalOptions;
    const where = this.buildWhere(filter, search, searchFields, ranges);

    const [rows, total] = await Promise.all([
      this.delegate.findMany({
        where,
        include: this.toInclude(relations),
        orderBy: this.toOrder(sort),
        take: limit,
        skip: (page - 1) * limit,
      }),
      this.delegate.count({ where }),
    ]);

    return {
      hits: rows.map((row) => this.toPlain(row)),
      total,
      page,
      totalPages: Math.ceil(total / limit),
      limit,
    };
  }

  async update(filter: BaseWhere<T>, data: Partial<T>, options?: BaseFindOptions): Promise<T | null> {
    const { relations } = this.parseOptions(options);

    const existing = await this.delegate.findFirst({ where: this.buildWhere(filter) });
    if (!existing) return null;

    const id = (existing as { id: string }).id;

    await this.delegate.updateMany({
      where: { id },
      data: { ...this.pickColumns(data), updatedAt: new Date() },
    });

    const updated = await this.delegate.findFirst({ where: { id }, include: this.toInclude(relations) });

    return updated ? this.toPlain(updated) : null;
  }

  /**
   * Soft delete. Trả về `true` khi có ít nhất một dòng thực sự bị sửa
   * (giống `affected > 0` của TypeORM trước đây).
   */
  async softDelete(filter: BaseWhere<T>): Promise<boolean> {
    return this.applySoftDelete(filter);
  }

  async softDeleteMany(filter: BaseWhere<T>): Promise<boolean> {
    return this.applySoftDelete(filter);
  }

  private async applySoftDelete(filter: BaseWhere<T>): Promise<boolean> {
    const result = await this.delegate.updateMany({
      where: { ...this.sanitize(filter), isDeleted: false },
      data: { isDeleted: true, updatedAt: new Date() },
    });

    return result.count > 0;
  }
}
