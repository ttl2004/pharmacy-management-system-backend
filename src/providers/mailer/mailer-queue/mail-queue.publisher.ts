import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MailJobPayload } from '../types/mailer.types';
import { MAIL_RABBITMQ_EXCHANGE, MAILER_ROUTING_KEY } from '../types/mailer.constants';
import { ErrorException } from '@/common/exceptions/error.exception';
import { ErrorCode } from '@/common/types/error-code';

@Injectable()
export class MailQueuePublisher {
  constructor(
    private readonly amqpConnection: AmqpConnection,
    private readonly configService: ConfigService,
  ) {}

  async publish(payload: MailJobPayload): Promise<void> {
    const exchange = this.configService.get<string>('mail.rabbitmq.exchange') ?? MAIL_RABBITMQ_EXCHANGE;

    if (!exchange) {
      throw new ErrorException({
        code: ErrorCode.MAILER_CONFIG_MISSING,
        message: 'Thiếu cấu hình RabbitMQ exchange cho mailer',
      });
    }

    try {
      await this.amqpConnection.publish(exchange, MAILER_ROUTING_KEY, payload);
    } catch {
      throw new ErrorException({
        code: ErrorCode.MAILER_QUEUE_PUBLISH_FAILED,
        message: 'Đẩy mail job vào queue thất bại',
      });
    }
  }
}
