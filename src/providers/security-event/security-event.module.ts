import { Module } from '@nestjs/common';
import { SecurityEventPurgeJob } from './security-event-purge.job';
import { SecurityEventService } from './security-event.service';

@Module({
  providers: [SecurityEventService, SecurityEventPurgeJob],
  exports: [SecurityEventService],
})
export class SecurityEventModule {}
