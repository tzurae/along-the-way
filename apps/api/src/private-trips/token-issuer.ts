import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function hashToken(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export class TokenIssuer {
  private readonly secret: Buffer;

  constructor(secret: string) {
    this.secret = Buffer.from(secret);
    if (this.secret.byteLength < 32) {
      throw new Error("TOKEN_SECRET must contain at least 32 bytes");
    }
  }

  issue(identifier: string) {
    return createHmac("sha256", this.secret)
      .update(identifier)
      .digest("base64url");
  }

  matches(identifier: string, candidate: string) {
    const expected = Buffer.from(this.issue(identifier));
    const actual = Buffer.from(candidate);
    return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
  }
}
