# Pharmacy Management System — Backend

REST API cho hệ thống quản lý nhà thuốc, xây dựng trên **NestJS 11 + Prisma + PostgreSQL**.

> Package manager: **npm** (dự án này dùng `package-lock.json`, không dùng `pnpm` hay `yarn`).

---

## 1. Yêu cầu môi trường

| Phần mềm | Phiên bản tối thiểu |
|---|---|
| Node.js | ≥ 20.x |
| npm | ≥ 10.x (đi kèm với Node.js 20+) |

Kiểm tra nhanh:

```bash
node -v
npm -v
```

---

## 2. Cài đặt

```bash
# 1) Cài dependency
npm install

# 2) Tạo file môi trường từ file mẫu
cp .env.example .env
```

Mở `.env` và chỉnh các giá trị cho phù hợp (port, chuỗi kết nối PostgreSQL, JWT secret, tài khoản super admin, …).

---

## 3. Chạy dự án

```bash
# Build output vào thư mục dist/
npm run build

# Production — chạy file đã build
npm run start:prod

# Development — auto-restart khi sửa code
npm run start:dev

# Debug — listen trên port 9229 cho Chrome DevTools
npm run start:debug
```

Sau khi chạy thành công:

- API: <http://localhost:3000>
- Swagger UI: <http://localhost:3000/docs>

---

## 4. Cấu trúc dự án

```
src/
├── app.module.ts                 # Root module
├── main.ts                       # Bootstrap (Fastify, CORS, global pipes, Swagger)
├── common/
│   ├── configs/                  # Configuration loader (ConfigService)
│   ├── databases/                # Prisma client / driver module
│   ├── exceptions/               # Global exception filter
│   ├── interceptors/             # Transform interceptor (response shape)
│   └── types/                    # Enum / type chung
├── modules/
│   └── feature-auth/             # Module xác thực & phân quyền
│       ├── authz/                # /auth: login, refresh, logout, password, sessions
│       ├── permission/           # Quyền
│       └── user/                 # Người dùng
├── providers/
│   └── mailer/                   # Gửi email (SMTP qua nodemailer)
└── scripts/
    └── seed-super-admin.ts       # Seed tài khoản admin đầu tiên
```

---

## 5. Các biến môi trường (`.env`)

| Biến | Mô tả | Mặc định |
|---|---|---|
| `PORT` | Port HTTP server | `3000` |
| `DATABASE_URL` | Chuỗi kết nối PostgreSQL, dạng `postgresql://user:password@host:5432/dbname`. Ký tự đặc biệt trong mật khẩu phải URL-encode (`@` → `%40`) | (bắt buộc) |
| `DB_LOGGING` | In câu SQL ra log | `false` |
| `JWT_ACCESS_SECRET` | Secret ký access JWT, tối thiểu 32 ký tự | (bắt buộc) |
| `JWT_ACCESS_TTL` | Thời hạn access JWT | `15m` |
| `REFRESH_TTL` | Thời hạn opaque refresh token | `7d` |
| `AUTH_REFRESH_IN_BODY` | Cho phép refresh token trong body để test | `false` |
| `COOKIE_SECURE` | Chỉ gửi cookie qua HTTPS | `false` |
| `COOKIE_SAMESITE` | strict, lax, none | `strict` |
| `COOKIE_PATH` | Đường dẫn cookie, bao gồm global prefix nếu có | `/auth` |
| `SUPER_ADMIN_EMAIL` | Email super admin | (bắt buộc để seed) |
| `SUPER_ADMIN_USERNAME` | Username đăng nhập của super admin | (bắt buộc để seed) |
| `SUPER_ADMIN_PASSWORD` | Mật khẩu super admin | (bắt buộc để seed) |
| `SUPER_ADMIN_FULL_NAME` | Họ tên | `Super Admin` |
| `SUPER_ADMIN_PHONE_NUMBER` / `_ADDRESS` | Thông tin phụ | — |
| `SUPER_ADMIN_DATE_OF_BIRTH` | Ngày sinh, định dạng `YYYY-MM-DD` | — |
| `SUPER_ADMIN_GENDER` | `MALE`, `FEMALE` hoặc `OTHER` | — |

> ENV authentication được validate khi khởi động. Xem [hướng dẫn authentication](docs/AUTHENTICATION.md) để chuyển cấu hình cũ, test Swagger, tích hợp frontend và chuẩn bị Redis.

> **Không commit file `.env`** — đã được liệt kê trong `.gitignore`.

---

## 6. Database

- **PostgreSQL** qua Prisma, cấu hình bằng `DATABASE_URL`.
- Schema khai báo tại `prisma/schema.prisma`; thay đổi schema bằng **Prisma Migrate**, không tự đồng bộ khi khởi động.
- Khoá chính là **UUID** (`@default(uuid())`, sinh phía client — INSERT thô bằng SQL phải tự cấp `id`).
- Mọi cột thời gian là `timestamptz`; `createdAt` tự điền khi tạo, `updatedAt` do repository gán khi cập nhật (bản ghi mới có `updatedAt = null`).
- Cột trạng thái dùng **enum thật của PostgreSQL** (`RecordStatus`, `UserStatus`, `Gender`), giá trị lưu dạng chữ HOA.
- Model đặt trong `prisma/schema.prisma`; type sinh ra được dùng trực tiếp (`User`, `Auth`, `RefreshToken` từ `@prisma/client`).
- Repository nền: `src/providers/abstract-base/repositories/prisma-base.repository.ts` — mọi filter tự động thêm `isDeleted: false` (soft delete).
- `createdBy` / `updatedBy` là kiểu `uuid`; thao tác do hệ thống khởi phát dùng hằng `SYSTEM_ACTOR_ID` trong `src/common/constants/app.constant.ts`, **không** ghi chuỗi tự do.

> **Prisma Migrate cần shadow database** — tạo và xoá một CSDL tạm trên cùng server. Nếu tài khoản
> không có quyền `CREATEDB`, dùng phương án dự phòng: `prisma migrate diff --from-empty
> --to-schema-datamodel prisma/schema.prisma --script` để sinh SQL, `prisma db execute --file` để áp,
> rồi `prisma migrate resolve --applied <tên migration>`.
>
> Khi dùng nhà cung cấp có pooler (Supabase, Neon…): migrate cần **session pooler (cổng 5432)**.
> Cổng 6543 là transaction pooler, không chạy được DDL.

Các lệnh thường dùng:

```bash
npm run db:migrate    # tạo migration mới khi sửa schema (dev)
npm run db:deploy     # áp migration đã commit (máy mới / production)
npm run db:generate   # sinh lại Prisma Client
npm run db:studio     # mở giao diện xem dữ liệu
```

Thiết lập máy mới: `npm install` → `cp .env.example .env` → `npm run db:deploy` → `npm run seed:permissions` → `npm run seed:catalog` → `npm run seed:users` → `npm run seed:super-admin`.

Thứ tự này không tuỳ tiện: `seed:users` cần vai trò (do `seed:permissions` tạo) và chi nhánh (do
`seed:catalog` tạo), còn `seed:super-admin` cần vai trò `SUPER_ADMIN` đã tồn tại.

Xem cấu hình tại: `src/common/configs/configuration.ts` và `src/common/databases/prisma.service.ts`.

---

## 7. Seed super admin

Seed **không** tự chạy khi khởi động — phải gọi thủ công. Script sẽ tạo super admin nếu email chưa tồn tại, và bỏ qua nếu đã có:

```bash
npm run seed:super-admin
```

Script cần `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_USERNAME`, `SUPER_ADMIN_PASSWORD`; thiếu một trong ba thì sẽ cảnh báo và thoát mà không tạo gì.

Xem `src/scripts/seed-super-admin.ts` và `AuthzService.seedSuperAdmin()`.

---

## 8. Phân quyền

Hệ thống dùng RBAC: 5 vai trò cố định (`SUPER_ADMIN`, `ADMIN`, `PHARMACY_MANAGER`, `SALES_STAFF`,
`CUSTOMER`) nằm trong bảng `roles`; danh mục quyền khai báo trong
`src/modules/feature-auth/permission/permission.constant.ts` rồi seed xuống bảng `permissions`;
bảng `role_permissions` là ma trận quyền của từng vai trò.

```bash
npm run seed:permissions   # đồng bộ danh mục vai trò + quyền, cấp quyền mặc định lần đầu
npm run seed:catalog       # 3 chi nhánh mẫu (đơn vị tính, nhóm thuốc, sản phẩm sẽ bổ sung sau)
npm run seed:users         # tài khoản mẫu: admin, quanly, nhanvien
```

Chạy lại nhiều lần vẫn an toàn: vai trò và quyền được upsert theo `code`, còn quyền mặc định chỉ
được cấp cho vai trò chưa từng có bản ghi cấp quyền nào — nên cấu hình đã chỉnh trên hệ thống không
bị ghi đè.

Hai script sau chỉ là **dữ liệu mẫu để thử phân quyền**, không bắt buộc khi dựng môi trường thật.
`seed:users` tạo một tài khoản cho mỗi vai trò nội bộ, kèm dòng `auths` để đăng nhập được; tài khoản
`CUSTOMER` cố ý không seed vì chưa có luồng tạo khách hàng.

Thêm nghiệp vụ mới: thêm một dòng vào `PERMISSION_CATALOG` rồi chạy lại `npm run seed:permissions`.

API quản trị nằm dưới `/permission`: `GET /permission/me`, `GET /permission/catalog`,
`GET /permission/roles`, `GET /permission/roles/:code/permissions`,
`PUT /permission/roles/:code/permissions`, `PATCH /permission/users/:userId/role`.

API người dùng nằm dưới `/user`: `GET /user`, `GET /user/:id`, `POST /user`, `PATCH /user/:id`,
`DELETE /user/:id`. Quyền tương ứng là `user:read` · `user:create` · `user:update` · `user:delete`.
`user:create` **cố ý không cấp cho vai trò nào** — tài khoản của các vai trò nội bộ chỉ `SUPER_ADMIN`
tạo được. `PATCH /user/:id` không đổi vai trò; việc đó đi qua
`PATCH /permission/users/:userId/role`. Hai luật bảo vệ ở tầng service, áp cho mọi vai trò gọi:
không sửa/xoá được tài khoản `SUPER_ADMIN` (1604), và không tự xoá mình hay tự đổi trạng thái của
mình (1605).

Trên route, khai báo quyền bằng decorator:

```ts
@RequirePermissions('product:update')
@UseGuards(AuthzGuard, PermissionGuard)
@Patch('product/:id')
update() { ... }
```

`PermissionGuard` chặn mọi route không khai báo quyền, kể cả khi đã gắn guard — muốn route chỉ cần
đăng nhập thì ghi rõ `@AnyAuthenticated()`. `SUPER_ADMIN` bỏ qua toàn bộ kiểm tra quyền. Module
nghiệp vụ muốn dùng guard phải `imports: [PermissionModule, AuthzModule]`.

> **Cẩn thận vòng lặp module:** `AuthzModule` và `PermissionModule` đều import `UserModule` để lấy
> `UserRepository`. Nên module nào vừa cung cấp repository cho chúng, vừa cần guard của chúng — như
> `UserModule` — sẽ tạo vòng lặp, và phải bọc `forwardRef(() => ...)` ở **cả hai đầu** của mỗi cạnh.
> Module nghiệp vụ mới chỉ cần guard mà không bị chúng import thì import thẳng, không cần `forwardRef`.

---

## 9. Test

```bash
# Unit test
npm run test

# Unit test watch mode
npm run test:watch

# Coverage
npm run test:cov

# End-to-end
npm run test:e2e
```

---

## 10. Lint & Format

```bash
npm run lint           # eslint (type-aware)
npm run format         # prettier cho src/ và test/
```

---

## 11. Logging

Dự án đang dùng `Logger` mặc định của NestJS — log được in ra **stdout/stderr** của terminal nơi bạn chạy lệnh. Chưa có cơ chế ghi file log. Nếu cần giữ log lâu dài, có thể cân nhắc tích hợp `nestjs-pino` hoặc `nest-winston`.

---

## 12. Công nghệ sử dụng

- **NestJS 11** (Fastify adapter)
- **Prisma 6** + **PostgreSQL**
- **Passport JWT** cho xác thực
- **class-validator** + **class-transformer** cho DTO
- **@nestjs/swagger** cho API docs
- **nodemailer** + **handlebars** cho gửi email template
- **bcrypt** cho hash mật khẩu

---

## 13. License

UNLICENSED — dự án nội bộ.
