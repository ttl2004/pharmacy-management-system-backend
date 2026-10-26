import { Injectable, Logger } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { SYSTEM_ACTOR_ID } from 'src/common/constants/app.constant';
import { AuthRole } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { lockAdvisoryKeys } from 'src/common/databases/advisory-lock';
import { PrismaService } from 'src/common/databases/prisma.service';
import { UserRepository } from '../user/repositories/user.repository';
import { UserService } from '../user/user.service';
import type { JwtUser } from '../authz/types/authz.types';
import { PERMISSION_CATALOG, PERMISSION_CODES, PermissionCode } from './permission.constant';
import { DEFAULT_ROLE_GRANTS, ROLE_CATALOG, RoleCode } from './role.constant';
import { permissionError } from './permission.error';
import { branchScopeKindOf, isInBranchScope, resolveBranchScope } from './branch-scope';
import { assertGrantable, assertOutranks } from './role-hierarchy';
import { assertRoleWithinCallerGrants } from './role-grant-guard';
import { RoleRepository } from './repositories/role.repository';
import { PermissionRepository } from './repositories/permission.repository';
import { RolePermissionRepository } from './repositories/role-permission.repository';

/**
 * Quyền của vai trò được cache trong bộ nhớ vì guard đọc nó ở MỌI request (2 lượt DB ~200 ms qua pooler).
 * Mọi đường ghi ma trận trong tiến trình này đều xoá cache; TTL ngắn lo phần ghi từ tiến trình khác
 * (script seed, instance thứ hai) — nhiều instance thật sự thì cần Redis.
 */
const GRANT_CACHE_TTL_MS = 30_000;

@Injectable()
export class PermissionService {
  private readonly logger = new Logger(PermissionService.name);
  private readonly grantCache = new Map<string, { codes: Set<PermissionCode>; expiresAt: number }>();

  constructor(
    private readonly roles: RoleRepository,
    private readonly permissions: PermissionRepository,
    private readonly rolePermissions: RolePermissionRepository,
    private readonly users: UserRepository,
    private readonly prisma: PrismaService,
    private readonly userService: UserService,
  ) {}

  /** Quyền đang có của một vai trò. Guard gọi hàm này ở mỗi request. */
  async getGrantedCodes(roleCode: string): Promise<Set<PermissionCode>> {
    const cached = this.grantCache.get(roleCode);
    // Trả bản sao: caller sửa Set cũng không làm bẩn cache.
    if (cached && cached.expiresAt > Date.now()) return new Set(cached.codes);

    const role = await this.roles.findOne({ code: roleCode });
    if (!role) return new Set();

    const codes = new Set((await this.rolePermissions.findGrantedCodes(role.id)) as PermissionCode[]);
    this.grantCache.set(roleCode, { codes, expiresAt: Date.now() + GRANT_CACHE_TTL_MS });
    return new Set(codes);
  }

  /** Xoá cache quyền — dịch vụ ghi vai trò (RoleAdminService) gọi sau mỗi lần ghi. */
  clearGrantCache(): void {
    this.grantCache.clear();
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

  async getRoleMatrix(roleCode: string) {
    const role = await this.requireRole(roleCode);
    return { role: this.toRoleView(role), permissionCodes: await this.rolePermissions.findGrantedCodes(role.id) };
  }

  async replaceRolePermissions(roleCode: string, codes: PermissionCode[], caller: JwtUser) {
    const role = await this.requireRole(roleCode);
    // SUPER_ADMIN luôn có mọi quyền nhờ bỏ qua kiểm tra, bản ghi cấp quyền cho nó là vô nghĩa.
    if ((role.code as AuthRole) === AuthRole.SUPER_ADMIN) throw permissionError(ErrorCode.ROLE_NOT_EDITABLE);
    // Rào cấp bậc: chỉ sửa được ma trận của vai trò thấp hơn mình (1508) — kể cả vai trò của chính mình.
    assertOutranks(caller.roleLevel, role.level);

    const wanted = [...new Set(codes)];
    const current = new Set(await this.rolePermissions.findGrantedCodes(role.id));
    const permissionIds = await this.resolvePermissionIds(wanted, current, caller);
    try {
      await this.writeRolePermissions(role.id, (tx) =>
        this.rolePermissions.replaceForRole(tx, role.id, permissionIds, caller.userId),
      );
    } finally {
      // Xoá cả khi lỗi: không biết chắc transaction đã commit tới đâu.
      this.grantCache.clear();
    }

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

    // Luật 14 cũng áp cho đường đổi vai trò: không ai đổi được vai trò của tài khoản SUPER_ADMIN (1604).
    if ((target.role.code as AuthRole) === AuthRole.SUPER_ADMIN) {
      throw new ErrorException({
        code: ErrorCode.SUPER_ADMIN_PROTECTED,
        message: 'Không thể thay đổi tài khoản quản trị tối cao',
      });
    }
    // Luật 11 cũng áp ở đây: SUPER_ADMIN chỉ sinh ra từ seed, không gán qua API (1603).
    if ((role.code as AuthRole) === AuthRole.SUPER_ADMIN) {
      throw new ErrorException({
        code: ErrorCode.ROLE_NOT_ASSIGNABLE,
        message: 'Không thể gán vai trò SUPER_ADMIN qua API',
      });
    }
    // Rào cấp bậc: người bị đổi và vai trò mới đều phải thấp hơn người gọi (1508).
    assertOutranks(caller.roleLevel, target.role.level);
    assertOutranks(caller.roleLevel, role.level);
    // Vai trò mới không được mang quyền người gọi không có (1509) — chặn leo thang gián tiếp.
    await assertRoleWithinCallerGrants(this.prisma, role.id, caller);

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

    try {
      await this.applyDefaultGrants();
    } finally {
      this.grantCache.clear();
    }
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
      const granted = await this.writeRolePermissions(role.id, (tx) =>
        this.rolePermissions.grantMissing(tx, role.id, permissionIds, SYSTEM_ACTOR_ID),
      );
      if (granted) this.logger.log(`Đã cấp ${granted} quyền mặc định mới cho ${roleCode}`);
    }
  }

  /**
   * Ghi quyền của một vai trò. Cả `replaceForRole` lẫn `grantMissing` đều đọc quyền đang có rồi mới `createMany` phần
   * thiếu: hai lần ghi cùng vai trò chen nhau (vd. hai instance khởi động cùng lúc, hoặc lúc đang lưu ma trận quyền)
   * sẽ cùng chèn một cặp (vai trò, quyền) và lỗi trùng khoá — nên khoá theo vai trò cho chạy nối tiếp.
   */
  private writeRolePermissions<T>(roleId: string, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await lockAdvisoryKeys(tx, [`role-permissions:${roleId}`]);
      return work(tx);
    });
  }

  /**
   * Đổi mã quyền thành id, dùng chung cho tạo vai trò và ghi đè ma trận: 1503 nếu mã không có trong danh mục,
   * 1509 nếu cấp thêm quyền mà chính người gọi không có (SUPER_ADMIN bỏ qua) — chặn leo thang đặc quyền.
   */
  async resolvePermissionIds(
    wanted: PermissionCode[],
    current: ReadonlySet<string>,
    caller: JwtUser,
  ): Promise<string[]> {
    const catalog = await this.permissions.findAllOrdered();
    const idByCode = new Map(catalog.map((permission) => [permission.code, permission.id]));

    const unknown = wanted.filter((code) => !idByCode.has(code));
    if (unknown.length) {
      this.logger.warn(`Mã quyền không có trong danh mục: ${unknown.join(', ')}`);
      throw permissionError(ErrorCode.PERMISSION_NOT_FOUND);
    }

    const callerCodes = caller.role === AuthRole.SUPER_ADMIN ? null : await this.getGrantedCodes(caller.role);
    assertGrantable(wanted, current, callerCodes);

    return wanted.map((code) => idByCode.get(code) as string);
  }

  async requireRole(code: string): Promise<Role> {
    const role = await this.roles.findOne({ code });
    if (!role) throw permissionError(ErrorCode.ROLE_NOT_FOUND);
    return role;
  }

  private toRoleView(role: Role) {
    return { code: role.code, name: role.name, description: role.description, level: role.level };
  }
}
