import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { CurrentActor, type RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthzGuard } from '../feature-auth/authz/guards/auth.guard';
import { RequirePermissions } from '../feature-auth/permission/decorators/require-permissions.decorator';
import { PermissionGuard } from '../feature-auth/permission/guards/permission.guard';
import { SecurityEventQuery } from './dtos/security-event.query';
import { SecurityEventQueryService } from './security-event-query.service';

@Controller('security-events')
@ApiTags('SecurityEvents')
@ApiBearerAuth(AUTH_JWT)
@UseGuards(AuthzGuard, PermissionGuard)
export class SecurityEventQueryController {
  constructor(private readonly service: SecurityEventQueryService) {}

  @RequirePermissions('security-event:read')
  @Get()
  @ApiOperation({
    description:
      'Sự kiện bảo mật của nhân viên (đăng nhập, phiên, mật khẩu), mới nhất trước, phân trang cursor. ADMIN không thấy dòng của SUPER_ADMIN.',
  })
  list(@Query() query: SecurityEventQuery, @CurrentActor() actor: RequestActor) {
    return this.service.list(query, actor);
  }
}
