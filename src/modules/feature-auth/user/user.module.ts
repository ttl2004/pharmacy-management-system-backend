import { Module, forwardRef } from '@nestjs/common';
import { AuditLogModule } from 'src/providers/audit-log/audit-log.module';
import { UserService } from './user.service';
import { UserController } from './user.controller';
import { UserRepository } from './repositories/user.repository';
import { AuthzModule } from '../authz/authz.module';
import { PermissionModule } from '../permission/permission.module';

@Module({
  // Vòng lặp thật: AuthzModule và PermissionModule đều import UserModule để lấy UserRepository,
  // còn UserModule cần guard của hai module đó. forwardRef ở cả ba phía là cách Nest xử lý.
  imports: [forwardRef(() => AuthzModule), forwardRef(() => PermissionModule), AuditLogModule],
  controllers: [UserController],
  providers: [UserService, UserRepository],
  exports: [UserService, UserRepository],
})
export class UserModule {}
