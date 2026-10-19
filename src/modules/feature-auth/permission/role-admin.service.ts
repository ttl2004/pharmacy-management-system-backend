import { Injectable } from '@nestjs/common';
import { Role } from '@prisma/client';
import { ErrorCode } from 'src/common/types/error-code';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { rethrowDuplicate } from 'src/common/exceptions/prisma-error';
import { PrismaService } from 'src/common/databases/prisma.service';
import type { JwtUser } from '../authz/types/authz.types';
import { permissionError } from './permission.error';
import { PermissionService } from './permission.service';
import { assertOutranks } from './role-hierarchy';
import { toRoleCode } from './role-code.util';
import type { CreateRoleRequest } from './dtos/role-create.request';
import { RoleRepository } from './repositories/role.repository';
import { RolePermissionRepository } from './repositories/role-permission.repository';

/** Cấp bậc CUSTOMER — vai trò tự tạo phải cao hơn mức này. */
const CUSTOMER_LEVEL = 20;

/** Độ dài tối đa cột `roles.code` (VarChar(50)). */
const ROLE_CODE_MAX_LENGTH = 50;

/** Quản trị vai trò: danh sách, tạo và xoá vai trò tự tạo. Ma trận quyền nằm ở `PermissionService`. */
@Injectable()
export class RoleAdminService {
  constructor(
    private readonly roles: RoleRepository,
    private readonly rolePermissions: RolePermissionRepository,
    private readonly prisma: PrismaService,
    private readonly permissionService: PermissionService,
  ) {}

  async getRoles() {
    const roles = await this.roles.findMany({}, { sort: { level: -1 }, limit: 100 });
    const counts = await this.rolePermissions.countActivePerRole();
    const userCounts = await this.countActiveUsersPerRole();

    return roles.map((role) => this.toRoleItem(role, counts.get(role.id) ?? 0, userCounts.get(role.id) ?? 0));
  }

  /**
   * Tạo vai trò tự tạo (`isSystem=false`). Mã sinh từ tên; cấp bậc phải nằm giữa CUSTOMER và người gọi.
   * Vai trò tự tạo luôn có phạm vi BRANCH (xem `branchScopeKindOf`).
   */
  async createRole(dto: CreateRoleRequest, caller: JwtUser) {
    // Cả hai vế dùng 1508 nhưng kèm message riêng cho đúng ngữ cảnh "tạo vai trò".
    if (!(dto.level > CUSTOMER_LEVEL) || !(dto.level < caller.roleLevel)) {
      throw permissionError(
        ErrorCode.ROLE_LEVEL_FORBIDDEN,
        `Level phải lớn hơn ${CUSTOMER_LEVEL} và nhỏ hơn level của bạn`,
      );
    }

    const code = toRoleCode(dto.name);
    if (!code) {
      throw new ErrorException({ code: ErrorCode.HTTP_BAD_REQUEST, message: 'Tên vai trò phải chứa chữ hoặc số' });
    }
    // Cột `code` unique tính cả bản ghi xoá mềm, nên kiểm tra không lọc `isDeleted`.
    if (await this.prisma.role.findUnique({ where: { code }, select: { id: true } })) {
      throw new ErrorException({ code: ErrorCode.DUPLICATE_CODE, message: `Mã vai trò ${code} đã tồn tại` });
    }

    const wanted = [...new Set(dto.permissionCodes)];
    const permissionIds = await this.permissionService.resolvePermissionIds(wanted, new Set(), caller);

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const role = await tx.role.create({
          data: {
            code,
            name: dto.name,
            description: dto.description || null,
            level: dto.level,
            isSystem: false,
            createdBy: caller.userId,
          },
        });
        if (permissionIds.length) {
          await tx.rolePermission.createMany({
            data: permissionIds.map((permissionId) => ({ roleId: role.id, permissionId, createdBy: caller.userId })),
          });
        }
        return role;
      });
      return this.toRoleItem(created, permissionIds.length, 0);
    } catch (error) {
      rethrowDuplicate(error);
    } finally {
      this.permissionService.clearGrantCache();
    }
  }

  /**
   * Xoá mềm vai trò tự tạo. Chỉ user CHƯA xoá còn trỏ tới mới chặn (1510); user đã xoá mềm bị bỏ qua.
   * Đổi `code` thành `<code>_DEL_<hậu tố>` để nhả mã unique cho vai trò tạo lại sau này.
   */
  async deleteRole(roleCode: string, caller: JwtUser): Promise<{ success: true }> {
    const role = await this.permissionService.requireRole(roleCode);
    if (role.isSystem) throw permissionError(ErrorCode.ROLE_NOT_EDITABLE);
    assertOutranks(caller.roleLevel, role.level);
    if (await this.prisma.user.count({ where: { roleId: role.id, isDeleted: false } })) {
      throw permissionError(ErrorCode.ROLE_IN_USE);
    }

    // Hậu tố 6 ký tự base36; cắt phần mã gốc để tổng không vượt cột VarChar(50).
    const suffix = `_DEL_${Date.now().toString(36).slice(-6)}`;
    const deletedCode = `${role.code.slice(0, ROLE_CODE_MAX_LENGTH - suffix.length)}${suffix}`;
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.rolePermission.deleteMany({ where: { roleId: role.id } });
        await tx.role.update({
          where: { id: role.id },
          data: { isDeleted: true, code: deletedCode, updatedBy: caller.userId, updatedAt: new Date() },
        });
      });
    } finally {
      this.permissionService.clearGrantCache();
    }
    return { success: true };
  }

  /** Số user chưa xoá của từng vai trò. */
  private async countActiveUsersPerRole(): Promise<Map<string, number>> {
    const rows = await this.prisma.user.groupBy({
      by: ['roleId'],
      where: { isDeleted: false },
      _count: { _all: true },
    });
    return new Map(rows.map((row) => [row.roleId, row._count._all]));
  }

  private toRoleItem(role: Role, permissionCount: number, userCount: number) {
    return {
      code: role.code,
      name: role.name,
      description: role.description,
      level: role.level,
      permissionCount,
      isSystem: role.isSystem,
      userCount,
      createdAt: role.createdAt,
    };
  }
}
