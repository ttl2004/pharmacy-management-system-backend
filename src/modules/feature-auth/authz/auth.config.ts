import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { durationSeconds } from 'src/common/configs/env.validation';

@Injectable()
export class AuthConfig {
  readonly secret: string;
  readonly accessTtl: number;
  readonly refreshTtl: number;
  readonly refreshInBody: boolean;
  readonly cookieName = 'refreshToken';
  readonly cookieOptions: { httpOnly: true; secure: boolean; sameSite: 'strict' | 'lax' | 'none'; path: string };

  constructor(config: ConfigService) {
    this.secret = config.getOrThrow<string>('JWT_ACCESS_SECRET');
    this.accessTtl = durationSeconds(config.getOrThrow<string>('JWT_ACCESS_TTL'));
    this.refreshTtl = durationSeconds(config.getOrThrow<string>('REFRESH_TTL'));

    this.refreshInBody = config.get<string>('AUTH_REFRESH_IN_BODY') === 'true';
    this.cookieOptions = {
      httpOnly: true,
      secure: config.get<string>('COOKIE_SECURE') === 'true',
      sameSite: config.getOrThrow('COOKIE_SAMESITE'),
      path: config.getOrThrow<string>('COOKIE_PATH'),
    };
    if (config.get('NODE_ENV') === 'production' && this.refreshInBody) {
      new Logger(AuthConfig.name).error(
        'CẢNH BÁO BẢO MẬT: đang trả refresh token trong body phản hồi trên môi trường production',
      );
    }
  }
}
