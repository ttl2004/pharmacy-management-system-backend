-- Năm vai trò hệ thống. UUID viết thẳng vì file migration không import được hằng số TypeScript.
INSERT INTO "roles" ("id", "isDeleted", "createdAt", "code", "name", "description", "level", "isSystem")
VALUES
  ('a0000000-0000-4000-8000-000000000001', false, CURRENT_TIMESTAMP, 'SUPER_ADMIN', 'Quản trị toàn hệ thống', 'Toàn quyền trên hệ thống', 100, true),
  ('a0000000-0000-4000-8000-000000000002', false, CURRENT_TIMESTAMP, 'ADMIN', 'Quản trị viên', 'Quản trị trong phạm vi được phân quyền', 80, true),
  ('a0000000-0000-4000-8000-000000000003', false, CURRENT_TIMESTAMP, 'PHARMACY_MANAGER', 'Quản lý nhà thuốc', 'Quản lý một chi nhánh nhà thuốc', 60, true),
  ('a0000000-0000-4000-8000-000000000004', false, CURRENT_TIMESTAMP, 'SALES_STAFF', 'Nhân viên bán hàng', 'Nhân viên bán hàng / dược sĩ', 40, true),
  ('a0000000-0000-4000-8000-000000000005', false, CURRENT_TIMESTAMP, 'CUSTOMER', 'Khách hàng', 'Khách hàng mua thuốc', 20, true);

-- RedefineTables: chuyển users.role (chuỗi) thành khoá ngoại roleId.
-- SQLite không đổi được cột tại chỗ nên phải dựng bảng mới rồi đổi tên.
-- defer_foreign_keys mới có tác dụng bên trong transaction, foreign_keys thì không.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" DATETIME,
    "updatedBy" TEXT,
    "phoneNumber" TEXT,
    "email" TEXT NOT NULL,
    "address" TEXT,
    "fullName" TEXT NOT NULL,
    "age" TEXT,
    "gender" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "roleId" TEXT NOT NULL,
    CONSTRAINT "users_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Giá trị role không khớp vai trò nào (ví dụ 'MEMBER' còn sót) rơi về CUSTOMER — quyền thấp nhất.
INSERT INTO "new_users" ("id", "isDeleted", "createdAt", "createdBy", "updatedAt", "updatedBy", "phoneNumber", "email", "address", "fullName", "age", "gender", "status", "roleId")
SELECT "id", "isDeleted", "createdAt", "createdBy", "updatedAt", "updatedBy", "phoneNumber", "email", "address", "fullName", "age", "gender", "status",
       COALESCE((SELECT "id" FROM "roles" WHERE "roles"."code" = "users"."role"), 'a0000000-0000-4000-8000-000000000005')
FROM "users";

DROP TABLE "users";
ALTER TABLE "new_users" RENAME TO "users";

CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
