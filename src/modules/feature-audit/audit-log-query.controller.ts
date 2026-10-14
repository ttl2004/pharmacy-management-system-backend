import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { CurrentActor, type RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthzGuard } from '../feature-auth/authz/guards/auth.guard';
import { RequirePermissions } from '../feature-auth/permission/decorators/require-permissions.decorator';
import { PermissionGuard } from '../feature-auth/permission/guards/permission.guard';
import { AuditLogQueryService } from './audit-log-query.service';
import { AuditLogQuery } from './dtos/audit-log.query';

@Controller('audit-log')
@ApiTags('AuditLog')
@ApiBearerAuth(AUTH_JWT)
@UseGuards(AuthzGuard, PermissionGuard)
export class AuditLogQueryController {
  constructor(private readonly auditLogQueryService: AuditLogQueryService) {}

  @RequirePermissions('audit-log:read')
  @Get()
  @ApiOperation({ description: 'Nhật ký thao tác, mới nhất trước, phân trang cursor. PM chỉ thấy chi nhánh mình.' })
  list(@Query() query: AuditLogQuery, @CurrentActor() actor: RequestActor) {
    return this.auditLogQueryService.list(query, actor);
  }
}
