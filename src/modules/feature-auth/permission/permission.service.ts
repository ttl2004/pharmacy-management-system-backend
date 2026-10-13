import { Injectable, Logger } from '@nestjs/common';
import { Role } from '@prisma/client';
import { SYSTEM_ACTOR_ID } from 'src/common/constants/app.constant';
import { AuthRole } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { SessionTransactions } from '../authz/session.store';
import { UserRepository } from '../user/repositories/user.repository';
import { UserService } from '../user/user.service';
import type { JwtUser } from '../authz/types/authz.types';
import { PERMISSION_CATALOG, PERMISSION_CODES, PermissionCode } from './permission.constant';
import { DEFAULT_ROLE_GRANTS, ROLE_CATALOG, RoleCode } from './role.constant';
import { permissionError } from './permission.error';
import { branchScopeKindOf, isInBranchScope, resolveBranchScope } from './branch-scope';
import { RoleRepository } from './repositories/role.repository';
import { PermissionRepository } from './repositories/permission.repository';
import { RolePermissionRepository } from './repositories/role-permission.repository';

@Injectable()
export class PermissionService {
  private readonly logger = new Logger(PermissionService.name);

  constructor(
    private readonly roles: RoleRepository,
    private readonly permissions: PermissionRepository,
    private readonly rolePermissions: RolePermissionRepository,
    private readonly users: UserRepository,
    private readonly transactions: SessionTransactions,
    private readonly userService: UserService,
  ) {}

  /** Quyền đang có của một vai trò. Guard gọi hàm này ở mỗi request. */
  async getGrantedCodes(roleCode: string): Promise<Set<PermissionCode>> {
    const role = await this.roles.findOne({ code: roleCode });
    if (!role) return new Set();

    const codes = await this.rolePermissions.findGrantedCodes(role.id);
    return new Set(codes as PermissionCode[]);
  }

  async getCatalog() {
    const permissions = await this.permissions.findAllOrdered();
    return permissions.map((permission) => ({
      code: permission.code,
      name: permission.name,
      module: permission.module,
      sortOrder: permission.sortOrder,
    }));
  }

  async getRoles() {
    const roles = await this.roles.findMany({}, { sort: { level: -1 }, limit: 100 });
    const counts = await this.rolePermissions.countActivePerRole();

    return roles.map((role) => ({
      code: role.code,
      name: role.name,
      description: role.description,
      level: role.level,
      permissionCount: counts.get(role.id) ?? 0,
    }));
  }

  async getRoleMatrix(roleCode: string) {
    const role = await this.requireRole(roleCode);
    return { role: this.toRoleView(role), permissionCodes: await this.rolePermissions.findGrantedCodes(role.id) };
  }

  async replaceRolePermissions(roleCode: string, codes: PermissionCode[], actorId: string) {
    const role = await this.requireRole(roleCode);
    // SUPER_ADMIN luôn có mọi quyền nhờ bỏ qua kiểm tra, bản ghi cấp quyền cho nó là vô nghĩa.
    if ((role.code as AuthRole) === AuthRole.SUPER_ADMIN) throw permissionError(ErrorCode.ROLE_NOT_EDITABLE);

    const catalog = await this.permissions.findAllOrdered();
    const idByCode = new Map(catalog.map((permission) => [permission.code, permission.id]));

    const wanted = [...new Set(codes)];
    const unknown = wanted.filter((code) => !idByCode.has(code));
    if (unknown.length) {
      this.logger.warn(`Mã quyền không có trong danh mục: ${unknown.join(', ')}`);
      throw permissionError(ErrorCode.PERMISSION_NOT_FOUND);
    }

    const permissionIds = wanted.map((code) => idByCode.get(code) as string);
    await this.transactions.write(async (tx) => {
      await this.rolePermissions.replaceForRole(tx, role.id, permissionIds, actorId);
    });

    return { role: this.toRoleView(role), permissionCodes: wanted };
  }

  /** Quyền của chính người đang đăng nhập — giao diện dùng để ẩn/hiện nút và ô chọn chi nhánh. */
  async getMyPermissions(user: JwtUser) {
    const isSuperAdmin = user.role === AuthRole.SUPER_ADMIN;
    const permissions = isSuperAdmin ? [...PERMISSION_CODES] : [...(await this.getGrantedCodes(user.role))];
    return {
      role: user.role,
      isSuperAdmin,
      permissions,
      branchId: user.branchId,
      branchScope: branchScopeKindOf(user.role),
    };
  }

  async assignRole(userId: string, roleCode: string, caller: JwtUser) {
    if (userId === caller.userId) throw permissionError(ErrorCode.CANNOT_CHANGE_OWN_ROLE);
    const scope = resolveBranchScope(caller);

    const role = await this.requireRole(roleCode);
    const target = await this.users.findByIdWithRole(userId);
    // Ngoài phạm vi chi nhánh thì coi như không tồn tại — cùng luật với UserService (BS-05).
    if (!target || !isInBranchScope(scope, target.branchId)) {
      throw new ErrorException({ code: ErrorCode.USER_NOT_FOUND, message: 'Người dùng không tồn tại' });
    }

    // Luật 10 phải áp cho MỌI đường đổi vai trò, không chỉ tạo/sửa hồ sơ. Đây là đường DUY NHẤT
    // đổi được vai trò, nên bỏ sót ở đây là tạo ra bản ghi vi phạm bất biến mà `UserService`
    // vừa thi hành — ví dụ gán PHARMACY_MANAGER cho người đang có `branchId = null`.
    await this.userService.assertBranchRule(role.code, target.branchId);

    const updated = await this.users.update({ id: userId }, { roleId: role.id, updatedBy: caller.userId });
    if (!updated) {
      throw new ErrorException({ code: ErrorCode.USER_NOT_FOUND, message: 'Người dùng không tồn tại' });
    }

    return { userId, roleCode: role.code };
  }

  /** Seed danh mục vai trò, danh mục quyền và quyền cấp mặc định. Chạy lại nhiều lần vẫn an toàn. */
  async seedCatalog(): Promise<void> {
    for (const role of ROLE_CATALOG) {
      const existing = await this.roles.findOne({ code: role.code });
      if (existing) {
        await this.roles.update(
          { id: existing.id },
          { name: role.name, description: role.description, level: role.level },
        );
      } else {
        await this.roles.create({ ...role, isSystem: true });
      }
    }

    for (const permission of PERMISSION_CATALOG) {
      const existing = await this.permissions.findOne({ code: permission.code });
      if (existing) {
        await this.permissions.update(
          { id: existing.id },
          { name: permission.name, module: permission.module, sortOrder: permission.sortOrder },
        );
      } else {
        await this.permissions.create({ ...permission });
      }
    }

    await this.applyDefaultGrants();
  }

  /**
   * Cấp quyền mặc định theo **từng cặp (vai trò, quyền)** chưa từng có bản ghi — xem
   * `RolePermissionRepository.grantMissing`. Chạy lại nhiều lần vẫn an toàn, và không cấp lại quyền đã bị thu
   * hồi trên giao diện.
   */
  private async applyDefaultGrants(): Promise<void> {
    const catalog = await this.permissions.findAllOrdered();
    const idByCode = new Map(catalog.map((permission) => [permission.code, permission.id]));
    const entries = Object.entries(DEFAULT_ROLE_GRANTS) as [RoleCode, readonly PermissionCode[] | undefined][];

    for (const [roleCode, codes] of entries) {
      if (!codes?.length) continue;

      const role = await this.roles.findOne({ code: roleCode });
      if (!role) continue;

      const permissionIds = codes.map((code) => idByCode.get(code)).filter((id): id is string => Boolean(id));
      // `createdBy`/`updatedBy` là cột uuid, không được ghi chuỗi tự do.
      const granted = await this.transactions.write((tx) =>
        this.rolePermissions.grantMissing(tx, role.id, permissionIds, SYSTEM_ACTOR_ID),
      );
      if (granted) this.logger.log(`Đã cấp ${granted} quyền mặc định mới cho ${roleCode}`);
    }
  }

  private async requireRole(code: string): Promise<Role> {
    const role = await this.roles.findOne({ code });
    if (!role) throw permissionError(ErrorCode.ROLE_NOT_FOUND);
    return role;
  }

  private toRoleView(role: Role) {
    return { code: role.code, name: role.name, description: role.description, level: role.level };
  }
}
