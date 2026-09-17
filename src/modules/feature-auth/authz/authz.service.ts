import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import * as bcrypt from 'bcrypt';
import { Model } from 'mongoose';
import { AuthRole, RecordStatusEnum } from '../../../common/types/common.enum.js';
import { ErrorException } from '../../../common/exceptions/error.exception.js';
import { ErrorCode } from '../../../common/types/error-code.js';
import { AbstractBaseService } from '../../../providers/abstract-base/abstract-base.service.js';
import { UserDocument } from '../user/schemas/user.schema.js';
import { LoginRequest } from './dtos/login.request.js';
import { RefreshTokenRequest } from './dtos/refresh.request.js';
import { AuthzDocument } from './schemas/authz.schema.js';
import { AuthJwtPayload, JwtUser } from './types/authz.types.js';
import { AuthzRepository } from './repositories/authz.repository';

@Injectable()
export class AuthzService extends AbstractBaseService<AuthzDocument> {
  private readonly authzLogger = new Logger(AuthzService.name);

  constructor(
    @InjectModel(AuthzDocument.name)
    private readonly authzModel: Model<AuthzDocument>,

    @InjectModel(UserDocument.name)
    private readonly userModel: Model<UserDocument>,

    private readonly authzRepository: AuthzRepository,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {
    super(authzRepository);
  }

  async seedSuperAdmin() {
    const email = this.configService.get<string>('superAdmin.email');
    const username = this.configService.get<string>('superAdmin.username');
    const password = this.configService.get<string>('superAdmin.password');

    if (!email || !username || !password) {
      this.authzLogger.warn(
        'Skip seeding super admin because SUPER_ADMIN_EMAIL, SUPER_ADMIN_USERNAME or SUPER_ADMIN_PASSWORD is missing',
      );
      return;
    }

    const fullName = this.configService.get<string>('superAdmin.fullName');
    const phoneNumber = this.configService.get<string>('superAdmin.phoneNumber');
    const address = this.configService.get<string>('superAdmin.address');
    const age = this.configService.get<string>('superAdmin.age');
    const gender = this.configService.get<string>('superAdmin.gender');

    this.authzLogger.log('Seeding super admin...');
    const superAdmin = await this.userModel.findOne({ email }).lean();

    if (!superAdmin) {
      this.authzLogger.log('Super admin not found, creating...');

      const superAdmin = await this.userModel.create({
        email,
        fullName,
        phoneNumber,
        address,
        age,
        gender,
        role: AuthRole.SUPER_ADMIN,
        status: RecordStatusEnum.ACTIVE,
      });

      const authz = await this.authzModel.create({
        username,
        password: await bcrypt.hash(password, 10),
        userId: superAdmin._id,
      });

      this.authzLogger.log('Super admin created successfully', { superAdmin, authz });
    } else {
      this.authzLogger.log('Super admin already exists');
    }
  }

  async login(dto: LoginRequest) {
    const { password, username } = dto;

    const authz = await this.getAuthzByUsername(username);

    if (!authz) {
      throw new ErrorException({
        code: ErrorCode.AUTHZ_NOT_FOUND,
        message: 'Tài khoản không tồn tại',
      });
    }

    const isPasswordValid = await bcrypt.compare(password, authz.password);

    if (!isPasswordValid) {
      throw new ErrorException({
        code: ErrorCode.PASSWORD_INVALID,
        message: 'Mật khẩu không chính xác',
      });
    }

    const user = await this.userModel.findOne({ _id: authz.userId, isDeleted: false }).lean();

    if (!user) {
      throw new ErrorException({
        code: ErrorCode.USER_NOT_FOUND,
        message: 'Người dùng không tồn tại',
      });
    }

    const payload: AuthJwtPayload = {
      email: user.email,
      role: user.role,
      sub: user._id.toString(),
      permissionId: user.permissionId,
    };

    const accessToken = await this.jwtService.signAsync(payload);

    return {
      accessToken,
    };
  }

  async refreshToken(dto: RefreshTokenRequest) {
    const { refreshToken } = dto;

    const decoded = this.jwtService.verify(refreshToken);

    if (!decoded) {
      throw new ErrorException({
        code: ErrorCode.INVALID_TOKEN,
        message: 'Token không hợp lệ',
      });
    }

    const payload: AuthJwtPayload = {
      email: decoded.email,
      role: decoded.role,
      sub: decoded.sub,
      permissionId: decoded.permissionId,
    };

    const accessToken = await this.jwtService.signAsync(payload);

    return {
      accessToken,
    };
  }

  async getAuthzByUsername(username: string) {
    const authz = await this.authzModel.findOne({ username, isDeleted: false }).populate('userId').lean();

    if (!authz) {
      return null;
    }

    return authz;
  }

  async getProfileUser(authz: JwtUser) {
    const user = await this.userModel.findOne({ _id: authz.userId, isDeleted: false }).lean();

    if (!user) {
      throw new ErrorException({
        code: ErrorCode.USER_NOT_FOUND,
        message: 'Người dùng không tồn tại',
      });
    }

    return user;
  }
}
