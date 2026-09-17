import { RabbitSubscribe } from '@golevelup/nestjs-rabbitmq';
import { Injectable, Logger } from '@nestjs/common';
import { SmtpSender } from '../smtp.sender';
import { MAIL_RABBITMQ_EXCHANGE, MAIL_RABBITMQ_QUEUE, MAILER_ROUTING_KEY } from '../types/mailer.constants';
import type { MailJobPayload } from '../types/mailer.types';

@Injectable()
export class MailQueueConsumer {
  private readonly logger = new Logger(MailQueueConsumer.name);

  constructor(private readonly smtpSender: SmtpSender) {}

  @RabbitSubscribe({
    exchange: MAIL_RABBITMQ_EXCHANGE,
    routingKey: MAILER_ROUTING_KEY,
    queue: MAIL_RABBITMQ_QUEUE,
  })
  async handleSendMail(payload: MailJobPayload) {
    try {
      await this.smtpSender.send(payload);
    } catch (error) {
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error('Async mail delivery failed', stack);
    }
  }
}
