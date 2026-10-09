import { SetMetadata } from '@nestjs/common';
import type { PermissionCode } from '../permission.constant';

export const REQUIRED_PERMISSIONS = 'required_permissions';

/** Route chỉ chạy khi vai trò của người gọi có đủ mọi quyền liệt kê ở đây. */
export const RequirePermissions = (...codes: PermissionCode[]) => SetMetadata(REQUIRED_PERMISSIONS, codes);

/**
 * Route chỉ cần đăng nhập, không cần quyền cụ thể.
 *
 * Phải ghi rõ ra vì `PermissionGuard` chặn mọi route không khai báo quyền — cố ý để quên
 * khai báo là hỏng theo hướng an toàn chứ không mở toang.
 */
export const AnyAuthenticated = () => SetMetadata(REQUIRED_PERMISSIONS, []);
