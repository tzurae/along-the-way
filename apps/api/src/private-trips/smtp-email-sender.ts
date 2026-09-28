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
      subject: "Sign in to Along the Way",
      text: `Use this one-time link within 15 minutes:\n\n${message.url}`,
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
      subject: `Join ${message.tripName} on Along the Way`,
      text: `You were invited as an editor. Sign in with this email, then accept the invitation:\n\n${message.url}`,
    });
  }
}
