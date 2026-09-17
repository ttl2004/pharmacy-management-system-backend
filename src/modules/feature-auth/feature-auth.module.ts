import { Module } from '@nestjs/common';
import { AuthzModule } from './authz/authz.module';
import { UserModule } from './user/user.module';
import { PermissionModule } from './permission/permission.module';

@Module({
  imports: [AuthzModule, UserModule, PermissionModule],
})
export class FeatureAuthzModule {}
