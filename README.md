# Pharmacy Management System — Backend

REST API cho hệ thống quản lý nhà thuốc, xây dựng trên **NestJS 12 + TypeORM + SQLite**.

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

Mở `.env` và chỉnh các giá trị cho phù hợp (port, JWT secret, mailer, …).

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
├── main.ts                       # Bootstrap (port, CORS, global pipes, seed)
├── common/
│   ├── configs/                  # Configuration loader (ConfigService)
│   ├── databases/                # TypeORM DataSource / driver module
│   ├── exceptions/               # Global exception filter
│   ├── interceptors/             # Transform interceptor (response shape)
│   └── types/                    # Enum / type chung
├── modules/
│   └── feature-auth/             # Module xác thực & phân quyền
│       ├── authz/                # Login / refresh / logout
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
| `JWT_ACCESS_SECRET` | Secret ký access token | (bắt buộc) |
| `JWT_REFRESH_SECRET` | Secret ký refresh token | (bắt buộc) |
| `JWT_ACCESS_TTL` | Thời hạn access token | `15m` |
| `JWT_REFRESH_TTL` | Thời hạn refresh token | `7d` |
| `MAIL_HOST` | SMTP host | `smtp.gmail.com` |
| `MAIL_USER` | SMTP user | — |
| `MAIL_PASS` | SMTP app password | — |
| `MAIL_FROM` | Địa chỉ gửi | `MAIL_USER` |
| `SEED_SUPER_ADMIN_ON_BOOT` | Tự seed super-admin khi start | `true` |

> **Không commit file `.env`** — đã được liệt kê trong `.gitignore`.

---

## 6. Database

- **SQLite** (`sqlite3`), file mặc định tại root dự án.
- TypeORM `synchronize` được bật — schema tự đồng bộ với entity khi dev.
- File `.db` / `.sqlite` / `.sqlite3` đã được `.gitignore`.

Xem cấu hình tại: `src/common/configs/configuration.ts` và `src/common/databases/drivers/typeorm.module.ts`.

---

## 7. Seed super admin

Khi server khởi động, nếu `SEED_SUPER_ADMIN_ON_BOOT=true`, hệ thống sẽ tự tạo tài khoản super admin nếu chưa tồn tại (xem `src/scripts/seed-super-admin.ts`).

Bạn cũng có thể chạy thủ công:

```bash
npm run build
node dist/scripts/seed-super-admin.js
```

---

## 8. Test

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

## 9. Lint & Format

```bash
npm run lint           # oxlint (type-aware)
npm run format         # prettier cho src/ và test/
```

---

## 10. Logging

Dự án đang dùng `Logger` mặc định của NestJS — log được in ra **stdout/stderr** của terminal nơi bạn chạy lệnh. Chưa có cơ chế ghi file log. Nếu cần giữ log lâu dài, có thể cân nhắc tích hợp `nestjs-pino` hoặc `nest-winston`.

---

## 11. Công nghệ sử dụng

- **NestJS 12** (Express adapter)
- **TypeORM 0.3** + **SQLite3**
- **Passport JWT** cho xác thực
- **class-validator** + **class-transformer** cho DTO
- **@nestjs/swagger** cho API docs
- **nodemailer** + **handlebars** cho gửi email template
- **bcrypt** cho hash mật khẩu

---

## 12. License

UNLICENSED — dự án nội bộ.
