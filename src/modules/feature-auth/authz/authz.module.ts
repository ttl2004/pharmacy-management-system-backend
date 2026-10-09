import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ThrottlerModule } from '@nestjs/throttler';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { UserModule } from '../user/user.module';
import { AuthzController } from './authz.controller';
import { AuthzService } from './authz.service';
import { AuthzGuard } from './guards/auth.guard';
import { AuthzRepository } from './repositories/authz.repository';
import { AuthzStrategy } from './strategies/auth.strategy';
import { AuthConfig } from './auth.config';
import { SessionStore, DbSessionStore, SessionTransactions } from './session.store';
import { TokenService } from './token.service';
import { PasswordService } from './password.service';

@Module({ imports: [ConfigModule], providers: [AuthConfig], exports: [AuthConfig] })
class AuthConfigModule {}

@Module({
  imports: [
    AuthConfigModule,
    PassportModule.register({ defaultStrategy: AUTH_JWT }),
    // forwardRef vì UserModule cần AuthzGuard của module này — xem user.module.ts.
    forwardRef(() => UserModule),
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 10 }]),
    JwtModule.registerAsync({
      imports: [AuthConfigModule],
      inject: [AuthConfig],
      useFactory: (config: AuthConfig) => ({
        secret: config.secret,
        signOptions: { expiresIn: config.accessTtl, algorithm: 'HS256' },
      }),
    }),
  ],
  controllers: [AuthzController],
  providers: [
    AuthzService,
    AuthzRepository,
    AuthzStrategy,
    AuthzGuard,
    SessionTransactions,
    TokenService,
    PasswordService,
    { provide: SessionStore, useClass: DbSessionStore },
  ],
  exports: [AuthzService, AuthzGuard, SessionStore, PasswordService, SessionTransactions],
})
export class AuthzModule {}
