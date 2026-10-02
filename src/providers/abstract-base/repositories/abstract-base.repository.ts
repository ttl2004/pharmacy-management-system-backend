export type SortDirection = 'ASC' | 'DESC' | 'asc' | 'desc' | 1 | -1;

export interface QueryRange {
  min?: unknown;
  max?: unknown;
}

/**
 * Danh sách quan hệ cần join, ví dụ `{ user: true }` hoặc `['user']`.
 */
export type RelationOptions = string[] | Record<string, boolean>;

export interface BaseFindOptions {
  page?: number;
  limit?: number;
  skip?: number;
  /**
   * Nhận 3 định dạng:
   * - object: `{ createdAt: -1 }`, `{ createdAt: 'DESC' }`
   * - `'field:asc'` / `'field:desc'` (định dạng của `AbstractBaseQuery`)
   * - `'createdAt DESC'`
   */
  sort?: Record<string, SortDirection> | string;
  search?: string;
  searchFields?: string[];
  ranges?: Record<string, QueryRange>;
  relations?: RelationOptions;
}

export interface PaginationResult<T> {
  hits: T[];
  total: number;
  page: number;
  totalPages: number;
  limit: number;
}

/** Các cột mà mọi bảng nghiệp vụ đều có; cũng là ràng buộc generic của base repository. */
export interface BaseRecord {
  id: string;
  isDeleted: boolean;
  createdAt: Date;
  createdBy: string | null;
  updatedAt: Date | null;
  updatedBy: string | null;
}

/**
 * Điều kiện lọc theo cột. Chỉ ràng buộc tên field, giá trị để mở vì Prisma nhận
 * cả giá trị thô lẫn toán tử (`{ gt: ... }`).
 */
export type BaseWhere<T> = Partial<Record<keyof T & string, unknown>>;

export interface IBaseRepository<T extends BaseRecord> {
  create(data: Partial<T>): Promise<T>;
  findOne(filter?: BaseWhere<T>, options?: BaseFindOptions): Promise<T | null>;
  findMany(filter?: BaseWhere<T>, options?: BaseFindOptions): Promise<T[]>;
  findManyWithPagination(filter?: BaseWhere<T>, options?: BaseFindOptions): Promise<PaginationResult<T>>;
  update(filter: BaseWhere<T>, data: Partial<T>, options?: BaseFindOptions): Promise<T | null>;
  softDelete(filter: BaseWhere<T>, options?: BaseFindOptions): Promise<boolean>;
  softDeleteMany(filter: BaseWhere<T>, options?: BaseFindOptions): Promise<boolean>;
}
