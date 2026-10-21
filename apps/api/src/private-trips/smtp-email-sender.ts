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
    // The code works in whichever app or browser asked for it; a link can open in another
    // browser (Gmail's, Safari) whose sign-in the home-screen app never sees. Lead with the code.
    const code = /^\d{6}$/.test(message.code) ? message.code : "";
    const href = escapeHtml(message.url);
    await this.transport.sendMail({
      from: this.from,
      to: { address: message.to, name: "" },
      subject: `登入碼 ${code}｜Along the Way`,
      text: `你的登入碼：${code}\n\n請回到你正在使用的 Along the Way（同一個 App 或瀏覽器），在登入頁輸入這組 6 位數登入碼。\n\n備用：如果你就是在這支手機的同一個瀏覽器使用，也可以點下面的連結登入。連結可能會用信箱 App 內建的瀏覽器打開，那樣登入不會出現在你原本的 App 裡。\n${message.url}\n\n登入碼與連結共用一次登入機會，7 天後失效。如果你沒有索取這封信，可以忽略。`,
      html: `<div style="font-family:-apple-system,'Noto Sans TC',sans-serif;color:#24372f;max-width:480px">
<p style="margin:0 0 8px;font-size:16px">你的登入碼</p>
<p style="margin:0 0 16px;font-size:40px;font-weight:700;letter-spacing:8px;font-family:ui-monospace,Menlo,monospace">${code}</p>
<p style="margin:0 0 24px;font-size:16px;line-height:1.6">請回到你正在使用的 Along the Way（同一個 App 或瀏覽器），在登入頁輸入這組 6 位數登入碼。</p>
<p style="margin:0 0 4px;font-size:13px;color:#52645c">備用：如果你就是在這支手機的同一個瀏覽器使用，也可以點這個連結登入。連結可能會用信箱 App 內建的瀏覽器打開，那樣登入不會出現在你原本的 App 裡。</p>
<p style="margin:0 0 24px;font-size:13px"><a href="${href}" style="color:#b55737">用連結登入</a></p>
<p style="margin:0;font-size:12px;color:#52645c">登入碼與連結共用一次登入機會，7 天後失效。如果你沒有索取這封信，可以忽略。</p>
</div>`,
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

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}
