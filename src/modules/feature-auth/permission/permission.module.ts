import { Module, forwardRef } from '@nestjs/common';
import { AuthzModule } from '../authz/authz.module';
import { UserModule } from '../user/user.module';
import { PermissionService } from './permission.service';
import { RoleAdminService } from './role-admin.service';
import { PermissionController } from './permission.controller';
import { PermissionGuard } from './guards/permission.guard';
import { RoleRepository } from './repositories/role.repository';
import { PermissionRepository } from './repositories/permission.repository';
import { RolePermissionRepository } from './repositories/role-permission.repository';

@Module({
  // AuthzModule để lấy AuthzGuard (đặt trước PermissionGuard trên route).
  imports: [forwardRef(() => AuthzModule), forwardRef(() => UserModule)],
  controllers: [PermissionController],
  providers: [PermissionService, RoleAdminService, PermissionGuard, RoleRepository, PermissionRepository, RolePermissionRepository],
  exports: [PermissionService, PermissionGuard, RoleRepository],
})
export class PermissionModule {}
