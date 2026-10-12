import nodemailer from "nodemailer";

import type { EmailSender } from "./email-sender";

interface SmtpEmailSenderOptions {
  host: string;
  port: number;
  from: string;
  password?: string;
  requireTls: boolean;
  secure: boolean;
  username?: string;
}

export class SmtpEmailSender implements EmailSender {
  private readonly transport;
  private readonly from: string;

  constructor(options: SmtpEmailSenderOptions) {
    this.transport = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      secure: options.secure,
      requireTLS: options.requireTls,
      ...(options.username && options.password
        ? { auth: { user: options.username, pass: options.password } }
        : {}),
    });
    this.from = options.from;
  }

  async sendMagicLink(message: { to: string; url: string }) {
    await this.transport.sendMail({
      from: this.from,
      to: message.to,
      subject: "登入 Along the Way",
      text: `請在 15 分鐘內使用以下一次性登入連結：\n\n${message.url}\n\n如果你沒有索取這個連結，可以忽略這封信。`,
    });
  }

  async sendTripInvite(message: {
    to: string;
    tripName: string;
    url: string;
  }) {
    await this.transport.sendMail({
      from: this.from,
      to: message.to,
      subject: `邀請你加入「${message.tripName}」｜Along the Way`,
      text: `你被邀請以編輯者身分加入「${message.tripName}」。請打開以下連結，用這個電子郵件地址登入並接受邀請：\n\n${message.url}\n\n如果你沒有預期收到這封邀請，可以忽略這封信。`,
    });
  }
}
