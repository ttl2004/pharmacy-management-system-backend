import { Module } from '@nestjs/common';
import { AuthzModule } from '../feature-auth/authz/authz.module';
import { PermissionModule } from '../feature-auth/permission/permission.module';
import { BranchController } from './branch.controller';
import { BranchService } from './branch.service';
import { BranchRepository } from './repositories/branch.repository';

@Module({
  imports: [PermissionModule, AuthzModule],
  controllers: [BranchController],
  providers: [BranchService, BranchRepository],
  exports: [BranchService],
})
export class BranchModule {}
