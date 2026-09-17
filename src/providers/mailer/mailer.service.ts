import { Injectable } from '@nestjs/common';
import { MailSendMode, MailSendResult, SendMailInput } from './types/mailer.types';
import { SmtpSender } from './smtp.sender';
import { MailQueuePublisher } from './mailer-queue/mail-queue.publisher';

@Injectable()
export class MailerService {
  constructor(
    private readonly smtpSender: SmtpSender,
    private readonly mailQueuePublisher: MailQueuePublisher,
  ) {}

  async send(input: SendMailInput, mode: MailSendMode = 'sync'): Promise<MailSendResult> {
    if (mode === 'async') {
      await this.mailQueuePublisher.publish(input);
      return { mode };
    }

    const sendInfo = await this.smtpSender.send(input);

    return {
      mode,
      messageId: sendInfo.messageId,
    };
  }
}
