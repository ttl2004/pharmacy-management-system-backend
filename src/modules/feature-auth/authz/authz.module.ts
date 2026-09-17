import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { PassportModule } from '@nestjs/passport';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { UserDocument, UserSchema } from '../user/schemas/user.schema';
import { AuthzController } from './authz.controller';
import { AuthzService } from './authz.service';
import { AuthzGuard } from './guards/auth.guard';
import { AuthzRepository } from './repositories/authz.repository';
import { AuthzDocument, AuthzSchema } from './schemas/authz.schema';
import { AuthzStrategy } from './strategies/auth.strategy';

@Module({
  imports: [
    ConfigModule,
    PassportModule.register({ defaultStrategy: AUTH_JWT }),
    MongooseModule.forFeature([
      { name: AuthzDocument.name, schema: AuthzSchema },
      { name: UserDocument.name, schema: UserSchema },
    ]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        return {
          secret: config.get('jwt.secret'),
          signOptions: {
            expiresIn: config.get('jwt.signOptions.expiresIn'),
          },
        };
      },
    }),
  ],
  controllers: [AuthzController],
  providers: [AuthzService, AuthzRepository, AuthzStrategy, AuthzGuard],
  exports: [AuthzService, AuthzGuard],
})
export class AuthzModule {}
