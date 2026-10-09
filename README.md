# Pharmacy Management System — Backend

REST API cho hệ thống quản lý nhà thuốc, xây dựng trên **NestJS 11 + Prisma + SQLite**.

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

Mở `.env` và chỉnh các giá trị cho phù hợp (port, đường dẫn SQLite, JWT secret, tài khoản super admin, …).

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
| `DATABASE_URL` | Chuỗi kết nối Prisma, dạng `file:../data/pos-ndm.sqlite` (tương đối theo `prisma/schema.prisma`) | `file:../data/pos-ndm.sqlite` |
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
| `SUPER_ADMIN_PHONE_NUMBER` / `_ADDRESS` / `_AGE` / `_GENDER` | Thông tin phụ | — |

> ENV authentication được validate khi khởi động. Xem [hướng dẫn authentication](docs/AUTHENTICATION.md) để chuyển cấu hình cũ, test Swagger, tích hợp frontend và chuẩn bị Redis.

> **Không commit file `.env`** — đã được liệt kê trong `.gitignore`.

---

## 6. Database

- **SQLite** qua Prisma, file mặc định `data/pos-ndm.sqlite` (đổi bằng `DATABASE_URL`). Thư mục `data/` được ứng dụng tự tạo lúc khởi động nếu chưa có.
- Schema khai báo tại `prisma/schema.prisma`; thay đổi schema bằng **Prisma Migrate**, không tự đồng bộ khi khởi động.
- Khoá chính là **UUID** (`@default(uuid())`).
- Mọi cột thời gian dùng `DateTime`; `createdAt` tự điền khi tạo, `updatedAt` do repository gán khi cập nhật (bản ghi mới có `updatedAt = null`).
- Model đặt trong `prisma/schema.prisma`; type sinh ra được dùng trực tiếp (`User`, `Auth`, `RefreshToken` từ `@prisma/client`).
- Repository nền: `src/providers/abstract-base/repositories/prisma-base.repository.ts` — mọi filter tự động thêm `isDeleted: false` (soft delete).
- File `.db` / `.sqlite` / `.sqlite3` và thư mục `data/` đã được `.gitignore`.

Các lệnh thường dùng:

```bash
npm run db:migrate    # tạo migration mới khi sửa schema (dev)
npm run db:deploy     # áp migration đã commit (máy mới / production)
npm run db:generate   # sinh lại Prisma Client
npm run db:studio     # mở giao diện xem dữ liệu
```

Thiết lập máy mới: `npm install` → `cp .env.example .env` → `npm run db:deploy` → `npm run seed:permissions` → `npm run seed:super-admin`.

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
```

Chạy lại nhiều lần vẫn an toàn: vai trò và quyền được upsert theo `code`, còn quyền mặc định chỉ
được cấp cho vai trò chưa từng có bản ghi cấp quyền nào — nên cấu hình đã chỉnh trên hệ thống không
bị ghi đè.

Thêm nghiệp vụ mới: thêm một dòng vào `PERMISSION_CATALOG` rồi chạy lại `npm run seed:permissions`.

API quản trị nằm dưới `/permission`: `GET /permission/me`, `GET /permission/catalog`,
`GET /permission/roles`, `GET /permission/roles/:code/permissions`,
`PUT /permission/roles/:code/permissions`, `PATCH /permission/users/:userId/role`.

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
- **Prisma 6** + **SQLite**
- **Passport JWT** cho xác thực
- **class-validator** + **class-transformer** cho DTO
- **@nestjs/swagger** cho API docs
- **nodemailer** + **handlebars** cho gửi email template
- **bcrypt** cho hash mật khẩu

---

## 13. License

UNLICENSED — dự án nội bộ.
