import { beforeEach, describe, expect, it, vi } from "vitest";

const { createTransport, sendMail } = vi.hoisted(() => ({
  createTransport: vi.fn(),
  sendMail: vi.fn(),
}));

vi.mock("nodemailer", () => ({
  default: { createTransport },
}));

import { SmtpEmailSender } from "../src/private-trips/smtp-email-sender";

beforeEach(() => {
  sendMail.mockReset();
  sendMail.mockResolvedValue({ messageId: "test-message" });
  createTransport.mockReset();
  createTransport.mockReturnValue({ sendMail });
});

describe("SmtpEmailSender sign-in email", () => {
  it("leads with the code and escapes the backup link href", async () => {
    const sender = new SmtpEmailSender({
      host: "smtp.example.test",
      port: 465,
      from: "official@example.test",
      requireTls: true,
      secure: true,
    });
    const url = "https://app.example.test/#magicToken=\"<danger>&next=1";

    await sender.sendMagicLink({
      to: "traveler@example.test",
      url,
      code: "314159",
    });

    expect(sendMail).toHaveBeenCalledTimes(1);
    const message = sendMail.mock.calls[0]![0] as { subject: string; html: string };
    expect(message.subject).toContain("314159");
    expect(message.html.indexOf("314159")).toBeGreaterThanOrEqual(0);
    expect(message.html.indexOf("314159")).toBeLessThan(message.html.indexOf("<a href="));
    expect(message.html).toContain(
      'href="https://app.example.test/#magicToken=&quot;&lt;danger&gt;&amp;next=1"',
    );
  });
});
