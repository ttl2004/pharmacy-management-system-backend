import { AuthRole } from 'src/common/types/common.enum';
import type { JwtUser } from '../../feature-auth/authz/types/authz.types';
import type { PermissionService } from '../../feature-auth/permission/permission.service';

/**
 * Quyền thấy giá nhập / giá vốn / tiền phiếu nhập (K8): người lập phiếu nhập hoặc người sửa bảng giá. Cùng luật với
 * `price-book-rows.service`. `goods-receipt:read` / `stock:read` không dùng được vì nhân viên bán hàng cũng có.
 */
const COST_PERMISSIONS = ['goods-receipt:create', 'price-book:update'] as const;

/** SUPER_ADMIN luôn thấy; vai trò khác cần một trong `COST_PERMISSIONS`. */
export async function canSeeCost(
  permissions: Pick<PermissionService, 'getGrantedCodes'>,
  user: Pick<JwtUser, 'role'>,
): Promise<boolean> {
  if (user.role === AuthRole.SUPER_ADMIN) return true;
  const granted = await permissions.getGrantedCodes(user.role);
  return COST_PERMISSIONS.some((code) => granted.has(code));
}
