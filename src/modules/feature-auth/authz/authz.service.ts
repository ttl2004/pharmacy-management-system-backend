import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoginFailureMonitor } from './login-failure.monitor';
import { BruteForceDetector } from './brute-force.detector';
import { TokenService } from './token.service';
import { SessionStore } from './session.store';
import type { RequestContext } from 'src/common/decorators/request-context';
import { SecurityEventService } from 'src/providers/security-event/security-event.service';
import { isStaffRole } from '../permission/staff-role';
import { authError } from './auth.error';
import * as bcrypt from 'bcrypt';
import { SYSTEM_ACTOR_ID } from 'src/common/constants/app.constant';
import { AuthRole } from 'src/common/types/common.enum';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';
import { normalizeVietnamPhone } from 'src/common/utils/phone.util';
import { AbstractBaseService } from 'src/providers/abstract-base/abstract-base.service';
import { UserRepository } from '../user/repositories/user.repository';
import { LoginRequest } from './dtos/login.request';

import { Auth, Gender, UserStatus } from '@prisma/client';
import { JwtUser } from './types/authz.types';
import { AuthzRepository } from './repositories/authz.repository';
import { PrismaService } from 'src/common/databases/prisma.service';

function isLoginInvalid(error: unknown): boolean {
  if (!(error instanceof UnauthorizedException)) return false;
  const body = error.getResponse() as { code?: number };
  return body?.code === ErrorCode.LOGIN_INVALID;
}

@Injectable()
export class AuthzService extends AbstractBaseService<Auth> {
  private readonly authzLogger = new Logger(AuthzService.name);

  constructor(
    private readonly authzRepository: AuthzRepository,
    private readonly userRepository: UserRepository,
    private readonly tokens: TokenService,
    private readonly configService: ConfigService,
    // Đọc thẳng qua Prisma thay vì dùng RoleRepository: PermissionModule import AuthzModule,
    // nên AuthzModule không được phép import ngược lại.
    private readonly prisma: PrismaService,
    private readonly sessions: SessionStore,
    private readonly security: SecurityEventService,
    private readonly loginFailures: LoginFailureMonitor,
    private readonly bruteForce: BruteForceDetector,
  ) {
    super(authzRepository);
  }

  /**
   * Dòng `users` cho `SYSTEM_ACTOR_ID` — tác nhân ghi vào `createdBy`/`updatedBy` khi job/seed thao tác. Phải có
   * thật để các cột người thao tác gắn được FK sang `users`. Không có `auths` và ở trạng thái INACTIVE nên không
   * đăng nhập được; mang vai trò SUPER_ADMIN để luật 14 + rào cấp bậc chặn mọi API sửa/xoá nó.
   */
  async seedSystemActor() {
    const existing = await this.prisma.user.findUnique({ where: { id: SYSTEM_ACTOR_ID }, select: { id: true } });
    if (existing) {
      this.authzLogger.log('Tác nhân hệ thống đã tồn tại');
      return;
    }

    const superAdminRole = await this.requireSuperAdminRole();
    await this.prisma.user.create({
      data: {
        id: SYSTEM_ACTOR_ID,
        fullName: 'Hệ thống',
        roleId: superAdminRole.id,
        status: UserStatus.INACTIVE,
        createdBy: SYSTEM_ACTOR_ID,
      },
    });
    this.authzLogger.log('Đã tạo tác nhân hệ thống');
  }

  async seedSuperAdmin() {
    const email = this.configService.get<string>('superAdmin.email');
    const username = this.configService.get<string>('superAdmin.username');
    const password = this.configService.get<string>('superAdmin.password');

    if (!email || !username || !password) {
      this.authzLogger.warn(
        'Bỏ qua khởi tạo quản trị viên cấp cao vì thiếu SUPER_ADMIN_EMAIL, SUPER_ADMIN_USERNAME hoặc SUPER_ADMIN_PASSWORD',
      );
      return;
    }

    const fullName = this.configService.get<string>('superAdmin.fullName');
    const configuredPhone = this.configService.get<string>('superAdmin.phoneNumber');
    const phoneNumber = configuredPhone && normalizeVietnamPhone(configuredPhone);
    const address = this.configService.get<string>('superAdmin.address');
    const dateOfBirth = this.configService.get<string>('superAdmin.dateOfBirth');
    const gender = this.configService.get<Gender>('superAdmin.gender');

    this.authzLogger.log('Đang khởi tạo quản trị viên cấp cao...');
    const existingSuperAdmin = await this.userRepository.findByEmailIgnoringSoftDelete(email);

    const superAdminRole = await this.requireSuperAdminRole();

    if (!existingSuperAdmin) {
      this.authzLogger.log('Chưa có quản trị viên cấp cao, đang tạo...');

      const superAdmin = await this.userRepository.create({
        email,
        fullName,
        // `phoneNumber` là UNIQUE: chuỗi rỗng sẽ khiến bản ghi thứ hai vi phạm ràng buộc.
        // Gửi `undefined` để base repository bỏ hẳn khoá, cột giữ NULL (Postgres cho nhiều NULL).
        phoneNumber: phoneNumber || undefined,
        address: address || undefined,
        // `@db.Date`: dựng mốc theo UTC, nếu không sẽ lùi một ngày ở múi giờ UTC+7.
        dateOfBirth: dateOfBirth ? new Date(`${dateOfBirth}T00:00:00.000Z`) : undefined,
        gender: gender ?? undefined,
        roleId: superAdminRole.id,
        status: UserStatus.ACTIVE,
      });

      await this.authzRepository.create({
        username,
        password: await bcrypt.hash(password, 10),
        userId: superAdmin.id,
      });

      this.authzLogger.log('Đã tạo quản trị viên cấp cao thành công');
    } else {
      this.authzLogger.log('Quản trị viên cấp cao đã tồn tại');
    }
  }

  async login(dto: LoginRequest, ctx: RequestContext) {
    const authz = await this.getAuthzByUsername(dto.username);
    // Trả cùng thông báo và đều so sánh bcrypt khi tên đăng nhập không tồn tại hoặc mật khẩu sai.
    const dummyHash = '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
    const valid = await bcrypt.compare(dto.password, authz?.password ?? dummyHash);
    const user = authz?.user;
    if (!authz || !user || !valid || user.isDeleted || user.status !== UserStatus.ACTIVE) {
      this.recordLoginFailureDetached(user, ctx);
      throw authError(ErrorCode.LOGIN_INVALID);
    }
    try {
      return await this.tokens.login(authz, ctx);
    } catch (error) {
      // Mật khẩu/trạng thái đổi trong lúc bcrypt chạy: tính như đăng nhập thất bại.
      if (isLoginInvalid(error)) this.recordLoginFailureDetached(user, ctx);
      throw error;
    }
  }

  /**
   * Nhân viên: ghi `LOGIN_FAILED` rồi kiểm tra dò mật khẩu (D4, không khoá). Khách hàng: không ghi gì (D2).
   * Username không tồn tại: không ghi từng lần, chỉ đếm theo IP và báo một dòng `LOGIN_FAILED_BURST` (D3).
   * Mọi trường hợp client đều nhận cùng `LOGIN_INVALID`.
   */
  /**
   * Không await: nhánh nhân viên không được tốn thêm thời gian so với username lạ/khách hàng (lộ username qua thời
   * gian phản hồi), và lỗi ghi audit không được đổi `LOGIN_INVALID` thành 500.
   */
  private recordLoginFailureDetached(
    user: { id: string; role: { code: string } } | null | undefined,
    ctx: RequestContext,
  ): void {
    void this.recordLoginFailure(user, ctx).catch((error: unknown) =>
      this.authzLogger.error(
        'Không ghi được sự kiện đăng nhập thất bại',
        error instanceof Error ? error.stack : String(error),
      ),
    );
  }

  private async recordLoginFailure(
    user: { id: string; role: { code: string } } | null | undefined,
    ctx: RequestContext,
  ) {
    if (!user) {
      const result = this.loginFailures.recordUnknownUsername(ctx.ip);
      if (result.burst) {
        await this.security.record([
          {
            type: 'AUTH.LOGIN_FAILED_BURST',
            actorId: null,
            context: ctx,
            metadata: { count: result.count, windowStart: result.windowStart.toISOString() },
          },
        ]);
      }
      return;
    }
    if (!isStaffRole(user.role.code)) return;
    await this.security.record([
      { type: 'AUTH.LOGIN_FAILED', actorId: user.id, actorRoleCode: user.role.code, context: ctx },
    ]);
    await this.bruteForce.check(user.id, user.role.code, ctx);
  }

  async refreshToken(token: string | undefined, ctx: RequestContext) {
    return this.tokens.refresh(token, ctx);
  }

  /** Thu hồi mọi phiên của người dùng; nhân viên thì ghi `AUTH.LOGOUT_ALL`. */
  async logoutAll(user: JwtUser, ctx: RequestContext) {
    await this.sessions.revokeAllByUser(user.userId);
    if (isStaffRole(user.role)) {
      await this.security.record([
        { type: 'AUTH.LOGOUT_ALL', actorId: user.userId, actorRoleCode: user.role, sessionId: user.sid, context: ctx },
      ]);
    }
  }
  async logout(sid: string, token: string | undefined) {
    await this.tokens.logout(sid, token);
  }
  async getAuthzByUsername(username: string) {
    return this.authzRepository.findByUsernameWithUser(username);
  }

  async getProfileUser(authz: JwtUser) {
    if (!authz.userId) {
      throw new ErrorException({
        code: ErrorCode.USER_NOT_FOUND,
        message: 'Người dùng không tồn tại',
      });
    }

    const user = await this.userRepository.findOne({ id: authz.userId });

    if (!user) {
      throw new ErrorException({
        code: ErrorCode.USER_NOT_FOUND,
        message: 'Người dùng không tồn tại',
      });
    }

    return user;
  }

  private async requireSuperAdminRole() {
    const role = await this.prisma.role.findFirst({
      where: { code: AuthRole.SUPER_ADMIN, isDeleted: false },
    });
    if (!role) {
      throw new ErrorException({
        code: ErrorCode.ROLE_NOT_FOUND,
        message: 'Chưa có vai trò SUPER_ADMIN trong DB. Chạy "npm run seed:permissions" trước.',
      });
    }
    return role;
  }
}
