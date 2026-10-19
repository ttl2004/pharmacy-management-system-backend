import { AuthRole } from 'src/common/types/common.enum';
import type { PrismaService } from 'src/common/databases/prisma.service';
import type { JwtUser } from '../authz/types/authz.types';
import { assertGrantable } from './role-hierarchy';

/** Mã quyền đang hoạt động của một vai trò (đọc thẳng DB, không cache — chỉ chạy ở đường ghi). */
async function grantedCodesOf(prisma: PrismaService, where: { id: string } | { code: string }): Promise<Set<string>> {
  const rows = await prisma.rolePermission.findMany({
    where: { isDeleted: false, role: { ...where, isDeleted: false } },
    select: { permission: { select: { code: true } } },
  });
  return new Set(rows.map((row) => row.permission.code));
}

/**
 * Chặn leo thang đặc quyền gián tiếp qua việc gán vai trò: người gọi (không phải SUPER_ADMIN) chỉ được
 * gán/tạo người dùng với vai trò có tập quyền ⊆ tập quyền của chính mình → 1509. Cấp bậc (level) một mình
 * chưa đủ vì vai trò tự tạo có thể mang quyền mà người gọi không có.
 */
export async function assertRoleWithinCallerGrants(
  prisma: PrismaService,
  targetRoleId: string,
  caller: JwtUser,
): Promise<void> {
  if (caller.role === AuthRole.SUPER_ADMIN) return;
  const [wanted, callerCodes] = await Promise.all([
    grantedCodesOf(prisma, { id: targetRoleId }),
    grantedCodesOf(prisma, { code: caller.role }),
  ]);
  assertGrantable([...wanted], new Set(), callerCodes);
}
