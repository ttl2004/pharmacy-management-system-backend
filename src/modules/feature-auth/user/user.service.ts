import { Injectable } from '@nestjs/common';
import { Branch, Prisma, Role, User, UserStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { APP_CONSTANTS } from 'src/common/constants/app.constant';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { rethrowDuplicate } from 'src/common/exceptions/prisma-error';
import { AuthRole } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';
import { normalizePhoneSearch } from 'src/common/utils/phone.util';
import { PrismaService } from 'src/common/databases/prisma.service';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { auditActorOf } from 'src/providers/audit-log/audit-actor';
import { diffFields, pickAuditFields } from 'src/providers/audit-log/audit-diff';
import { SecurityEventService } from 'src/providers/security-event/security-event.service';
import { isStaffRole } from '../permission/staff-role';
import { AuditLogService } from 'src/providers/audit-log/audit-log.service';
import type { AuditEntry, AuditJson } from 'src/providers/audit-log/audit-log.types';
import { AbstractBaseService } from 'src/providers/abstract-base/abstract-base.service';
import { BaseWhere } from 'src/providers/abstract-base/repositories/abstract-base.repository';
import { SessionTransactions } from '../authz/session.store';
import type { JwtUser } from '../authz/types/authz.types';
import {
  assertBranchInScope,
  type BranchScope,
  isBranchBoundRole,
  isInBranchScope,
  resolveBranchScope,
  scopedBranchFilter,
} from '../permission/branch-scope';
import { assertOutranks } from '../permission/role-hierarchy';
import { assertRoleWithinCallerGrants } from '../permission/role-grant-guard';
import { CreateUserRequest, UpdateUserRequest } from './dtos/user.request';
import { UserQuery } from './dtos/user.query';
import { UserRepository } from './repositories/user.repository';
import {
  maskUserSnapshot,
  USER_AUDIT_FIELDS,
  userAuditBase,
  userSnapshot,
  usernameOf,
  type UserAuditSnapshot,
} from './user-audit';

export type UserDetail = User & { role: Role; branch: Branch | null; auth: { username: string } | null };

/** Quan hệ kèm theo mọi bản ghi người dùng trả ra: vai trò, chi nhánh và tên đăng nhập (không lấy mật khẩu). */
const USER_RELATIONS = { role: true, branch: true, auth: { select: { username: true } } };

const SUPER_ADMIN_ROLE = 'SUPER_ADMIN';

/** Snapshot → dạng JSON ghi được (Date/bigint đã chuẩn hoá); dùng cho CREATE/DELETE. */
function plainSnapshot(snapshot: UserAuditSnapshot): Record<string, AuditJson> {
  return pickAuditFields(snapshot, USER_AUDIT_FIELDS);
}

/** Phần trường trong danh sách trắng mà lần sửa này thực sự gửi lên. */
function userSnapshotChanges(data: Partial<User>): Partial<UserAuditSnapshot> {
  const changes: Partial<UserAuditSnapshot> = {};
  for (const field of ['fullName', 'status', 'branchId', 'email', 'phoneNumber'] as const) {
    if (field in data) changes[field] = data[field];
  }
  return changes;
}

/** Tên các trường đổi thật sự nhưng không ghi giá trị vào nhật ký: địa chỉ, ngày sinh, giới tính, email. */
function hiddenChangedFields(current: User, data: Partial<User>): string[] {
  const names: string[] = [];
  if ('email' in data && (data.email ?? null) !== (current.email ?? null)) names.push('email');
  if ('address' in data && (data.address ?? null) !== (current.address ?? null)) names.push('address');
  if ('gender' in data && (data.gender ?? null) !== (current.gender ?? null)) names.push('gender');
  if ('dateOfBirth' in data && (data.dateOfBirth?.getTime() ?? null) !== (current.dateOfBirth?.getTime() ?? null)) {
    names.push('dateOfBirth');
  }
  return names;
}

@Injectable()
export class UserService extends AbstractBaseService<User> {
  constructor(
    private readonly userRepository: UserRepository,
    private readonly prisma: PrismaService,
    private readonly transactions: SessionTransactions,
    private readonly audit: AuditLogService,
    private readonly security: SecurityEventService,
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
    if (query.excludeCustomer) {
      const customerId = await this.userRepository.findRoleIdByCode(AuthRole.CUSTOMER);
      // Đã lọc theo một vai trò thì giữ nguyên; riêng chọn CUSTOMER mà vẫn loại CUSTOMER thì ra rỗng.
      if (customerId) {
        filter.roleId = filter.roleId === customerId ? { in: [] } : (filter.roleId ?? { not: customerId });
      }
    }
    if (branchId) filter.branchId = branchId;
    if (query.status) filter.status = query.status;

    return this.userRepository.findManyWithPagination(filter, {
      page: query.page,
      limit: query.limit,
      sort: query.sort,
      search: query.search && normalizePhoneSearch(query.search),
      searchFields: ['phoneNumber', 'fullName', 'email'],
      relations: USER_RELATIONS,
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

  async create(dto: CreateUserRequest, actor: RequestActor): Promise<UserDetail> {
    const caller = actor.user;
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
    // Và vai trò đó không được mang quyền người gọi không có (1509).
    await assertRoleWithinCallerGrants(this.prisma, role.id, caller);
    await this.assertBranchRule(role.code, branchId);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          include: { role: true, branch: true },
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

        const username = hasUsername ? (dto.username ?? null) : null;
        await this.audit.record(tx, auditActorOf(actor), [
          {
            event: 'USER.CREATED',
            ...userAuditBase(user, username, [user.branchId]),
            after: maskUserSnapshot(plainSnapshot(userSnapshot(user))),
            ...(username ? { metadata: { hasCredentials: true } } : {}),
          },
        ]);

        return { ...user, auth: dto.username ? { username: dto.username } : null };
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
   * Luật 10: vai trò gắn chi nhánh (`isBranchBoundRole`) bắt buộc có chi nhánh, vai trò còn lại bắt buộc để
   * trống. `undefined` (không gửi trường) được coi là null khi tạo mới.
   */
  async assertBranchRule(roleCode: string, branchId: string | null | undefined): Promise<void> {
    const needsBranch = isBranchBoundRole(roleCode);
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
  async update(id: string, dto: UpdateUserRequest, actor: RequestActor): Promise<UserDetail> {
    const caller = actor.user;
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

    // Khoá/ngừng tài khoản thì phiên đang sống phải chết ngay, không đợi access token hết hạn (báo cáo bảo mật #7).
    // Thu hồi idempotent nên không cần so với trạng thái cũ (đọc cũ có thể lệch).
    const revokeSessions = dto.status !== undefined && dto.status !== UserStatus.ACTIVE;

    try {
      // `forUser` giữ khoá phiên của người này, chạy nối tiếp với đăng nhập, và bỏ cache phiên (`changed()`) sau commit.
      return await this.transactions.forUser(id, async (tx) => {
        // Đọc lại trong tx đã giữ khoá phiên: `current` ở trên đọc trước tx nên có thể đã cũ nếu có ai vừa đổi trạng thái.
        // Diff và STATUS_CHANGED lấy từ lần đọc này.
        const fresh = await this.userRepository.findByIdWithRole(id, tx);
        if (!fresh) {
          throw new ErrorException({ code: ErrorCode.USER_NOT_FOUND, message: 'Người dùng không tồn tại' });
        }
        const updated = await this.userRepository.update({ id }, data, { relations: USER_RELATIONS }, tx);
        if (!updated) {
          throw new ErrorException({ code: ErrorCode.USER_NOT_FOUND, message: 'Người dùng không tồn tại' });
        }
        const changes = userSnapshotChanges(data);
        const diff = diffFields(userSnapshot(fresh), changes, USER_AUDIT_FIELDS);
        // Trường không nằm trong danh sách trắng (địa chỉ, ngày sinh, giới tính) và email: chỉ ghi TÊN trường đã đổi.
        const changedFields = hiddenChangedFields(fresh, data);
        const statusChanged = !!diff && 'status' in diff.after;
        if (diff || changedFields.length) {
          const username = await usernameOf(tx, id);
          const base = userAuditBase(fresh, username, [fresh.branchId, updated.branchId]);
          const entries: AuditEntry[] = [];
          if (diff && 'status' in diff.after) {
            entries.push({
              event: 'USER.STATUS_CHANGED',
              ...base,
              before: { status: diff.before.status },
              after: { status: diff.after.status },
              reason: dto.reason?.trim() || null,
            });
            delete diff.before.status;
            delete diff.after.status;
          }
          if ((diff && Object.keys(diff.after).length) || changedFields.length) {
            entries.push({
              event: 'USER.UPDATED',
              ...base,
              ...(diff && Object.keys(diff.after).length
                ? { before: maskUserSnapshot(diff.before), after: maskUserSnapshot(diff.after) }
                : {}),
              ...(changedFields.length ? { metadata: { changedFields } } : {}),
            });
          }
          await this.audit.record(tx, auditActorOf(actor), entries);
        }
        if (revokeSessions) {
          await this.revokeRefreshTokens(tx, id);
          // Token luôn thu hồi (idempotent); sự kiện bảo mật chỉ ghi khi trạng thái thực sự đổi.
          if (statusChanged) {
            await this.recordSessionsRevoked(tx, fresh.id, fresh.role.code, actor, {
              trigger: 'STATUS_CHANGE',
              status: String(dto.status),
            });
          }
        }
        return updated as UserDetail;
      });
    } catch (error) {
      rethrowDuplicate(error);
    }
  }

  /** Luật 13: xoá mềm + thu hồi mọi refresh token còn hiệu lực. */
  /** `reason` tuỳ chọn (DELETE không có body nên đi qua `?reason=`). */
  async remove(id: string, actor: RequestActor, reason?: string): Promise<{ success: true }> {
    const caller = actor.user;
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

    // Xoá mềm và thu hồi phiên cùng một transaction: không có khe hở user đã xoá mà phiên còn sống.
    await this.transactions.forUser(id, async (tx) => {
      const deleted = await this.userRepository.softDelete({ id }, tx);
      if (!deleted) {
        throw new ErrorException({ code: ErrorCode.USER_NOT_FOUND, message: 'Người dùng không tồn tại' });
      }
      await this.revokeRefreshTokens(tx, id);
      await this.recordSessionsRevoked(tx, id, target.role.code, actor, { trigger: 'DELETE' });
      await this.audit.record(tx, auditActorOf(actor), [
        {
          event: 'USER.DELETED',
          ...userAuditBase(target, await usernameOf(tx, id), [target.branchId]),
          before: maskUserSnapshot(plainSnapshot(userSnapshot(target))),
          reason: reason?.trim() || null,
        },
      ]);
    });

    return { success: true };
  }

  /** Thu hồi mọi refresh token còn hiệu lực của user — phiên (`sid`) của họ chết ở lần kiểm kế tiếp. */
  /**
   * D11: ghi `AUTH.SESSIONS_REVOKED_BY_ADMIN` cùng transaction với việc thu hồi. `actorId` là người bị thu hồi phiên
   * (để tra "lịch sử bảo mật của X"); người thực hiện nằm trong `metadata.revokedBy`. Chỉ ghi cho nhân viên.
   */
  private async recordSessionsRevoked(
    tx: Prisma.TransactionClient,
    targetId: string,
    targetRoleCode: string,
    actor: RequestActor,
    detail: Record<string, string>,
  ): Promise<void> {
    if (!isStaffRole(targetRoleCode)) return;
    await this.security.record(
      [
        {
          type: 'AUTH.SESSIONS_REVOKED_BY_ADMIN',
          actorId: targetId,
          actorRoleCode: targetRoleCode,
          context: actor,
          // SUPER_ADMIN không lộ danh tính ra ngoài ADMIN: bỏ `revokedBy` khi người thực hiện là SUPER_ADMIN.
          metadata:
            actor.user.role === AuthRole.SUPER_ADMIN ? { ...detail } : { revokedBy: actor.user.userId, ...detail },
        },
      ],
      tx,
    );
  }

  private async revokeRefreshTokens(tx: Prisma.TransactionClient, userId: string): Promise<void> {
    await tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
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
