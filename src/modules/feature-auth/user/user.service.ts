import { Injectable } from '@nestjs/common';
import { Branch, Role, User, UserStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { APP_CONSTANTS } from 'src/common/constants/app.constant';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { rethrowDuplicate } from 'src/common/exceptions/prisma-error';
import { ErrorCode } from 'src/common/types/error-code';
import { normalizePhoneSearch } from 'src/common/utils/phone.util';
import { PrismaService } from 'src/common/databases/prisma.service';
import { AbstractBaseService } from 'src/providers/abstract-base/abstract-base.service';
import { BaseWhere } from 'src/providers/abstract-base/repositories/abstract-base.repository';
import { SessionStore } from '../authz/session.store';
import type { JwtUser } from '../authz/types/authz.types';
import {
  assertBranchInScope,
  BRANCH_BOUND_ROLES,
  type BranchScope,
  isInBranchScope,
  resolveBranchScope,
  scopedBranchFilter,
} from '../permission/branch-scope';
import { assertOutranks } from '../permission/role-hierarchy';
import { CreateUserRequest, UpdateUserRequest } from './dtos/user.request';
import { UserQuery } from './dtos/user.query';
import { UserRepository } from './repositories/user.repository';

export type UserDetail = User & { role: Role; branch: Branch | null };

const SUPER_ADMIN_ROLE = 'SUPER_ADMIN';

@Injectable()
export class UserService extends AbstractBaseService<User> {
  constructor(
    private readonly userRepository: UserRepository,
    private readonly prisma: PrismaService,
    private readonly sessions: SessionStore,
  ) {
    super(userRepository);
  }

  async list(query: UserQuery, caller: JwtUser) {
    // Phạm vi chi nhánh kiểm trước mọi truy vấn (BS-04). Với nhân viên chi nhánh, bộ lọc luôn là chi nhánh
    // của họ — admin và khách hàng có branchId null (luật 10) nên tự rơi khỏi danh sách.
    const branchId = scopedBranchFilter(resolveBranchScope(caller), query.branchId);
    const filter: BaseWhere<User> = {};

    if (query.roleCode) {
      const roleId = await this.userRepository.findRoleIdByCode(query.roleCode);
      // Vai trò không tồn tại thì trả rỗng ngay, không ném lỗi — đây là bộ lọc, không phải tra cứu.
      // Không thể nhét giá trị sentinel vào `filter.roleId`: cột đó là uuid, chuỗi lạ sẽ ném lỗi
      // ở tầng CSDL và bộ lọc ngoại lệ biến nó thành 500.
      if (!roleId) {
        return { hits: [], total: 0, page: query.page, totalPages: 0, limit: query.limit };
      }
      filter.roleId = roleId;
    }
    if (branchId) filter.branchId = branchId;
    if (query.status) filter.status = query.status;

    return this.userRepository.findManyWithPagination(filter, {
      page: query.page,
      limit: query.limit,
      sort: query.sort,
      search: query.search && normalizePhoneSearch(query.search),
      searchFields: ['phoneNumber', 'fullName', 'email'],
      relations: { role: true, branch: true },
    });
  }

  async getDetail(id: string, caller: JwtUser): Promise<UserDetail> {
    const scope = resolveBranchScope(caller);
    const user = await this.userRepository.findByIdWithRoleAndBranch(id);
    // Ngoài phạm vi chi nhánh thì trả như không tồn tại (BS-05) — không để lộ là có người dùng này.
    if (!user || !isInBranchScope(scope, user.branchId)) {
      throw new ErrorException({
        code: ErrorCode.USER_NOT_FOUND,
        message: 'Người dùng không tồn tại',
      });
    }
    return user;
  }

  async create(dto: CreateUserRequest, caller: JwtUser): Promise<User> {
    const scope = resolveBranchScope(caller);
    const hasUsername = Boolean(dto.username);
    const hasPassword = Boolean(dto.password);
    if (hasUsername !== hasPassword) {
      throw new ErrorException({
        code: ErrorCode.HTTP_BAD_REQUEST,
        message: 'username và password phải đi cùng nhau',
      });
    }

    // BS-06: nhân viên chi nhánh không gửi branchId thì tự điền chi nhánh của họ, gửi chi nhánh khác thì 1506.
    // Vai trò bắt buộc để trống chi nhánh (ADMIN, CUSTOMER) vì thế trượt luật 10 ngay bên dưới (BS-09).
    const branchId = dto.branchId ?? (scope.kind === 'BRANCH' ? scope.branchId : undefined);
    assertBranchInScope(scope, branchId);

    const role = await this.requireAssignableRole(dto.roleCode);
    // Rào cấp bậc: chỉ tạo được người có vai trò thấp hơn mình (1508).
    assertOutranks(caller.roleLevel, role.level);
    await this.assertBranchRule(role.code, branchId);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            fullName: dto.fullName,
            phoneNumber: dto.phoneNumber,
            email: dto.email ?? null,
            address: dto.address ?? null,
            dateOfBirth: dto.dateOfBirth ? new Date(`${dto.dateOfBirth}T00:00:00.000Z`) : null,
            gender: dto.gender ?? null,
            roleId: role.id,
            branchId: branchId ?? null,
            status: dto.status ?? UserStatus.ACTIVE,
            createdBy: caller.userId,
          },
        });

        if (hasUsername && dto.username && dto.password) {
          await tx.auth.create({
            data: {
              username: dto.username,
              password: await bcrypt.hash(dto.password, APP_CONSTANTS.BCRYPT_SALT),
              userId: user.id,
              createdBy: caller.userId,
            },
          });
        }

        return user;
      });
    } catch (error) {
      rethrowDuplicate(error);
    }
  }

  /** Vai trò phải tồn tại và không được là SUPER_ADMIN (luật 11). */
  async requireAssignableRole(code: string): Promise<Role> {
    const role = await this.prisma.role.findFirst({ where: { code, isDeleted: false } });
    if (!role) {
      throw new ErrorException({ code: ErrorCode.ROLE_NOT_FOUND, message: 'Vai trò không tồn tại' });
    }
    if (role.code === SUPER_ADMIN_ROLE) {
      throw new ErrorException({
        code: ErrorCode.ROLE_NOT_ASSIGNABLE,
        message: 'Không thể gán vai trò SUPER_ADMIN qua API',
      });
    }
    return role;
  }

  /**
   * Luật 10: vai trò gắn chi nhánh (`BRANCH_BOUND_ROLES`) bắt buộc có chi nhánh, vai trò còn lại bắt buộc để
   * trống. `undefined` (không gửi trường) được coi là null khi tạo mới.
   */
  async assertBranchRule(roleCode: string, branchId: string | null | undefined): Promise<void> {
    const needsBranch = BRANCH_BOUND_ROLES.includes(roleCode);
    const value = branchId ?? null;

    if (needsBranch && !value) {
      throw new ErrorException({
        code: ErrorCode.INVALID_REFERENCE,
        message: `Vai trò ${roleCode} bắt buộc phải thuộc một chi nhánh`,
      });
    }
    if (!needsBranch && value) {
      throw new ErrorException({
        code: ErrorCode.INVALID_REFERENCE,
        message: `Vai trò ${roleCode} không được gán chi nhánh`,
      });
    }
    if (!value) return;

    const branch = await this.prisma.branch.findFirst({
      where: { id: value, isDeleted: false },
      select: { id: true },
    });
    if (!branch) {
      throw new ErrorException({
        code: ErrorCode.INVALID_REFERENCE,
        message: 'Chi nhánh không tồn tại',
      });
    }
  }

  /**
   * Luật 14 + 15 + ràng buộc `branchId` theo vai trò + phạm vi chi nhánh + rào cấp bậc. KHÔNG đổi vai trò — việc đó đi qua
   * `PATCH /permission/users/:userId/role` với quyền `user:role:update`.
   */
  async update(id: string, dto: UpdateUserRequest, caller: JwtUser): Promise<User> {
    const scope = resolveBranchScope(caller);
    // Phạm vi đứng TRƯỚC luật 14 (BS-05): nhân viên chi nhánh nhắm vào tài khoản ngoài chi nhánh — kể cả
    // SUPER_ADMIN — phải nhận 1200 như không tồn tại, không được nhận 1604 làm lộ tài khoản đó.
    await this.assertTargetInScope(id, scope);
    await this.assertNotSuperAdminTarget(id);
    this.assertNotSelf(caller.userId, id, dto.status !== undefined);
    // BS-06: chuyển người dùng sang chi nhánh khác — kể cả gỡ về null — là ghi ra ngoài phạm vi.
    if (dto.branchId !== undefined) assertBranchInScope(scope, dto.branchId);

    const current = await this.userRepository.findByIdWithRole(id);
    if (!current) {
      throw new ErrorException({ code: ErrorCode.USER_NOT_FOUND, message: 'Người dùng không tồn tại' });
    }
    // Rào cấp bậc: không sửa được người cùng cấp hoặc cao hơn (1508). Tự sửa hồ sơ của mình vẫn được — phần
    // nguy hiểm (tự đổi trạng thái, tự xoá, tự đổi vai trò) đã bị luật 15 và mã 1505 chặn riêng.
    if (caller.userId !== id) assertOutranks(caller.roleLevel, current.role.level);

    // Chỉ kiểm luật chi nhánh khi client thực sự gửi trường đó; không gửi thì giữ nguyên giá trị cũ.
    if (dto.branchId !== undefined) {
      await this.assertBranchRule(current.role.code, dto.branchId);
    }

    const data: Partial<User> = { updatedBy: caller.userId };
    if (dto.fullName !== undefined) data.fullName = dto.fullName;
    if (dto.email !== undefined) data.email = dto.email;
    if (dto.address !== undefined) data.address = dto.address;
    if (dto.phoneNumber !== undefined) data.phoneNumber = dto.phoneNumber;
    if (dto.dateOfBirth !== undefined) {
      data.dateOfBirth = dto.dateOfBirth ? new Date(`${dto.dateOfBirth}T00:00:00.000Z`) : null;
    }
    if (dto.gender !== undefined) data.gender = dto.gender;
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.branchId !== undefined) data.branchId = dto.branchId ?? null;

    try {
      const updated = await this.userRepository.update({ id }, data);
      if (!updated) {
        throw new ErrorException({ code: ErrorCode.USER_NOT_FOUND, message: 'Người dùng không tồn tại' });
      }
      return updated;
    } catch (error) {
      rethrowDuplicate(error);
    }
  }

  /** Luật 13: xoá mềm + thu hồi mọi refresh token còn hiệu lực. */
  async remove(id: string, caller: JwtUser): Promise<{ success: true }> {
    const scope = resolveBranchScope(caller);
    await this.assertTargetInScope(id, scope);
    await this.assertNotSuperAdminTarget(id);
    this.assertNotSelfDelete(caller.userId, id);

    const target = await this.userRepository.findByIdWithRole(id);
    if (!target) {
      throw new ErrorException({ code: ErrorCode.USER_NOT_FOUND, message: 'Người dùng không tồn tại' });
    }
    // Rào cấp bậc: không xoá được người cùng cấp hoặc cao hơn (1508).
    assertOutranks(caller.roleLevel, target.role.level);

    const deleted = await this.userRepository.softDelete({ id });
    if (!deleted) {
      throw new ErrorException({ code: ErrorCode.USER_NOT_FOUND, message: 'Người dùng không tồn tại' });
    }

    // Thu hồi sau khi xoá: nếu bước này lỗi thì bản ghi đã xoá mềm rồi, phiên sẽ chết ở lần
    // refresh kế tiếp vì token trỏ tới user đã isDeleted.
    await this.sessions.revokeAllByUser(id);

    return { success: true };
  }

  /** Luật 14: không ai sửa/xoá được tài khoản SUPER_ADMIN. */
  async assertNotSuperAdminTarget(id: string): Promise<void> {
    const target = await this.userRepository.findByIdWithRole(id);
    if (!target) {
      throw new ErrorException({ code: ErrorCode.USER_NOT_FOUND, message: 'Người dùng không tồn tại' });
    }
    if (target.role.code === SUPER_ADMIN_ROLE) {
      throw new ErrorException({
        code: ErrorCode.SUPER_ADMIN_PROTECTED,
        message: 'Không thể thay đổi tài khoản quản trị tối cao',
      });
    }
  }

  /** Luật 15: không tự đổi trạng thái của chính mình. */
  assertNotSelf(callerId: string, targetId: string, touchesStatus: boolean): void {
    if (callerId !== targetId) return;
    if (!touchesStatus) return;
    throw new ErrorException({
      code: ErrorCode.SELF_OPERATION_FORBIDDEN,
      message: 'Không thể tự đổi trạng thái của chính mình',
    });
  }

  /** Luật 15: không tự xoá chính mình. */
  assertNotSelfDelete(callerId: string, targetId: string): void {
    if (callerId !== targetId) return;
    throw new ErrorException({
      code: ErrorCode.SELF_OPERATION_FORBIDDEN,
      message: 'Không thể tự xoá tài khoản của chính mình',
    });
  }

  /**
   * BS-05: bản ghi đích phải nằm trong phạm vi chi nhánh của người gọi, ngoài phạm vi thì báo 1200 như không
   * tồn tại. Phạm vi ALL bỏ qua hẳn để ADMIN/SUPER_ADMIN không tốn thêm truy vấn.
   */
  private async assertTargetInScope(id: string, scope: BranchScope): Promise<void> {
    if (scope.kind === 'ALL') return;

    const target = await this.userRepository.findByIdWithRole(id);
    if (!target || !isInBranchScope(scope, target.branchId)) {
      throw new ErrorException({ code: ErrorCode.USER_NOT_FOUND, message: 'Người dùng không tồn tại' });
    }
  }
}
