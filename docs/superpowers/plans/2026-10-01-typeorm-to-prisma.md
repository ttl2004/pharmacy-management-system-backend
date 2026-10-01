# Chuyển TypeORM sang Prisma — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thay toàn bộ tầng dữ liệu TypeORM bằng Prisma trên SQLite, xóa hẳn TypeORM, giữ nguyên hành vi API và 40 e2e test.

**Architecture:** Prisma Client bọc trong `PrismaService` (Nest provider toàn cục). Khuôn cũ `TypeormBaseRepository<T>` → `PrismaBaseRepository<T>` dùng delegate động lấy từ `prisma[modelName]`, giữ nguyên interface `IBaseRepository` và `AbstractBaseService`. Tầng transaction (`SessionTransactions`) đổi từ `DataSource.transaction` sang `$transaction`, vẫn serialize tuần tự vì SQLite single-writer.

**Tech Stack:** NestJS 11 + Fastify 5, Prisma 6 (`prisma` + `@prisma/client`), SQLite, Jest + supertest.

**Spec:** `docs/superpowers/specs/2026-10-01-typeorm-to-prisma-design.md`

## Global Constraints

- Database: SQLite, file `data/pos-ndm.sqlite`; `DATABASE_URL="file:../data/pos-ndm.sqlite"` (Prisma CLI resolve tương đối theo `prisma/schema.prisma`).
- Quản schema bằng **Prisma Migrate** (`prisma migrate dev` / `migrate deploy`) — không dùng `db push`.
- Thời gian: `createdAt DateTime @default(now())`; `updatedAt DateTime?` **gán tay khi update**, bản ghi mới có `updatedAt = null` (không dùng `@updatedAt`).
- API contract không đổi: envelope `{ data, errorCode, traceId }`, thời gian ra client là ISO 8601, cookie `Path=/auth`.
- Giữ khuôn `PrismaBaseRepository` + `AbstractBaseService`; mọi filter tự chèn `isDeleted: false`; `limit` mặc định 10; sort mặc định `createdAt DESC`; method đọc trả plain object.
- Xóa hoàn toàn: `typeorm`, `@nestjs/typeorm`, `better-sqlite3`, `@types/better-sqlite3`.
- Bộ test phải xanh: 40 test hiện có + 1 test ghi đồng thời thêm ở Task 5.
- Trong lúc chuyển (Task 2–4) **không chạy `npm run start`** — app chỉ khởi động lại được sau Task 4; mốc kiểm chứng thật là Task 5 và Task 6.

## Review Focus

Năm tình huống spec ngụ ý nhưng không có test sẵn — mỗi dòng đã được gắn test ở task tương ứng:

1. **Từ khóa tìm kiếm chứa `%` hoặc `_`** — người dùng gõ `%` phải ra kết quả rỗng, không phải toàn bộ bảng → test ở Task 2.
2. **Bản ghi vừa tạo** — `updatedAt` phải là `null`, không được tự điền → test ở Task 2.
3. **Sort theo field không tồn tại** — ví dụ `?sort=khongCo:asc` phải rơi về `createdAt DESC`, không được ném lỗi → test ở Task 2.
4. **Ghi đồng thời** — hai lần login song song trên SQLite không được lỗi `database is locked` → test ở Task 5.
5. **Filter có giá trị `null`** — `{ createdBy: null }` phải khớp các dòng `IS NULL`, không bị bỏ qua như `undefined` → test ở Task 2.

---

### Task 1: Nền tảng Prisma (deps, schema, migration, PrismaService)

**Files:**
- Modify: `package.json`
- Modify: `.env`, `.env.example`
- Modify: `src/common/configs/env.validation.ts`
- Modify: `src/common/configs/configuration.ts`
- Create: `prisma/schema.prisma`
- Create: `prisma/migrations/**` (sinh tự động)
- Create: `src/common/databases/prisma.service.ts`
- Create: `src/common/databases/drivers/prisma.module.ts`

**Interfaces:**
- Consumes: không (task đầu)
- Produces: `PrismaService` (extends `PrismaClient`, injectable), `PrismaDatabaseModule.forRoot(): DynamicModule` (global, export `PrismaService`), config key `database.url` (string), config key `database.logging` (boolean, đã có)

- [ ] **Step 1: Cài dependency Prisma**

```bash
npm install @prisma/client
npm install -D prisma
```

- [ ] **Step 2: Viết `prisma/schema.prisma`**

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}

model User {
  id           String    @id @default(uuid())
  isDeleted    Boolean   @default(false)
  createdAt    DateTime  @default(now())
  createdBy    String?
  updatedAt    DateTime?
  updatedBy    String?
  phoneNumber  String?
  email        String    @unique
  address      String?
  fullName     String
  age          String?
  gender       String?
  status       String    @default("active")
  role         String
  permissionId String?

  auths         Auth[]
  refreshTokens RefreshToken[]

  @@map("users")
}

model Auth {
  id        String    @id @default(uuid())
  isDeleted Boolean   @default(false)
  createdAt DateTime  @default(now())
  createdBy String?
  updatedAt DateTime?
  updatedBy String?
  password  String
  username  String    @unique
  userId    String
  user      User      @relation(fields: [userId], references: [id])

  @@map("auths")
}

model RefreshToken {
  id           String    @id @default(uuid())
  userId       String
  user         User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  sid          String
  tokenHash    String    @unique
  expiresAt    DateTime
  revokedAt    DateTime?
  replacedById String?
  userAgent    String?
  ip           String?
  createdAt    DateTime  @default(now())
  lastUsedAt   DateTime?

  @@index([userId, sid])
  @@index([sid])
  @@map("refresh_tokens")
}
```

- [ ] **Step 3: Thêm `DATABASE_URL` vào `.env` và `.env.example`**

Thêm dòng sau vào cả hai file (giữ `DB_DATABASE`/`DB_SYNCHRONIZE` tạm — xóa ở Task 4):

```
# Đường dẫn tương đối theo prisma/schema.prisma, KHÔNG phải theo thư mục gốc dự án.
DATABASE_URL="file:../data/pos-ndm.sqlite"
```

- [ ] **Step 4: Thêm `DATABASE_URL` vào `env.validation.ts`**

Trong `envSchema.object({...})`, thêm ngay dưới `DB_LOGGING`:

```ts
    DATABASE_URL: z.string().min(1, 'DATABASE_URL không được để trống'),
```

- [ ] **Step 5: Thêm `url` vào `configuration.ts`**

Thay khối `database` thành:

```ts
    database: {
      url: env.DATABASE_URL,
      path: env.DB_DATABASE,
      synchronize: env.DB_SYNCHRONIZE === 'true',
      logging: env.DB_LOGGING === 'true',
    },
```

(`path`/`synchronize` là tạm thời cho TypeORM đang còn chạy — Task 4 xóa.)

- [ ] **Step 6: Xóa DB cũ và tạo migration đầu tiên**

Người dùng đã đồng ý bỏ dữ liệu cũ (1 super-admin + token test).

```bash
rm -f data/pos-ndm.sqlite
npx prisma migrate dev --name init
```

Expected: `Your database is now in sync with your schema.` và sinh thư mục `prisma/migrations/<timestamp>_init/migration.sql`.

- [ ] **Step 7: Kiểm chứng DB được tạo đúng chỗ và đủ bảng**

```bash
ls -la data/pos-ndm.sqlite
node -e "const D=require('better-sqlite3');const db=new D('data/pos-ndm.sqlite',{readonly:true});console.log(db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name\").all().map(r=>r.name).join(', '))"
```

Expected: file tồn tại trong `data/`, và in ra `_prisma_migrations, auths, refresh_tokens, users`.
Nếu file nằm sai chỗ (ví dụ `prisma/data/`), dừng lại và báo — nghĩa là Prisma CLI resolve khác giả định, phải sửa `DATABASE_URL` trước khi đi tiếp.

- [ ] **Step 8: Viết `src/common/databases/prisma.service.ts`**

```ts
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { mkdirSync } from 'fs';
import { dirname, resolve } from 'path';

/**
 * Prisma Client dưới dạng provider của Nest.
 *
 * `DATABASE_URL` dạng `file:../data/pos-ndm.sqlite` được Prisma CLI hiểu là tương đối
 * theo thư mục `prisma/`. Ở runtime, đường dẫn được đổi thành tuyệt đối để không phụ
 * thuộc vào cách Prisma Client resolve đường dẫn tương đối.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(config: ConfigService) {
    const url = config.getOrThrow<string>('database.url');
    const absolutePath = PrismaService.toAbsoluteSqlitePath(url);

    // SQLite không tự tạo thư mục cha; thiếu thư mục sẽ chỉ báo lỗi chung chung
    // "unable to open database file".
    if (absolutePath) mkdirSync(dirname(absolutePath), { recursive: true });

    super({
      datasourceUrl: absolutePath ? `file:${absolutePath}` : url,
      log: config.get<boolean>('database.logging') ? ['query', 'warn', 'error'] : ['warn', 'error'],
    });
  }

  /** Đường dẫn tuyệt đối cho URL `file:` tương đối (theo thư mục prisma/); null nếu không phải file. */
  private static toAbsoluteSqlitePath(url: string): string | null {
    if (!url.startsWith('file:')) return null;
    const path = url.slice('file:'.length);
    if (!path || path.startsWith(':memory:')) return null;
    return resolve(process.cwd(), 'prisma', path);
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
```

- [ ] **Step 9: Viết `src/common/databases/drivers/prisma.module.ts`**

```ts
import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from '../prisma.service';

@Module({})
export class PrismaDatabaseModule {
  static forRoot(): DynamicModule {
    return {
      module: PrismaDatabaseModule,
      global: true,
      imports: [ConfigModule],
      providers: [PrismaService],
      exports: [PrismaService],
    };
  }
}
```

- [ ] **Step 10: Kiểm tra build vẫn xanh**

```bash
npm run build
```

Expected: `Found 0 issues` + `Successfully compiled`. (Task này chưa đụng code cũ nên phải xanh.)

- [ ] **Step 11: Commit**

```bash
git add package.json package-lock.json prisma .env.example src/common/configs/env.validation.ts src/common/configs/configuration.ts src/common/databases/prisma.service.ts src/common/databases/drivers/prisma.module.ts
git commit -m "feat: thêm Prisma - schema, migration đầu tiên và PrismaService

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

(`.env` không commit — đã nằm trong `.gitignore`.)

---

### Task 2: PrismaBaseRepository + BaseRecord

**Files:**
- Modify: `src/providers/abstract-base/repositories/abstract-base.repository.ts`
- Create: `src/providers/abstract-base/repositories/prisma-base.repository.ts`
- Create: `test/prisma-base.repository.e2e-spec.ts`

**Interfaces:**
- Consumes: `PrismaService` (Task 1), schema `User` (Task 1)
- Produces:
  - `interface BaseRecord { id: string; isDeleted: boolean; createdAt: Date; createdBy: string | null; updatedAt: Date | null; updatedBy: string | null }`
  - `type BaseWhere<T> = Partial<Record<keyof T & string, unknown>>`
  - `interface IBaseRepository<T extends BaseRecord>` (giữ nguyên 7 method)
  - `abstract class PrismaBaseRepository<T extends BaseRecord>` constructor `(prisma: PrismaClient, modelName: Prisma.ModelName)`, có `protected readonly prisma`, `protected get columnNames(): Set<string>`

- [ ] **Step 1: Viết test thất bại `test/prisma-base.repository.e2e-spec.ts`**

```ts
import { execSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PrismaClient, User } from '@prisma/client';
import { PrismaBaseRepository } from '../src/providers/abstract-base/repositories/prisma-base.repository';
import { AuthRole, RecordStatusEnum } from '../src/common/types/common.enum';

class UserTestRepository extends PrismaBaseRepository<User> {
  constructor(prisma: PrismaClient) {
    super(prisma, 'User');
  }
}

describe('PrismaBaseRepository', () => {
  let dir: string;
  let prisma: PrismaClient;
  let repo: UserTestRepository;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'pos-ndm-repo-'));
    execSync('npx prisma migrate deploy', {
      env: { ...process.env, DATABASE_URL: `file:${join(dir, 'test.sqlite')}` },
      stdio: 'inherit',
    });
    prisma = new PrismaClient({ datasourceUrl: `file:${join(dir, 'test.sqlite')}` });
    repo = new UserTestRepository(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await prisma.user.deleteMany();
  });

  let seq = 0;
  const makeUser = (over: Partial<User> = {}): Partial<User> => ({
    email: `user${++seq}@test.local`,
    fullName: 'Người dùng thử',
    role: AuthRole.MEMBER,
    status: RecordStatusEnum.ACTIVE,
    ...over,
  });

  it('create gán createdAt và isDeleted, để updatedAt null', async () => {
    const user = await repo.create(makeUser());
    expect(user.isDeleted).toBe(false);
    expect(user.createdAt).toBeInstanceOf(Date);
    expect(user.updatedAt).toBeNull();
  });

  it('find bỏ qua bản ghi đã soft delete', async () => {
    const user = await repo.create(makeUser());
    await repo.softDelete({ id: user.id });

    expect(await repo.findOne({ id: user.id })).toBeNull();
    expect(await repo.findMany({})).toHaveLength(0);
  });

  it('softDelete trả false khi không có dòng nào bị sửa', async () => {
    expect(await repo.softDelete({ id: 'khong-ton-tai' })).toBe(false);
  });

  it('update gán updatedAt và trả bản ghi mới; trả null khi không khớp', async () => {
    const user = await repo.create(makeUser());
    const updated = await repo.update({ id: user.id }, { fullName: 'Tên mới' });

    expect(updated?.fullName).toBe('Tên mới');
    expect(updated?.updatedAt).toBeInstanceOf(Date);
    expect(await repo.update({ id: 'khong-ton-tai' }, { fullName: 'X' })).toBeNull();
  });

  it('tìm kiếm coi % và _ là văn bản thuần', async () => {
    await repo.create(makeUser({ fullName: 'Nguyễn Văn A' }));
    await repo.create(makeUser({ fullName: 'Nguyễn Văn B' }));
    await repo.create(makeUser({ fullName: 'Trần Thị C' }));

    const found = await repo.findMany({}, { search: 'Văn', searchFields: ['fullName'] });
    expect(found).toHaveLength(2);

    expect(await repo.findMany({}, { search: '%', searchFields: ['fullName'] })).toHaveLength(0);
    expect(await repo.findMany({}, { search: '_', searchFields: ['fullName'] })).toHaveLength(0);
  });

  it('sort mặc định createdAt DESC, bỏ qua field không tồn tại', async () => {
    const first = await repo.create(makeUser({ createdAt: new Date('2026-01-01T00:00:00Z') }));
    const second = await repo.create(makeUser({ createdAt: new Date('2026-02-01T00:00:00Z') }));

    expect((await repo.findMany({})).map((u) => u.id)).toEqual([second.id, first.id]);
    expect((await repo.findMany({}, { sort: 'khongCoField:asc' })).map((u) => u.id)).toEqual([second.id, first.id]);
    expect((await repo.findMany({}, { sort: 'email:asc' })).map((u) => u.email)).toEqual(
      [first.email, second.email].sort(),
    );
  });

  it('lọc theo null là IS NULL, không bị bỏ qua', async () => {
    await repo.create(makeUser({ createdBy: 'admin' }));
    const anonymous = await repo.create(makeUser());

    const result = await repo.findMany({ createdBy: null });
    expect(result.map((u) => u.id)).toEqual([anonymous.id]);
  });

  it('ranges lọc theo min/max', async () => {
    await repo.create(makeUser({ createdAt: new Date('2026-01-01T00:00:00Z') }));
    const mid = await repo.create(makeUser({ createdAt: new Date('2026-02-01T00:00:00Z') }));
    await repo.create(makeUser({ createdAt: new Date('2026-03-01T00:00:00Z') }));

    const result = await repo.findMany(
      {},
      { ranges: { createdAt: { min: new Date('2026-01-15T00:00:00Z'), max: new Date('2026-02-15T00:00:00Z') } } },
    );
    expect(result.map((u) => u.id)).toEqual([mid.id]);
  });

  it('phân trang trả hits, total, totalPages', async () => {
    for (let i = 0; i < 3; i++) await repo.create(makeUser());

    const page1 = await repo.findManyWithPagination({}, { limit: 2, page: 1 });
    expect(page1.hits).toHaveLength(2);
    expect(page1.total).toBe(3);
    expect(page1.totalPages).toBe(2);
    expect(page1.page).toBe(1);
    expect(page1.limit).toBe(2);
  });
});
```

- [ ] **Step 2: Chạy test để chắc chắn nó đỏ**

```bash
npx jest --config ./test/jest-e2e.json prisma-base.repository
```

Expected: FAIL — `Cannot find module '../src/providers/abstract-base/repositories/prisma-base.repository'`.

- [ ] **Step 3: Viết lại `abstract-base.repository.ts`**

```ts
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
```

- [ ] **Step 4: Viết `prisma-base.repository.ts`**

```ts
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
```

- [ ] **Step 5: Chạy test**

```bash
npx jest --config ./test/jest-e2e.json prisma-base.repository
```

Expected: PASS toàn bộ. **Nếu test "tìm kiếm coi % và _ là văn bản thuần" đỏ** (nghĩa là Prisma đã tự escape, việc escape thủ công thành hai lần): xóa `const value = this.escapeLike(search);` và dùng thẳng `{ contains: search }`, rồi chạy lại. Chọn đúng một trong hai, không để cả hai.

- [ ] **Step 6: Commit**

```bash
git add src/providers/abstract-base/repositories/abstract-base.repository.ts src/providers/abstract-base/repositories/prisma-base.repository.ts test/prisma-base.repository.e2e-spec.ts
git commit -m "feat: PrismaBaseRepository thay TypeormBaseRepository

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: Chuyển tầng repository/service của feature-auth sang Prisma

**Files:**
- Modify: `src/providers/abstract-base/abstract-base.service.ts`
- Modify: `src/modules/feature-auth/user/repositories/user.repository.ts`
- Modify: `src/modules/feature-auth/authz/repositories/authz.repository.ts`
- Modify: `src/modules/feature-auth/user/user.service.ts`
- Modify: `src/modules/feature-auth/authz/session.store.ts`
- Modify: `src/modules/feature-auth/authz/token.service.ts`
- Modify: `src/modules/feature-auth/authz/password.service.ts`
- Modify: `src/modules/feature-auth/authz/authz.service.ts`
- Modify: `src/modules/feature-auth/authz/strategies/auth.strategy.ts`

**Interfaces:**
- Consumes: `PrismaService` (Task 1); `PrismaBaseRepository` + `BaseWhere` (Task 2)
- Produces: `UserRepository extends PrismaBaseRepository<User>`; `AuthzRepository extends PrismaBaseRepository<Auth>`; `SessionTransactions.write(work: (tx: Prisma.TransactionClient) => Promise<T>)`

- [ ] **Step 1: Sửa `abstract-base.service.ts` — đổi kiểu filter, bỏ import typeorm**

Ba dòng import đầu file cũ:

```ts
import { Logger } from '@nestjs/common';
import { FindOptionsWhere } from 'typeorm';
import { AbstractBaseEntity } from './abstract-base.entity';
import { BaseFindOptions, IBaseRepository, PaginationResult } from './repositories/abstract-base.repository';
```

thay bằng:

```ts
import { Logger } from '@nestjs/common';
import {
  BaseFindOptions,
  BaseRecord,
  BaseWhere,
  IBaseRepository,
  PaginationResult,
} from './repositories/abstract-base.repository';
```

Đổi ràng buộc generic và mọi `FindOptionsWhere<T>` thành `BaseWhere<T>`:

```ts
export abstract class AbstractBaseService<T extends BaseRecord> {
```

Thân các method giữ nguyên.

- [ ] **Step 2: Viết lại `user.repository.ts`**

```ts
import { Injectable } from '@nestjs/common';
import { User } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';
import { PrismaBaseRepository } from 'src/providers/abstract-base/repositories/prisma-base.repository';

@Injectable()
export class UserRepository extends PrismaBaseRepository<User> {
  constructor(prisma: PrismaService) {
    super(prisma, 'User');
  }

  /**
   * Tìm user theo email bất kể đã bị soft delete hay chưa.
   *
   * `findOne()` của base repository luôn chèn `isDeleted: false`, nhưng seed cần
   * nhìn thấy cả bản ghi đã soft delete để không cố tạo trùng — cột `email` là UNIQUE
   * nên lần tạo lại sẽ vi phạm ràng buộc.
   */
  async findByEmailIgnoringSoftDelete(email: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: { email } });
  }
}
```

- [ ] **Step 3: Viết lại `authz.repository.ts`**

```ts
import { Injectable } from '@nestjs/common';
import { Auth, User } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';
import { PrismaBaseRepository } from 'src/providers/abstract-base/repositories/prisma-base.repository';

export type AuthWithUser = Auth & { user: User };

@Injectable()
export class AuthzRepository extends PrismaBaseRepository<Auth> {
  constructor(prisma: PrismaService) {
    super(prisma, 'Auth');
  }

  /**
   * Truy vấn đặc thù của luồng đăng nhập: cần kèm `user` để kiểm tra trạng thái.
   * Dùng thẳng delegate có kiểu của Prisma thay vì `include` động của base.
   */
  findByUsernameWithUser(username: string): Promise<AuthWithUser | null> {
    return this.prisma.auth.findFirst({
      where: { username, isDeleted: false },
      include: { user: true },
    });
  }
}
```

- [ ] **Step 4: Viết lại `session.store.ts`**

```ts
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';

export abstract class SessionStore {
  abstract isActive(sid: string): Promise<boolean>;
  abstract activate(sid: string, userId: string, ttl: number): Promise<void>;
  abstract revoke(sid: string): Promise<void>;
  abstract revokeAllByUser(userId: string): Promise<void>;
}

// SQLite chỉ cho một writer. Thực hiện tuần tự các transaction để tránh
// transaction lồng nhau, xen kẽ giữa các yêu cầu HTTP đồng thời.
@Injectable()
export class SessionTransactions {
  private tail: Promise<unknown> = Promise.resolve();
  revision = 0;
  constructor(private readonly prisma: PrismaService) {}
  read<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => undefined);
    return result;
  }
  write<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.read(async () => {
      try {
        return await this.prisma.$transaction(work);
      } finally {
        this.revision++;
      }
    });
  }
}

@Injectable()
export class DbSessionStore extends SessionStore {
  // Chỉ dùng cho một instance. Nhiều instance cần Redis và cơ chế vô hiệu hóa cache dùng chung.
  private readonly cache = new Map<string, number>();
  private revision = -1;
  constructor(
    private readonly prisma: PrismaService,
    private readonly transactions: SessionTransactions,
  ) {
    super();
  }
  isActive(sid: string): Promise<boolean> {
    return this.transactions.read(async () => {
      if (this.revision !== this.transactions.revision) {
        this.cache.clear();
        this.revision = this.transactions.revision;
      }
      const now = Date.now();
      if ((this.cache.get(sid) ?? 0) > now) return true;
      this.cache.delete(sid);
      const token = await this.prisma.refreshToken.findFirst({
        where: { sid, revokedAt: null, expiresAt: { gt: new Date(now) } },
      });
      if (!token) return false;
      if (this.cache.size >= 10000) this.cache.clear();
      this.cache.set(sid, Math.min(now + 20000, token.expiresAt.getTime()));
      return true;
    });
  }
  activate(sid: string): Promise<void> {
    // Bản ghi refresh đã commit là nguồn xác nhận phiên; không cache trạng thái chưa commit.
    this.cache.delete(sid);
    return Promise.resolve();
  }
  async revoke(sid: string) {
    await this.transactions.write(async (tx) => {
      await tx.refreshToken.updateMany({ where: { sid, revokedAt: null }, data: { revokedAt: new Date() } });
      this.cache.delete(sid);
    });
  }
  async revokeAllByUser(userId: string) {
    await this.transactions.write(async (tx) => {
      await tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
      this.cache.clear();
    });
  }
}
```

- [ ] **Step 5: Viết lại `token.service.ts`**

Giữ nguyên `TokenMetadata`, `TokenPair`, `hash`, phần chữ ký JWT; đổi toàn bộ phần truy vấn:

```ts
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Cron } from '@nestjs/schedule';
import { Auth, Prisma, User } from '@prisma/client';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { AuthConfig } from './auth.config';
import { authError, AuthErrorCode } from './auth.error';
import { SessionStore, SessionTransactions } from './session.store';
import { RecordStatusEnum } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';

export interface TokenMetadata {
  userAgent?: string;
  ip?: string;
}
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class TokenService {
  constructor(
    private readonly transactions: SessionTransactions,
    private readonly sessions: SessionStore,
    private readonly jwt: JwtService,
    private readonly config: AuthConfig,
  ) {}

  private hash(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  private async issue(tx: Prisma.TransactionClient, user: User, sid: string, metadata: TokenMetadata) {
    const raw = randomBytes(64).toString('base64url');
    await tx.refreshToken.create({
      data: {
        userId: user.id,
        sid,
        tokenHash: this.hash(raw),
        expiresAt: new Date(Date.now() + this.config.refreshTtl * 1000),
        revokedAt: null,
        replacedById: null,
        lastUsedAt: null,
        userAgent: metadata.userAgent?.slice(0, 1024) ?? null,
        ip: metadata.ip ?? null,
      },
    });
    const accessToken = await this.jwt.signAsync({ sub: user.id, role: user.role, sid, jti: randomUUID() });
    return { accessToken, refreshToken: raw };
  }

  async login(auth: Auth, metadata: TokenMetadata): Promise<TokenPair> {
    const sid = randomUUID();
    const result = await this.transactions.write(async (tx) => {
      // Kiểm tra lại thông tin đăng nhập sau khi lấy khóa: mật khẩu có thể đã được đổi
      // trong lúc bcrypt đang so sánh với thông tin đăng nhập trước đó.
      const current = await tx.auth.findFirst({ where: { id: auth.id, isDeleted: false } });
      const user = await tx.user.findFirst({
        where: { id: auth.userId, isDeleted: false, status: RecordStatusEnum.ACTIVE },
      });
      if (!current || current.password !== auth.password || !user) throw authError(ErrorCode.LOGIN_INVALID);
      const oldTokens = await tx.refreshToken.findMany({
        where: { userId: user.id, revokedAt: null },
        select: { sid: true },
      });
      await tx.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return {
        pair: await this.issue(tx, user, sid, metadata),
        oldSids: [...new Set(oldTokens.map((token) => token.sid))],
      };
    });
    for (const oldSid of result.oldSids) await this.sessions.revoke(oldSid);
    await this.sessions.activate(sid, auth.userId, this.config.refreshTtl);
    return result.pair;
  }

  async refresh(raw: string | undefined): Promise<{ accessToken: string }> {
    if (!raw) throw authError(ErrorCode.INVALID_TOKEN);
    const result = await this.transactions.write(
      async (tx): Promise<{ accessToken: string } | { error: AuthErrorCode; sid?: string }> => {
        const token = await tx.refreshToken.findFirst({ where: { tokenHash: this.hash(raw) } });
        if (!token) return { error: ErrorCode.INVALID_TOKEN };
        if (token.revokedAt) return { error: ErrorCode.SESSION_REVOKED };
        if (token.expiresAt.getTime() <= Date.now()) return { error: ErrorCode.TOKEN_EXPIRED };
        const now = new Date();
        const user = await tx.user.findFirst({
          where: { id: token.userId, isDeleted: false, status: RecordStatusEnum.ACTIVE },
        });
        if (!user) {
          await tx.refreshToken.updateMany({
            where: { sid: token.sid, revokedAt: null },
            data: { revokedAt: now },
          });
          return { error: ErrorCode.SESSION_REVOKED, sid: token.sid };
        }
        // RT cố định cho cả phiên: chỉ cấp AT mới và cập nhật lần sử dụng.
        // Không tạo bản ghi, không đổi hash, sid hoặc mốc hết hạn của RT.
        const accessToken = await this.jwt.signAsync({
          sub: user.id,
          role: user.role,
          sid: token.sid,
          jti: randomUUID(),
        });
        await tx.refreshToken.updateMany({ where: { id: token.id }, data: { lastUsedAt: now } });
        return { accessToken };
      },
    );
    // Chỉ ném lỗi SAU khi commit; ném lỗi trong transaction sẽ hoàn tác việc thu hồi phiên.
    if ('error' in result) {
      if (result.sid) await this.sessions.revoke(result.sid);
      throw authError(result.error);
    }
    return result;
  }

  async logout(sid: string, raw: string | undefined) {
    await this.transactions.write(async (tx) => {
      const now = new Date();
      if (raw) {
        // Chỉ ghi nhận lần sử dụng khi token khớp. Cookie cũ hoặc thuộc phiên khác không được
        // thu hồi phiên khác hay ngăn đăng xuất sid đã được xác thực.
        await tx.refreshToken.updateMany({ where: { sid, tokenHash: this.hash(raw) }, data: { lastUsedAt: now } });
      }
      await tx.refreshToken.updateMany({ where: { sid, revokedAt: null }, data: { revokedAt: now } });
    });
    await this.sessions.revoke(sid);
  }

  @Cron('0 0 3 * * *')
  async cleanup() {
    await this.transactions.write(async (tx) => {
      const now = new Date();
      const cutoff = new Date(now.getTime() - 30 * 86400000);
      await tx.refreshToken.deleteMany({
        where: { OR: [{ expiresAt: { lt: now } }, { revokedAt: { lt: cutoff } }] },
      });
    });
  }
}
```

- [ ] **Step 6: Viết lại `password.service.ts`**

```ts
import { BadRequestException, Injectable } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from 'src/common/databases/prisma.service';
import { SessionStore, SessionTransactions } from './session.store';
import { ErrorCode } from 'src/common/types/error-code';
import { authError } from './auth.error';
import { JwtUser } from './types/authz.types';
import { ChangePasswordRequest } from './dtos/password.request';

@Injectable()
export class PasswordService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transactions: SessionTransactions,
    private readonly sessions: SessionStore,
  ) {}

  async change(user: JwtUser, dto: ChangePasswordRequest) {
    const credentials = await this.prisma.auth.findFirst({ where: { userId: user.userId, isDeleted: false } });
    if (!credentials || !(await bcrypt.compare(dto.currentPassword, credentials.password)))
      throw authError(ErrorCode.LOGIN_INVALID);
    const hash = await this.hash(dto.newPassword);
    await this.transactions.write(async (tx) => {
      const active = await tx.refreshToken.findFirst({
        where: { sid: user.sid, userId: user.userId, revokedAt: null, expiresAt: { gt: new Date() } },
      });
      if (!active) throw authError(ErrorCode.SESSION_REVOKED);
      const updated = await tx.auth.updateMany({
        where: { id: credentials.id, password: credentials.password },
        data: { password: hash, updatedAt: new Date() },
      });
      if (updated.count !== 1) throw authError(ErrorCode.LOGIN_INVALID);
      await tx.refreshToken.updateMany({
        where: { userId: user.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
    await this.sessions.revokeAllByUser(user.userId);
  }

  // Chỉ dùng nội bộ. Luồng khôi phục sau này phải xác minh bằng chứng khôi phục dùng một lần
  // (hoặc quyền của quản trị viên) TRƯỚC khi gọi phương thức này.
  // Không mở trực tiếp phương thức này thành endpoint HTTP không yêu cầu xác thực.
  async resetPassword(userId: string, newPassword: string) {
    const hash = await this.hash(newPassword);
    await this.transactions.write(async (tx) => {
      const updated = await tx.auth.updateMany({
        where: { userId, isDeleted: false },
        data: { password: hash, updatedAt: new Date() },
      });
      if (!updated.count) throw authError(ErrorCode.LOGIN_INVALID);
      await tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    });
    await this.sessions.revokeAllByUser(userId);
  }

  private async hash(password: string) {
    // bcrypt cắt dữ liệu đầu vào vượt quá 72 byte, kể cả ký tự được mã hóa bằng nhiều byte.
    if (password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) {
      throw new BadRequestException('Mật khẩu phải có ít nhất 8 ký tự và tối đa 72 byte UTF-8');
    }
    return bcrypt.hash(password, 10);
  }
}
```

- [ ] **Step 7: Sửa `authz.service.ts`**

Đổi import `AuthzEntity` → `Auth` từ `@prisma/client`, bỏ import entity cũ. Đổi `extends AbstractBaseService<AuthzEntity>` → `extends AbstractBaseService<Auth>`. Đổi `getAuthzByUsername`:

```ts
  async getAuthzByUsername(username: string) {
    return this.authzRepository.findByUsernameWithUser(username);
  }
```

Phần `login` giữ nguyên (`authz.user` giờ có kiểu đầy đủ nhờ `AuthWithUser`).

- [ ] **Step 8: Sửa `user.service.ts` — đổi `UserEntity` → `User`**

```ts
import { Injectable } from '@nestjs/common';
import { User } from '@prisma/client';
import { AbstractBaseService } from 'src/providers/abstract-base/abstract-base.service';
import { UserRepository } from './repositories/user.repository';

@Injectable()
export class UserService extends AbstractBaseService<User> {
  constructor(private readonly userRepository: UserRepository) {
    super(userRepository);
  }
}
```

- [ ] **Step 9: Sửa `auth.strategy.ts` — chỉ đổi import type**

Bỏ `import { UserRepository } ...` không đổi; chỉ cần đảm bảo không còn import entity TypeORM (file này vốn không import entity). `this.users.findOne({ id: payload.sub })` giữ nguyên — giờ trả `User | null`.

- [ ] **Step 10: Kiểm tra build**

```bash
npm run build
```

Expected: `Found 0 issues`. Nếu còn lỗi import `typeorm` ở các file này, sửa hết trước khi đi tiếp. (Lỗi ở `typeorm.module.ts`, entity files và `test/app.e2e-spec.ts` là **được phép** ở bước này — chúng thuộc Task 4 và 5. Nếu `nest build` kéo cả `test/` thì bỏ qua lỗi ở `test/`.)

- [ ] **Step 11: Commit**

```bash
git add src/providers/abstract-base/abstract-base.service.ts src/modules/feature-auth
git commit -m "refactor: chuyển repository và service của feature-auth sang Prisma

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: Xóa TypeORM khỏi hạ tầng và đấu dây module

**Files:**
- Modify: `src/common/databases/database.module.ts`
- Modify: `src/common/databases/types/database.type.ts`
- Modify: `src/app.module.ts`
- Modify: `src/common/configs/env.validation.ts`
- Modify: `src/common/configs/configuration.ts`
- Modify: `.env`, `.env.example`
- Delete: `src/common/databases/drivers/typeorm.module.ts`
- Delete: `src/providers/abstract-base/abstract-base.entity.ts`
- Delete: `src/providers/abstract-base/repositories/typeorm-base.repository.ts`
- Delete: `src/modules/feature-auth/user/entities/user.entity.ts`
- Delete: `src/modules/feature-auth/authz/entities/authz.entity.ts`
- Delete: `src/modules/feature-auth/authz/entities/refresh-token.entity.ts`

**Interfaces:**
- Consumes: `PrismaDatabaseModule` (Task 1); repositories đã chuyển (Task 3)
- Produces: `DatabaseDriver = 'prisma'`; app khởi động được với Prisma là driver duy nhất

- [ ] **Step 1: Sửa `database.type.ts`**

```ts
export type DatabaseDriver = 'prisma';

export interface DatabaseOptions {
  driver: DatabaseDriver;
}
```

- [ ] **Step 2: Sửa `database.module.ts`**

```ts
import { DynamicModule, Module } from '@nestjs/common';
import { DatabaseOptions } from './types/database.type';
import { PrismaDatabaseModule } from './drivers/prisma.module';

@Module({})
export class DatabaseModule {
  static forRoot(options: DatabaseOptions): DynamicModule {
    const modules: DynamicModule[] = [];

    switch (options.driver) {
      case 'prisma':
        modules.push(PrismaDatabaseModule.forRoot());
        break;
      default:
        throw new Error(`Unsupported database driver: ${String(options.driver)}`);
    }

    return {
      module: DatabaseModule,
      imports: modules,
      exports: modules,
    };
  }
}
```

- [ ] **Step 3: Sửa `app.module.ts` — đổi driver**

```ts
    DatabaseModule.forRoot({ driver: 'prisma' }),
```

- [ ] **Step 4: Bỏ `TypeOrmModule.forFeature` ở hai module con**

`user.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { UserService } from './user.service';
import { UserController } from './user.controller';
import { UserRepository } from './repositories/user.repository';

@Module({
  controllers: [UserController],
  providers: [UserService, UserRepository],
  exports: [UserService, UserRepository],
})
export class UserModule {}
```

`authz.module.ts`: xóa dòng `import { TypeOrmModule } from '@nestjs/typeorm';`, xóa `TypeOrmModule.forFeature([AuthzEntity, RefreshToken])` khỏi mảng `imports`, xóa hai import entity (`AuthzEntity`, `RefreshToken`) — `PrismaDatabaseModule` là global nên không cần import thêm.

- [ ] **Step 5: Xóa các file TypeORM**

```bash
git rm src/common/databases/drivers/typeorm.module.ts \
       src/providers/abstract-base/abstract-base.entity.ts \
       src/providers/abstract-base/repositories/typeorm-base.repository.ts \
       src/modules/feature-auth/user/entities/user.entity.ts \
       src/modules/feature-auth/authz/entities/authz.entity.ts \
       src/modules/feature-auth/authz/entities/refresh-token.entity.ts
```

- [ ] **Step 6: Dọn ENV**

`env.validation.ts`: xóa hai dòng `DB_DATABASE` và `DB_SYNCHRONIZE`.
`configuration.ts`: khối `database` còn lại:

```ts
    database: {
      url: env.DATABASE_URL,
      logging: env.DB_LOGGING === 'true',
    },
```

`.env` và `.env.example`: xóa dòng `DB_DATABASE=...` và `DB_SYNCHRONIZE=...`.

- [ ] **Step 7: Cập nhật chú thích `date.util.ts`**

Code đã hỗ trợ sẵn `Date` (`toIsoString(value: number | Date)`), chỉ còn chú thích nói sai sự thật. Sửa comment đầu file:

```ts
/**
 * Chuẩn hoá thời gian ở tầng API.
 *
 * `createdAt` / `updatedAt` là `Date` (Prisma `DateTime`). Ra tới client thì chúng phải
 * là chuỗi ISO 8601 — việc chuyển đổi chỉ diễn ra một lần ở `TransformInterceptor`,
 * không rải rác trong từng service. Hàm vẫn nhận cả epoch milliseconds để tương thích
 * với dữ liệu cũ.
 */
```

- [ ] **Step 8: Build**

```bash
npm run build
```

Expected: `Found 0 issues`. (Lỗi ở `test/app.e2e-spec.ts` là được phép — Task 5 xử lý.)

- [ ] **Step 9: Commit**

```bash
git add -A src .env.example
git commit -m "refactor: xóa TypeORM, Prisma là driver dữ liệu duy nhất

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: Chuyển e2e test sang Prisma

**Files:**
- Modify: `test/app.e2e-spec.ts`

**Interfaces:**
- Consumes: `PrismaService` (Task 1), app đã chạy Prisma (Task 4), migration đầu tiên (Task 1)
- Produces: bộ test xanh 41/41, dùng làm lưới an toàn cho Task 6

- [ ] **Step 1: Đổi phần import và khai báo**

Bỏ:

```ts
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { UserEntity } from '../src/modules/feature-auth/user/entities/user.entity';
import { AuthzEntity } from '../src/modules/feature-auth/authz/entities/authz.entity';
import { RefreshToken } from '../src/modules/feature-auth/authz/entities/refresh-token.entity';
```

Thêm:

```ts
import { execSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';
```

Đổi khai báo `let db: DataSource;` thành:

```ts
  let prisma: PrismaClient;
  let dbDir: string;
```

- [ ] **Step 2: Đổi `beforeAll` — DB file tạm thay `:memory:`**

Tạo DB tạm **trước** khi compile module và bỏ `TypeOrmModule.forRoot(...)` khỏi mảng `imports`:

```ts
  beforeAll(async () => {
    dbDir = mkdtempSync(join(tmpdir(), 'pos-ndm-e2e-'));
    process.env.DATABASE_URL = `file:${join(dbDir, 'test.sqlite')}`;
    execSync('npx prisma migrate deploy', { env: { ...process.env }, stdio: 'inherit' });

    const fixture = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          ignoreEnvVars: true,
          validate: () =>
            validateEnv({
              JWT_ACCESS_SECRET: secret,
              AUTH_REFRESH_IN_BODY: String(inBody),
              DATABASE_URL: process.env.DATABASE_URL,
            }),
        }),
        // AppModule không được nạp trong test nên phải tự đăng ký nguồn DB.
        PrismaDatabaseModule.forRoot(),
        AuthzModule,
        ScheduleModule.forRoot(),
      ],
    }).compile();
```

Lưu ý thứ tự: `process.env.DATABASE_URL` phải được set **trước** `Test.createTestingModule(...).compile()`, và phải truyền tường minh vào `validateEnv` — `ConfigModule` ở đây bật `ignoreEnvVars: true` nên `process.env` không tự chảy vào config, còn `configuration.ts` đọc `env.DATABASE_URL` từ kết quả `envSchema.parse`.

Thêm import: `import { PrismaDatabaseModule } from '../src/common/databases/drivers/prisma.module';`

Sau `await app.getHttpAdapter().getInstance().ready();`, thay `db = app.get(DataSource);` bằng:

```ts
    prisma = app.get(PrismaService);
```

và thêm import `import { PrismaService } from '../src/common/databases/prisma.service';`.

Trong `afterAll`, thêm dọn dẹp:

```ts
  afterAll(async () => {
    await app?.close();
    rmSync(dbDir, { recursive: true, force: true });
  });
```

- [ ] **Step 3: Đổi `beforeEach` — fixture qua Prisma**

```ts
  beforeEach(async () => {
    app.get<ThrottlerStorageService>(ThrottlerStorage).storage.clear();
    await prisma.refreshToken.deleteMany();
    await prisma.auth.deleteMany();
    await prisma.user.deleteMany();
    const user = await prisma.user.create({
      data: {
        email: 'test@example.test',
        fullName: 'Test',
        role: AuthRole.SUPER_ADMIN,
        createdAt: new Date(),
      },
    });
    userId = user.id;
    await prisma.auth.create({
      data: { userId, username: 'tester', password: passwordHash, createdAt: new Date() },
    });
  });
```

- [ ] **Step 4: Chuyển các truy vấn còn lại theo bảng ánh xạ**

| Dòng (bản cũ) | TypeORM | Prisma |
|---|---|---|
| 147, 208, 214, 251, 339, 345 | `db.getRepository(RefreshToken).findOneByOrFail({ userId })` | `prisma.refreshToken.findFirstOrThrow({ where: { userId } })` |
| 160, 381, 388 | `db.getRepository(RefreshToken).find()` | `prisma.refreshToken.findMany()` |
| 213, 304 | `db.getRepository(RefreshToken).count()` | `prisma.refreshToken.count()` |
| 289 | `db.getRepository(AuthzEntity).findOneByOrFail({ userId })` | `prisma.auth.findFirstOrThrow({ where: { userId } })` |
| 330 | `db.getRepository(RefreshToken).update({ userId }, { expiresAt: new Date(0) })` | `prisma.refreshToken.updateMany({ where: { userId }, data: { expiresAt: new Date(0) } })` |
| 382 | `db.getRepository(RefreshToken).save([...3 bản ghi])` | `prisma.refreshToken.createMany({ data: [...3 bản ghi] })` |

Riêng chỗ `save([...])` (test "Dọn token hết hạn hoặc đã thu hồi quá lâu"), thay bằng:

```ts
    const template = (await prisma.refreshToken.findMany())[0];
    await prisma.refreshToken.createMany({
      data: [
        { ...template, id: randomUUID(), tokenHash: 'expired', expiresAt: new Date(0) },
        { ...template, id: randomUUID(), tokenHash: 'old-revoked', revokedAt: new Date(Date.now() - 31 * 86400000) },
        { ...template, id: randomUUID(), tokenHash: 'recent-revoked', revokedAt: new Date() },
      ],
    });
```

`template` là một `RefreshToken` đọc từ Prisma nên đã có đủ `userId`, `sid`; `createdAt` giữ nguyên giá trị cũ, `id` được thay bằng `randomUUID()`.

- [ ] **Step 5: Thêm test ghi đồng thời (Review Focus 4)**

Thêm vào trong `describe.each`, sau test đăng nhập đầu tiên:

```ts
  it('Hai lần đăng nhập song song đều thành công, không lỗi khoá ghi', async () => {
    const [first, second] = await Promise.all([
      request(app.getHttpServer()).post('/auth/login').send({ username: 'tester', password: 'Original-password1' }),
      request(app.getHttpServer()).post('/auth/login').send({ username: 'tester', password: 'Original-password1' }),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await prisma.refreshToken.count({ where: { revokedAt: null } })).toBe(1);
  });
```

(Chính sách single-session: lần login sau thu hồi phiên trước, nên chỉ còn đúng 1 refresh token còn hiệu lực.)

- [ ] **Step 6: Chạy toàn bộ e2e**

```bash
npm run test:e2e
```

Expected: `Tests: 41 passed, 41 total` (40 test cũ + 1 test mới). Nếu còn sót `db.getRepository` nào, TypeScript sẽ báo — sửa hết.

- [ ] **Step 7: Commit**

```bash
git add test/app.e2e-spec.ts
git commit -m "test: chuyển e2e test sang Prisma, thêm test ghi đồng thời

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: Xóa dependency TypeORM và kiểm chứng đầu-cuối

**Files:**
- Modify: `package.json`
- Modify: `README.md` (mục cài đặt/chạy — nếu có nhắc TypeORM hoặc DB_SYNCHRONIZE)

**Interfaces:**
- Consumes: toàn bộ kết quả Task 1–5
- Produces: dự án không còn dấu vết TypeORM; DB dev chạy được với seed

- [ ] **Step 1: Gỡ dependency**

```bash
npm uninstall typeorm @nestjs/typeorm better-sqlite3
npm uninstall -D @types/better-sqlite3
```

- [ ] **Step 2: Thêm script DB vào `package.json`**

Thêm vào `scripts`:

```json
    "db:generate": "prisma generate",
    "db:migrate": "prisma migrate dev",
    "db:deploy": "prisma migrate deploy",
    "db:studio": "prisma studio",
```

- [ ] **Step 3: Cập nhật `README.md` nếu có nhắc TypeORM/DB_SYNCHRONIZE**

```bash
grep -n "typeorm\|TypeORM\|synchronize\|DB_SYNCHRONIZE\|better-sqlite3" README.md
```

Với mỗi kết quả: thay bằng mô tả Prisma tương ứng (`npx prisma migrate deploy` thay cho tự đồng bộ schema; biến `DATABASE_URL` thay `DB_DATABASE`).

- [ ] **Step 4: Xác nhận không còn dấu vết TypeORM**

```bash
grep -rn "typeorm\|TypeORM\|better-sqlite3" src test package.json
```

Expected: không có kết quả nào.

- [ ] **Step 5: Build sạch**

```bash
npm run build
```

Expected: `Found 0 issues` + `Successfully compiled`.

- [ ] **Step 6: Chạy lại toàn bộ e2e**

```bash
npm run test:e2e
```

Expected: `Tests: 41 passed, 41 total`.

- [ ] **Step 7: Tạo DB dev mới và seed super admin**

```bash
rm -f data/pos-ndm.sqlite
npm run db:deploy
npm run seed:super-admin
```

Expected: log `Đã tạo quản trị viên cấp cao thành công` (hoặc `đã tồn tại` nếu chạy lần hai).

- [ ] **Step 8: Chạy app thật và gọi thử ba endpoint**

```bash
npm run start:dev
```

Trong cửa sổ khác (thay `<user>`/`<pass>` bằng giá trị `SUPER_ADMIN_USERNAME`/`SUPER_ADMIN_PASSWORD` trong `.env`):

```bash
curl -s -X POST http://localhost:3000/auth/login -H "Content-Type: application/json" -d "{\"username\":\"<user>\",\"password\":\"<pass>\"}"
```

Expected: JSON có `data.accessToken`, `errorCode: 0`; header `set-cookie` có `Path=/auth`.
Sau đó dùng `accessToken` gọi `GET /auth/me` — expected: `data.createdAt` là chuỗi ISO 8601 (ví dụ `2026-10-01T09:00:00.000Z`), **không phải** số epoch.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json README.md
git commit -m "chore: gỡ dependency TypeORM, thêm script Prisma

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Ghi chú cho người thực thi

- Task 2–4 không chạy được app; đây là điều bình thường với migration ORM. Đừng cố khởi động app giữa chừng để "kiểm tra" — mốc kiểm chứng là Task 5 (e2e) và Task 6 (chạy thật).
- `.env` không được commit (đã nằm trong `.gitignore`), nhưng **phải sửa trên máy** vì Prisma CLI đọc nó.
- Nếu `prisma migrate dev` hỏi reset DB, chọn yes — dữ liệu cũ đã được đồng ý bỏ.
