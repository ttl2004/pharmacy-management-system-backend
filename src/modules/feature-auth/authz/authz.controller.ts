import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { AuthzService } from './authz.service';
import { LoginRequest } from './dtos/login.request';
import { RefreshTokenRequest } from './dtos/refresh.request';
import { AuthzGuard } from './guards/auth.guard';
import type { JwtUser } from './types/authz.types';
import { CurrentUser } from '@/common/decorators/current-user.decorator';

@Controller('authz')
@ApiTags('Authz')
export class AuthzController {
  constructor(private readonly authzService: AuthzService) {}

  @Post('login')
  login(@Body() dto: LoginRequest) {
    return this.authzService.login(dto);
  }

  @Post('refresh')
  refresh(@Body() dto: RefreshTokenRequest) {
    return this.authzService.refreshToken(dto);
  }

  @ApiBearerAuth(AUTH_JWT)
  @UseGuards(AuthzGuard)
  @Get('me')
  me(@CurrentUser() authz: JwtUser) {
    return this.authzService.getProfileUser(authz);
  }
}
