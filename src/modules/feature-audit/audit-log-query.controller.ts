import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { CurrentActor, type RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthzGuard } from '../feature-auth/authz/guards/auth.guard';
import { RequirePermissions } from '../feature-auth/permission/decorators/require-permissions.decorator';
import { PermissionGuard } from '../feature-auth/permission/guards/permission.guard';
import { AuditLogQueryService } from './audit-log-query.service';
import { AuditEntityParams } from './dtos/audit-entity.params';
import { AuditLogQuery } from './dtos/audit-log.query';

@Controller('audit-log')
@ApiTags('AuditLog')
@ApiBearerAuth(AUTH_JWT)
@UseGuards(AuthzGuard, PermissionGuard)
export class AuditLogQueryController {
  constructor(private readonly auditLogQueryService: AuditLogQueryService) {}

  @RequirePermissions('audit-log:read')
  @Get()
  @ApiOperation({
    description:
      'Nhật ký thao tác, mới nhất trước, phân trang cursor. PM chỉ thấy dòng có chi nhánh mình trong branchIds.',
  })
  list(@Query() query: AuditLogQuery, @CurrentActor() actor: RequestActor) {
    return this.auditLogQueryService.list(query, actor);
  }

  // Khai trước `:id` để `entity/...` không bị bắt nhầm.
  @RequirePermissions('audit-log:read')
  @Get('entity/:type/:id')
  @ApiOperation({ description: 'Lịch sử thao tác của một đối tượng, mới nhất trước, phân trang cursor.' })
  listByEntity(@Param() params: AuditEntityParams, @Query() query: AuditLogQuery, @CurrentActor() actor: RequestActor) {
    return this.auditLogQueryService.listByEntity(params.type, params.id, query, actor);
  }

  @RequirePermissions('audit-log:read')
  @Get(':id')
  @ApiOperation({ description: 'Chi tiết một dòng nhật ký. Ngoài phạm vi chi nhánh → 404.' })
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: RequestActor) {
    return this.auditLogQueryService.get(id, actor);
  }
}
