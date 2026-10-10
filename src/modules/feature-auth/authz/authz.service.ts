import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TokenService, TokenMetadata } from './token.service';
import { authError } from './auth.error';
import * as bcrypt from 'bcrypt';
import { AuthRole } from 'src/common/types/common.enum';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';
import { AbstractBaseService } from 'src/providers/abstract-base/abstract-base.service';
import { UserRepository } from '../user/repositories/user.repository';
import { LoginRequest } from './dtos/login.request';

import { Auth, Gender, UserStatus } from '@prisma/client';
import { JwtUser } from './types/authz.types';
import { AuthzRepository } from './repositories/authz.repository';
import { PrismaService } from 'src/common/databases/prisma.service';

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
  ) {
    super(authzRepository);
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
    const phoneNumber = this.configService.get<string>('superAdmin.phoneNumber');
    const address = this.configService.get<string>('superAdmin.address');
    const dateOfBirth = this.configService.get<string>('superAdmin.dateOfBirth');
    const gender = this.configService.get<Gender>('superAdmin.gender');

    this.authzLogger.log('Đang khởi tạo quản trị viên cấp cao...');
    const existingSuperAdmin = await this.userRepository.findByEmailIgnoringSoftDelete(email);

    const superAdminRole = await this.prisma.role.findFirst({
      where: { code: AuthRole.SUPER_ADMIN, isDeleted: false },
    });
    if (!superAdminRole) {
      throw new ErrorException({
        code: ErrorCode.ROLE_NOT_FOUND,
        message: 'Chưa có vai trò SUPER_ADMIN trong DB. Chạy "npm run seed:permissions" trước.',
      });
    }

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

  async login(dto: LoginRequest, metadata: TokenMetadata = {}) {
    const authz = await this.getAuthzByUsername(dto.username);
    // Trả cùng thông báo và đều so sánh bcrypt khi tên đăng nhập không tồn tại hoặc mật khẩu sai.
    const dummyHash = '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
    const valid = await bcrypt.compare(dto.password, authz?.password ?? dummyHash);
    if (!authz || !valid || !authz.user || authz.user.isDeleted || authz.user.status !== UserStatus.ACTIVE) {
      throw authError(ErrorCode.LOGIN_INVALID);
    }
    return this.tokens.login(authz, metadata);
  }

  async refreshToken(token: string | undefined) {
    return this.tokens.refresh(token);
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
}
