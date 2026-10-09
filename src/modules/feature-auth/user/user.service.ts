import { Injectable } from '@nestjs/common';
import { Branch, Prisma, Role, User, UserStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { APP_CONSTANTS } from 'src/common/constants/app.constant';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';
import { PrismaService } from 'src/common/databases/prisma.service';
import { AbstractBaseService } from 'src/providers/abstract-base/abstract-base.service';
import { BaseWhere } from 'src/providers/abstract-base/repositories/abstract-base.repository';
import { SessionStore, SessionTransactions } from '../authz/session.store';
import { CreateUserRequest } from './dtos/user.request';
import { UserQuery } from './dtos/user.query';
import { UserRepository } from './repositories/user.repository';

export type UserDetail = User & { role: Role; branch: Branch | null };

/** Vai trò bắt buộc thuộc một chi nhánh; các vai trò còn lại phải để trống. */
const BRANCH_REQUIRED_ROLES = ['PHARMACY_MANAGER', 'SALES_STAFF'];
const SUPER_ADMIN_ROLE = 'SUPER_ADMIN';

@Injectable()
export class UserService extends AbstractBaseService<User> {
  constructor(
    private readonly userRepository: UserRepository,
    private readonly prisma: PrismaService,
    private readonly transactions: SessionTransactions,
    private readonly sessions: SessionStore,
  ) {
    super(userRepository);
  }

  async list(query: UserQuery) {
    const filter: BaseWhere<User> = {};

    if (query.roleCode) {
      const roleId = await this.userRepository.findRoleIdByCode(query.roleCode);
      // Vai trò không tồn tại thì trả rỗng, không ném lỗi — đây là bộ lọc, không phải tra cứu.
      filter.roleId = roleId ?? '__khong_ton_tai__';
    }
    if (query.branchId) filter.branchId = query.branchId;
    if (query.status) filter.status = query.status;

    return this.userRepository.findManyWithPagination(filter, {
      page: query.page,
      limit: query.limit,
      sort: query.sort,
      search: query.search,
      searchFields: ['phoneNumber', 'fullName', 'email'],
      relations: { role: true, branch: true },
    });
  }

  async getDetail(id: string): Promise<UserDetail> {
    const user = await this.userRepository.findByIdWithRoleAndBranch(id);
    if (!user) {
      throw new ErrorException({
        code: ErrorCode.USER_NOT_FOUND,
        message: 'Người dùng không tồn tại',
      });
    }
    return user;
  }

  /** Dịch lỗi trùng ràng buộc duy nhất của Prisma thành mã nghiệp vụ. */
  private rethrowDuplicate(error: unknown): never {
    // Bắt P2002 chứ không chỉ kiểm tra trước khi ghi — kiểm tra trước vẫn thủng khi hai request
    // chạy song song.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const target = (error.meta?.target as string[] | undefined)?.join(', ') ?? 'trường duy nhất';
      throw new ErrorException({
        code: ErrorCode.DUPLICATE_CODE,
        message: `Giá trị đã tồn tại: ${target}. Lưu ý bản ghi bị xoá mềm vẫn giữ giá trị duy nhất.`,
      });
    }
    throw error;
  }

  async create(dto: CreateUserRequest, callerId: string): Promise<User> {
    const hasUsername = Boolean(dto.username);
    const hasPassword = Boolean(dto.password);
    if (hasUsername !== hasPassword) {
      throw new ErrorException({
        code: ErrorCode.HTTP_BAD_REQUEST,
        message: 'username và password phải đi cùng nhau',
      });
    }

    const role = await this.requireAssignableRole(dto.roleCode);
    await this.assertBranchRule(role.code, dto.branchId);

    try {
      return await this.transactions.write(async (tx) => {
        const user = await tx.user.create({
          data: {
            fullName: dto.fullName,
            phoneNumber: dto.phoneNumber,
            email: dto.email ?? null,
            address: dto.address ?? null,
            dateOfBirth: dto.dateOfBirth ? new Date(`${dto.dateOfBirth}T00:00:00.000Z`) : null,
            gender: dto.gender ?? null,
            roleId: role.id,
            branchId: dto.branchId ?? null,
            status: dto.status ?? UserStatus.ACTIVE,
            createdBy: callerId,
          },
        });

        if (hasUsername && dto.username && dto.password) {
          await tx.auth.create({
            data: {
              username: dto.username,
              password: await bcrypt.hash(dto.password, APP_CONSTANTS.BCRYPT_SALT),
              userId: user.id,
              createdBy: callerId,
            },
          });
        }

        return user;
      });
    } catch (error) {
      this.rethrowDuplicate(error);
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
   * Luật 10: vai trò nhân viên bắt buộc có chi nhánh, vai trò còn lại bắt buộc để trống.
   * `undefined` (không gửi trường) được coi là null khi tạo mới.
   */
  async assertBranchRule(roleCode: string, branchId: string | null | undefined): Promise<void> {
    const needsBranch = BRANCH_REQUIRED_ROLES.includes(roleCode);
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
}
