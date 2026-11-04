/**
 * Nhân viên = mọi vai trò khác `CUSTOMER` (D1). Vai trò lạ hay không rõ cũng tính là nhân viên, để nếu sai thì lệch
 * về phía ghi thừa chứ không bỏ sót.
 */
export function isStaffRole(roleCode: string | null | undefined): boolean {
  return roleCode !== 'CUSTOMER';
}
