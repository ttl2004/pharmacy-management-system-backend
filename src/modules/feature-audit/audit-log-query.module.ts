import { Module } from '@nestjs/common';
import { AuthzModule } from '../feature-auth/authz/authz.module';
import { PermissionModule } from '../feature-auth/permission/permission.module';
import { AuditLogQueryController } from './audit-log-query.controller';
import { AuditLogQueryService } from './audit-log-query.service';

@Module({
  imports: [PermissionModule, AuthzModule],
  controllers: [AuditLogQueryController],
  providers: [AuditLogQueryService],
})
export class AuditLogQueryModule {}
