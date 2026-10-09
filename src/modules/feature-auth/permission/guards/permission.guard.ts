import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthRole } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';
import { authError } from '../../authz/auth.error';
import type { JwtUser } from '../../authz/types/authz.types';
import { PermissionCode } from '../permission.constant';
import { REQUIRED_PERMISSIONS } from '../decorators/require-permissions.decorator';
import { permissionError } from '../permission.error';
import { PermissionService } from '../permission.service';

@Injectable()
export class PermissionGuard implements CanActivate {
  private readonly logger = new Logger(PermissionGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly permissions: PermissionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<PermissionCode[] | undefined>(REQUIRED_PERMISSIONS, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (required === undefined) {
      this.logger.error(
        `Route ${context.getClass().name}.${context.getHandler().name} gắn PermissionGuard nhưng chưa khai báo quyền`,
      );
      throw permissionError(ErrorCode.PERMISSION_NOT_DECLARED);
    }

    const request = context.switchToHttp().getRequest<{ user?: JwtUser }>();
    const user = request.user;
    // Kiểm tra trước cả nhánh @AnyAuthenticated: thiếu AuthzGuard phía trước thì route phải hỏng
    // theo hướng chặn, không được biến thành công khai.
    if (!user) throw authError(ErrorCode.INVALID_TOKEN);

    if (required.length === 0) return true;
    if (user.role === AuthRole.SUPER_ADMIN) return true;

    const granted = await this.permissions.getGrantedCodes(user.role);
    const missing = required.filter((code) => !granted.has(code));
    if (missing.length) {
      // Danh sách quyền còn thiếu chỉ ghi log, không trả ra client để khỏi lộ chi tiết nội bộ.
      this.logger.warn(`Người dùng ${user.userId} thiếu quyền: ${missing.join(', ')}`);
      throw permissionError(ErrorCode.PERMISSION_DENIED);
    }

    return true;
  }
}
