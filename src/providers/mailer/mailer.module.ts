import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { RabbitMQModule } from '@golevelup/nestjs-rabbitmq';
import { MailerModule as NestMailerModule } from '@nestjs-modules/mailer';
import { HandlebarsAdapter } from '@nestjs-modules/mailer/adapters/handlebars.adapter';
import path from 'node:path';
import { ErrorException } from '../../common/exceptions/error.exception';
import { ErrorCode } from '../../common/types/error-code';
import { MailerService } from './mailer.service';
import { MAIL_RABBITMQ_EXCHANGE, MAIL_RABBITMQ_QUEUE } from './types/mailer.constants';
import { SmtpSender } from './smtp.sender';
import { MailQueuePublisher } from './mailer-queue/mail-queue.publisher';
import { MailQueueConsumer } from './mailer-queue/mail-queue.consumer';

@Module({
  imports: [
    ConfigModule,
    NestMailerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const gmailUser = configService.get<string>('mail.gmail.user');
        const appPassword = configService.get<string>('mail.gmail.appPassword');
        const templateDir = configService.get<string>('mail.templateDir');

        if (!gmailUser || !appPassword || !templateDir) {
          throw new ErrorException({
            code: ErrorCode.MAILER_CONFIG_MISSING,
            message: 'Thiếu cấu hình Gmail hoặc template cho mailer',
          });
        }

        const fromDefault = configService.get<string>('mail.fromDefault') ?? gmailUser;

        return {
          transport: {
            service: 'gmail',
            auth: {
              user: gmailUser,
              pass: appPassword,
            },
          },
          defaults: {
            from: fromDefault,
          },
          template: {
            dir: path.resolve(templateDir),
            adapter: new HandlebarsAdapter(),
            options: {
              strict: true,
            },
          },
        };
      },
    }),
    RabbitMQModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        uri: configService.get<string>('mail.rabbitmq.url') ?? 'amqp://guest:guest@localhost:5672',
        exchanges: [
          {
            name: configService.get<string>('mail.rabbitmq.exchange') ?? MAIL_RABBITMQ_EXCHANGE,
            type: 'topic',
          },
        ],
        queues: [
          {
            name: configService.get<string>('mail.rabbitmq.queue') ?? MAIL_RABBITMQ_QUEUE,
            exchange: configService.get<string>('mail.rabbitmq.exchange') ?? MAIL_RABBITMQ_EXCHANGE,
            routingKey: 'mailer.send',
          },
        ],
        connectionInitOptions: {
          wait: false,
        },
      }),
    }),
  ],
  providers: [MailerService, SmtpSender, MailQueuePublisher, MailQueueConsumer],
  exports: [MailerService],
})
export class MailerModule {}
