import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { PassportStrategy } from '@nestjs/passport';
import { Model } from 'mongoose';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { ErrorException } from '@/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';
import { UserDocument } from '../../user/schemas/user.schema';
import { AuthJwtPayload, JwtUser } from '../types/authz.types';

@Injectable()
export class AuthzStrategy extends PassportStrategy(Strategy, AUTH_JWT) {
  constructor(
    private readonly configService: ConfigService,

    @InjectModel(UserDocument.name)
    private readonly userModel: Model<UserDocument>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get('jwt.secret') || '',
    });
  }

  async validate(payload: AuthJwtPayload): Promise<JwtUser> {
    const user = await this.userModel.findOne({ _id: payload.sub, isDeleted: false }).lean();

    if (!user) {
      throw new ErrorException({
        code: ErrorCode.USER_NOT_FOUND,
        message: 'Người dùng không tồn tại',
      });
    }

    return {
      userId: payload.sub,
      email: payload.email,
      role: payload.role,
      permissionId: payload.permissionId,
    };
  }
}
