import { SendMailOptions } from 'nodemailer';

export type MailSendMode = 'sync' | 'async';

export interface SendMailInput {
  to: SendMailOptions['to'];
  cc?: SendMailOptions['cc'];
  bcc?: SendMailOptions['bcc'];
  subject: string;
  templateName: string;
  context: Record<string, unknown>;
  from?: SendMailOptions['from'];
}

export interface MailJobPayload extends SendMailInput {}

export interface MailSendResult {
  mode: MailSendMode;
  messageId?: string;
}
