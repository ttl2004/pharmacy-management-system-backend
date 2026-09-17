import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MailerService as NestMailerService } from '@nestjs-modules/mailer';
import { SendMailOptions, SentMessageInfo } from 'nodemailer';
import { ErrorException } from '../../common/exceptions/error.exception';
import { ErrorCode } from '../../common/types/error-code';
import { SendMailInput } from './types/mailer.types';

@Injectable()
export class SmtpSender {
  constructor(
    private readonly configService: ConfigService,
    private readonly nestMailerService: NestMailerService,
  ) {}

  async send(input: SendMailInput): Promise<SentMessageInfo> {
    const from = this.resolveFrom(input.from);
    try {
      return await this.nestMailerService.sendMail({
        from,
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        subject: input.subject,
        template: input.templateName,
        context: input.context,
      });
    } catch {
      throw new ErrorException({
        code: ErrorCode.MAILER_SEND_FAILED,
        message: 'Gửi email thất bại',
      });
    }
  }

  private resolveFrom(fromInput?: SendMailOptions['from']) {
    if (fromInput) {
      return fromInput;
    }

    const fromDefault = this.configService.get<string>('mail.fromDefault');

    if (fromDefault) {
      return fromDefault;
    }

    const gmailUser = this.configService.get<string>('mail.gmail.user');

    if (gmailUser) {
      return gmailUser;
    }

    throw new ErrorException({
      code: ErrorCode.MAILER_CONFIG_MISSING,
      message: 'Thiếu cấu hình MAIL_FROM_DEFAULT hoặc MAIL_GMAIL_USER',
    });
  }
}
