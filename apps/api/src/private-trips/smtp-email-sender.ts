import nodemailer from "nodemailer";

import { safeInviteLabel, type EmailSender } from "./email-sender";

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

  async sendMagicLink(message: { to: string; url: string; code: string }) {
    await this.transport.sendMail({
      from: this.from,
      to: { address: message.to, name: "" },
      subject: "登入 Along the Way",
      text: `請在 7 天內使用以下一次性登入連結：\n\n${message.url}\n\n一次性登入碼：${message.code}\n請在你索取連結的瀏覽器輸入這組 6 位數登入碼。登入碼與連結共用一次登入機會，7 天後失效。\n\n如果你沒有索取這個連結，可以忽略這封信。`,
    });
  }

  async sendTripInvite(message: {
    to: string;
    tripName: string;
    inviterName: string;
    url: string;
  }) {
    const tripName = safeInviteLabel(message.tripName) || "未命名旅程";
    const inviterName = safeInviteLabel(message.inviterName) || "旅程成員";
    await this.transport.sendMail({
      from: this.from,
      to: { address: message.to, name: "" },
      subject: "邀請你加入旅程｜Along the Way",
      text: `「${inviterName}」邀請你以編輯者身分加入「${tripName}」（名稱由邀請人提供）。請打開以下連結，用這個電子郵件地址登入並接受邀請：\n\n${message.url}\n\n如果你沒有預期收到這封邀請，可以忽略這封信。`,
    });
  }
}
