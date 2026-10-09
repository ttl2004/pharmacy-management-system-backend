// Trạng thái, giới tính và trạng thái người dùng dùng thẳng enum do Prisma sinh
// (RecordStatus, Gender, UserStatus trong @prisma/client) — chúng là object thật lúc chạy
// nên dùng được cho cả kiểu lẫn @ApiProperty({ enum: ... }).

/**
 * Vai trò gắn với cột `roles.code` — cột này cố ý giữ dạng chuỗi tự do chứ không phải enum CSDL,
 * vì danh mục vai trò là dữ liệu seed chứ không phải ràng buộc schema.
 */
export enum AuthRole {
  SUPER_ADMIN = 'SUPER_ADMIN',
  ADMIN = 'ADMIN',
  PHARMACY_MANAGER = 'PHARMACY_MANAGER',
  SALES_STAFF = 'SALES_STAFF',
  CUSTOMER = 'CUSTOMER',
}
