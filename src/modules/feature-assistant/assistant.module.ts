import { Module } from '@nestjs/common';
import { AuthzModule } from '../feature-auth/authz/authz.module';
import { AssistantController } from './assistant.controller';
import { RagServiceClient } from './rag-service.client';

// ThrottlerModule là module @Global, đã forRoot trong AuthzModule — UserThrottlerGuard dùng lại cấu hình đó.
@Module({
  imports: [AuthzModule],
  controllers: [AssistantController],
  providers: [RagServiceClient],
})
export class AssistantModule {}
