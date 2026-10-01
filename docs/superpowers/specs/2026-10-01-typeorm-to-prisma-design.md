# Chuyển tầng dữ liệu từ TypeORM sang Prisma

> Nhánh: `feat/auth-and-user-service` · Ngày: 2026-10-01 · Trạng thái: chờ duyệt

## 1. Bối cảnh và mục tiêu

Dự án đang dùng TypeORM 1.x với driver `better-sqlite3` cho cả ba bảng `users`, `auths`,
`refresh_tokens`. Sau khi họp, nhóm thống nhất chuyển sang Prisma và **xóa hoàn toàn TypeORM**
khỏi dự án.

Mục tiêu: tầng dữ liệu chạy trên Prisma, hành vi quan sát được từ bên ngoài **không đổi** —
API vẫn trả cùng cấu trúc, thời gian vẫn là chuỗi ISO 8601, soft delete vẫn hoạt động, 40 e2e
test hiện có vẫn phải xanh.

## 2. Quyết định đã chốt

| # | Quyết định | Lý do |
|---|---|---|
| 1 | Giữ **SQLite**, chỉ đổi ORM | Đổi ít nhất; test e2e và seed chạy như cũ |
| 2 | **Giữ khuôn** repository + base service, viết lại trên Prisma | Các module sau (thuốc, kho, bán hàng) dùng chung một khuôn |
| 3 | `createdAt`/`updatedAt` chuyển sang **DateTime** | Prisma `Int` là 32-bit, epoch ms (~1.76e12) sẽ tràn; DateTime cũng thống nhất với `refresh_tokens` vốn đã dùng `Date` |
| 4 | **Bỏ dữ liệu cũ**, tạo DB mới rồi chạy lại seed | DB chỉ có 1 super-admin + token test |
| 5 | Dùng **Prisma Migrate** (file migration có version) | Có lịch sử schema, an toàn khi dự án lớn dần |

## 3. Phạm vi

**Trong phạm vi:** toàn bộ 16 file đang import `typeorm`/`@nestjs/typeorm`/`better-sqlite3`
(liệt kê ở mục 5), cấu hình ENV liên quan, `package.json`, e2e test, seed.

**Ngoài phạm vi:** không đổi hành vi auth (token, phiên, cookie, rate limit), không đổi DTO,
không đổi response envelope, không thêm module mới.

## 4. Thiết kế

### 4.1. Schema Prisma — `prisma/schema.prisma`

Cột trong DB hiện tại là camelCase nên chỉ cần `@@map` cho tên bảng, không cần `@map` cho cột.

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

Ghi chú:

- `status` và `role` để `String`: SQLite không hỗ trợ enum trong Prisma. Giá trị vẫn do
  `RecordStatusEnum` / `AuthRole` ở tầng code quyết định, không đổi.
- `updatedAt` là `DateTime?` và **gán tay** khi update, giữ đúng hành vi hiện tại: bản ghi mới
  có `updatedAt = null`. Không dùng `@updatedAt` vì nó sẽ tự điền cả khi create.
- `createdAt` dùng `@default(now())`; repository vẫn truyền giá trị tường minh khi cần.

### 4.2. Tầng kết nối

**File mới `src/common/databases/prisma.service.ts`**

```ts
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(config: ConfigService) {
    const logging = config.get<boolean>('database.logging');
    super({
      datasourceUrl: config.getOrThrow<string>('database.url'),
      log: logging ? ['query', 'warn', 'error'] : ['warn', 'error'],
    });
  }
  async onModuleInit() { await this.$connect(); }
  async onModuleDestroy() { await this.$disconnect(); }
}
```

- Truyền `datasourceUrl` từ `ConfigService` để không phụ thuộc thứ tự nạp `.env`.
- Trong constructor: tạo thư mục cha của file DB nếu chưa có (giữ vai trò của `mkdirSync`
  trong `typeorm.module.ts` hiện tại — SQLite không tự tạo thư mục).
- `DB_LOGGING=true` bật log query; mặc định chỉ log cảnh báo và lỗi.

**File mới `src/common/databases/drivers/prisma.module.ts`** — `PrismaDatabaseModule.forRoot()`
trả `DynamicModule` global, export `PrismaService` (thay `TypeormDatabaseModule`).

**Sửa `database.module.ts` / `database.type.ts`**: `DatabaseDriver = 'prisma'`, switch driver
chuyển sang `PrismaDatabaseModule`. Điểm gọi ở `app.module.ts` đổi thành
`DatabaseModule.forRoot({ driver: 'prisma' })`.

**ENV**

| Cũ | Mới |
|---|---|
| `DB_DATABASE=data/pos-ndm.sqlite` | `DATABASE_URL="file:../data/pos-ndm.sqlite"` |
| `DB_SYNCHRONIZE=true` | bỏ hẳn |
| `DB_LOGGING=false` | giữ nguyên |

Đường dẫn trong `DATABASE_URL` được Prisma resolve **tương đối theo vị trí `schema.prisma`**,
nên phải là `../data/` để trỏ đúng `data/pos-ndm.sqlite` ở gốc dự án. Ghi chú này phải có
trong `.env.example`. Cập nhật `env.validation.ts` (bỏ `DB_DATABASE`, `DB_SYNCHRONIZE`; thêm
`DATABASE_URL` bắt buộc) và `configuration.ts` (`database.url`).

### 4.3. Base repository / service

**Xóa** `src/providers/abstract-base/abstract-base.entity.ts` và
`repositories/typeorm-base.repository.ts`. **Thêm**
`repositories/prisma-base.repository.ts`.

Ràng buộc generic đổi từ class `AbstractBaseEntity` sang interface `BaseRecord` đặt trong
`abstract-base.repository.ts`:

```ts
export interface BaseRecord {
  id: string;
  isDeleted: boolean;
  createdAt: Date;
  createdBy: string | null;
  updatedAt: Date | null;
  updatedBy: string | null;
}
export type BaseWhere<T> = Partial<Record<keyof T & string, unknown>>;
```

`PrismaBaseRepository<T extends BaseRecord>` implements `IBaseRepository<T>` (giữ nguyên
interface, chỉ đổi `FindOptionsWhere<T>` → `BaseWhere<T>`). Ngữ nghĩa giữ đủ:

- **Delegate động**: repo con gọi `super(prisma, 'User')`; base lấy
  `this.prisma[modelName[0].toLowerCase() + modelName.slice(1)]`. Đây là chỗ duy nhất mất
  type-safety, được bọc kín trong base. Repo con vẫn dùng được `this.prisma.user.findFirst(...)`
  typed cho query đặc thù (`findByEmailIgnoringSoftDelete`).
- **`columnNames`**: thay `repository.metadata.columns` bằng DMMF —
  `Prisma.dmmf.datamodel.models.find(m => m.name === modelName)`, lọc field `kind === 'scalar'`.
- **Filter**: `null` truyền thẳng (Prisma hiểu là `IS NULL`), bỏ `IsNull()`; `undefined` vẫn bị
  loại như cũ.
- **Ranges**: `{ min, max }` → `{ gte, lte }`; **sort**: parse chuỗi giữ nguyên, map sang
  `orderBy: [{ field: 'asc' | 'desc' }]`; **relations**: giữ nguyên cách nhận
  (`string[] | Record<string, boolean>`) và map sang `include`.
- **`findManyWithPagination`**: dùng `Promise.all([findMany, count])` — không dùng
  `$transaction` lồng nhau để tránh xung đột với transaction của tầng session.
- **`create`**: gán `createdAt: new Date()`, `isDeleted: false` như cũ; **`update`**: gán
  `updatedAt: new Date()`; **`softDelete`/`softDeleteMany`**: `updateMany` rồi trả
  `count > 0` (giữ ngữ nghĩa `affected > 0`).
- **Search**: hành vi chốt là *tìm văn bản thuần* — ký tự `%` và `_` trong từ khóa không được
  hoạt động như wildcard. Triển khai phải kèm test chứng minh; nếu Prisma đã tự escape thì bỏ
  `escapeLike` thủ công để tránh escape hai lần.

`AbstractBaseService` chỉ đổi kiểu filter (`FindOptionsWhere<T>` → `BaseWhere<T>`), phần còn
lại giữ nguyên.

### 4.4. Transaction, session, password

- `SessionTransactions.write(work: (tx: Prisma.TransactionClient) => Promise<T>)` dùng
  `this.prisma.$transaction(work)`. **Giữ nguyên cơ chế serialize** (`tail` promise): SQLite
  vẫn single-writer, các transaction lồng/xen kẽ vẫn phải chạy tuần tự. `read()` giữ nguyên.
- `DbSessionStore`: `this.db.getRepository(RefreshToken).findOne({ where: { sid, revokedAt: IsNull(), expiresAt: MoreThan(...) } })`
  → `this.prisma.refreshToken.findFirst({ where: { sid, revokedAt: null, expiresAt: { gt: new Date(now) } } })`.
- `TokenService`: `manager.findOneBy(X, {...})` → `tx.x.findFirst({ where: {...} })`,
  `manager.save(RefreshToken, manager.create(...))` → `tx.refreshToken.create({ data })`,
  `manager.update(X, where, data)` → `tx.x.updateMany({ where, data })`,
  `manager.delete(RefreshToken, [{...},{...}])` → `tx.refreshToken.deleteMany({ where: { OR: [...] } })`.
  Các điều kiện `IsNull()`/`LessThan()` → `null` / `{ lt: ... }`.
- `PasswordService`: `db.getRepository(AuthzEntity).findOneBy(...)` →
  `prisma.auth.findFirst(...)`; hai khối `transactions.write` đổi sang API Prisma; giữ nguyên
  logic kiểm tra `affected !== 1` bằng cách đối chiếu `count` của `updateMany`.

### 4.5. Entities → type của Prisma

Xóa 3 file entity (`user.entity.ts`, `authz.entity.ts`, `refresh-token.entity.ts`). Code dùng
thẳng type sinh bởi Prisma: `User`, `Auth`, `RefreshToken` (`@prisma/client`). Đổi tên import
ở `authz.service.ts`, `token.service.ts`, `password.service.ts`, `session.store.ts`,
`authz.repository.ts`, `user.repository.ts`, `authz.module.ts`, `user.module.ts`, e2e test.

`UserModule`/`AuthzModule`: bỏ `TypeOrmModule.forFeature([...])`; repository inject
`PrismaService` thay `@InjectRepository`.

### 4.6. Test e2e

Bỏ `TypeOrmModule.forRoot({ database: ':memory:', synchronize: true })`. Thay bằng:

1. Tạo file DB tạm trong thư mục temp của OS (không dùng `:memory:` — Prisma + SQLite
   in-memory có thể tạo DB riêng cho từng connection trong pool).
2. Chạy `prisma migrate deploy` với `DATABASE_URL` trỏ vào file tạm trước khi compile testing
   module (dùng đúng migration đã commit, không dùng `db push`).
3. Sau mỗi suite: `$disconnect` và xóa file tạm.

Các chỗ test dùng `DataSource` để tạo fixture (user, auth, refresh token) đổi sang Prisma
Client tương ứng.

### 4.7. Script và công cụ

Thêm vào `package.json`:

```json
"db:generate": "prisma generate",
"db:migrate": "prisma migrate dev",
"db:deploy": "prisma migrate deploy",
"db:studio": "prisma studio"
```

`seed:super-admin` giữ nguyên (đi qua `AuthzService.seedSuperAdmin()`, không phụ thuộc ORM).

**Xóa dependency:** `typeorm`, `@nestjs/typeorm`, `better-sqlite3`, `@types/better-sqlite3`.
**Thêm:** `@prisma/client` (dependencies), `prisma` (devDependencies).

## 5. Danh sách file thay đổi

**Thêm mới**

```
prisma/schema.prisma
prisma/migrations/**                       (sinh bởi prisma migrate dev)
src/common/databases/prisma.service.ts
src/common/databases/drivers/prisma.module.ts
src/providers/abstract-base/repositories/prisma-base.repository.ts
```

**Xóa**

```
src/common/databases/drivers/typeorm.module.ts
src/providers/abstract-base/abstract-base.entity.ts
src/providers/abstract-base/repositories/typeorm-base.repository.ts
src/modules/feature-auth/user/entities/user.entity.ts
src/modules/feature-auth/authz/entities/authz.entity.ts
src/modules/feature-auth/authz/entities/refresh-token.entity.ts
data/pos-ndm.sqlite                        (tạo lại từ migration + seed)
```

**Sửa**

```
package.json, .env.example
src/app.module.ts
src/common/configs/configuration.ts
src/common/configs/env.validation.ts
src/common/databases/database.module.ts
src/common/databases/types/database.type.ts
src/common/utils/date.util.ts              (cập nhật chú thích: DateTime thay epoch ms)
src/providers/abstract-base/abstract-base.service.ts
src/providers/abstract-base/repositories/abstract-base.repository.ts
src/modules/feature-auth/user/user.module.ts
src/modules/feature-auth/user/repositories/user.repository.ts
src/modules/feature-auth/authz/authz.module.ts
src/modules/feature-auth/authz/authz.service.ts
src/modules/feature-auth/authz/authz.repository.ts
src/modules/feature-auth/authz/token.service.ts
src/modules/feature-auth/authz/password.service.ts
src/modules/feature-auth/authz/session.store.ts
test/app.e2e-spec.ts
```

## 6. Kiểm chứng

Thứ tự bắt buộc, tất cả phải đạt:

1. `npx prisma migrate dev --name init` — migration đầu tiên chạy sạch trên DB mới
2. `npm run build` — 0 lỗi TypeScript
3. `npm run test:e2e` — 40/40 test xanh
4. `npm run seed:super-admin` — tạo được super admin trên DB mới
5. `grep -rn "typeorm\|better-sqlite3" src test package.json` — không còn kết quả
6. Chạy `npm run start:dev` và gọi thử `POST /auth/login`, `GET /auth/me`, `POST /auth/refresh`
   bằng super admin vừa seed — xác nhận response vẫn đúng envelope và ISO 8601

## 7. Rủi ro và điểm phải kiểm chứng khi làm

| Rủi ro | Cách xử lý |
|---|---|
| Prisma `contains` có thể tự escape `%`/`_`, escape thủ công sẽ thành hai lần | Viết test tìm kiếm với `%` và `_`; chọn một trong hai, không đoán |
| `Prisma.dmmf` là API nội bộ, có thể đổi giữa các bản Prisma | Ghim version Prisma trong `package.json`; có test cho search/sort dựa trên `columnNames` |
| Transaction lồng nhau giữa base repo và tầng session | Base repo không mở `$transaction`; chỉ `SessionTransactions` được mở |
| `$disconnect` không chạy khi test kết thúc sớm | Dùng `afterAll` + xóa file tạm trong `finally` |
