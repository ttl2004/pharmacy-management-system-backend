/**
 * Sinh mã vai trò từ tên hiển thị: bỏ dấu tiếng Việt (`đ` → `d`), viết HOA, gom mọi ký tự không phải
 * chữ/số thành `_`, cắt `_` ở hai đầu, tối đa 50 ký tự (độ dài cột `roles.code`). Rỗng nghĩa là tên không
 * chứa chữ/số nào để dựng mã.
 */
export function toRoleCode(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50)
    .replace(/_+$/g, '');
}
