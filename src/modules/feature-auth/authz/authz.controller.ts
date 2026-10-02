import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type {} from '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { ErrorCode } from 'src/common/types/error-code';
import { AuthzService } from './authz.service';
import { LoginRequest } from './dtos/login.request';
import { RefreshTokenRequest } from './dtos/refresh.request';
import { AccessTokenEnvelopeResponse, TokenEnvelopeResponse } from './dtos/token.response';
import { AuthzGuard } from './guards/auth.guard';
import type { JwtUser } from './types/authz.types';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { AuthConfig } from './auth.config';
import { SessionStore } from './session.store';
import type { TokenPair } from './token.service';
import { PasswordService } from './password.service';
import { ChangePasswordRequest } from './dtos/password.request';

@Controller('auth')
@ApiTags('Auth')
@ApiResponse({
  status: 401,
  description:
    'Xác thực thất bại. Các mã lỗi: LOGIN_INVALID (1100), INVALID_TOKEN (1300), TOKEN_EXPIRED (1301), SESSION_REVOKED (1303)',
  schema: {
    example: {
      statusCode: 401,
      code: ErrorCode.SESSION_REVOKED,
      errorCode: ErrorCode.SESSION_REVOKED,
      message: 'Phiên đăng nhập đã bị thu hồi',
    },
  },
})
export class AuthzController {
  constructor(
    private readonly auth: AuthzService,
    private readonly config: AuthConfig,
    private readonly sessions: SessionStore,
    private readonly passwords: PasswordService,
  ) {}

  private receiveToken(req: FastifyRequest, dto: RefreshTokenRequest) {
    return req.cookies[this.config.cookieName] ?? (this.config.refreshInBody ? dto?.refreshToken : undefined);
  }
  private respond(reply: FastifyReply, pair: TokenPair) {
    reply.setCookie(this.config.cookieName, pair.refreshToken, {
      ...this.config.cookieOptions,
      maxAge: this.config.refreshTtl,
    });
    reply.header('Cache-Control', 'no-store');
    return this.config.refreshInBody ? pair : { accessToken: pair.accessToken };
  }

  @Post('login')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiResponse({ status: 200, type: TokenEnvelopeResponse })
  @ApiResponse({ status: 429, description: 'Đã vượt quá số lần đăng nhập cho phép' })
  @ApiOperation({
    description:
      'Swagger UI không cho phép đặt cookie thủ công. Bật AUTH_REFRESH_IN_BODY=true để kiểm thử bằng token trong body.',
  })
  async login(@Body() dto: LoginRequest, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.respond(reply, await this.auth.login(dto, { userAgent: req.headers['user-agent'], ip: req.ip }));
  }

  @Post('refresh')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @ApiResponse({ status: 200, type: AccessTokenEnvelopeResponse })
  @ApiOperation({
    description:
      'Dùng RT hiện tại để cấp AT mới. Không trả RT, không đặt lại cookie và không gia hạn phiên. RT hết hạn thì phải đăng nhập lại.',
  })
  @ApiResponse({ status: 429, description: 'Đã vượt quá số lần làm mới token cho phép' })
  async refresh(
    @Body() dto: RefreshTokenRequest,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header('Cache-Control', 'no-store');
    return this.auth.refreshToken(this.receiveToken(req, dto));
  }

  @Post('logout')
  @HttpCode(200)
  @ApiBearerAuth(AUTH_JWT)
  @UseGuards(AuthzGuard)
  @ApiOperation({
    description:
      'Thu hồi phiên được xác định bởi access token. Refresh token trong cookie/body không được dùng để chọn phiên khác.',
  })
  async logout(
    @CurrentUser() user: JwtUser,
    @Body() dto: RefreshTokenRequest,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.auth.logout(user.sid, this.receiveToken(req, dto));
    reply.clearCookie(this.config.cookieName, this.config.cookieOptions);
    return { success: true };
  }

  @Post('logout-all')
  @HttpCode(200)
  @ApiBearerAuth(AUTH_JWT)
  @UseGuards(AuthzGuard)
  async logoutAll(@CurrentUser() user: JwtUser, @Res({ passthrough: true }) reply: FastifyReply) {
    await this.sessions.revokeAllByUser(user.userId);
    reply.clearCookie(this.config.cookieName, this.config.cookieOptions);
    return { success: true };
  }

  @ApiBearerAuth(AUTH_JWT)
  @UseGuards(AuthzGuard)
  @Get('me')
  me(@CurrentUser() user: JwtUser) {
    return this.auth.getProfileUser(user);
  }

  @Post('change-password')
  @HttpCode(200)
  @ApiBearerAuth(AUTH_JWT)
  @UseGuards(AuthzGuard)
  @ApiOperation({
    description:
      'Xác minh mật khẩu hiện tại, cập nhật hash bcrypt và thu hồi toàn bộ phiên trong cùng transaction. Đăng nhập lại sau khi thành công.',
  })
  async changePassword(
    @CurrentUser() user: JwtUser,
    @Body() dto: ChangePasswordRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.passwords.change(user, dto);
    reply.clearCookie(this.config.cookieName, this.config.cookieOptions);
    return { success: true };
  }
}
