import { TokenIssuer } from "../private-trips/token-issuer";

export interface GooglePhotoCapabilityValue {
  exp: number;
  sig: string;
}

export class GooglePhotoCapability {
  private readonly issuer: TokenIssuer;

  constructor(
    secret: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.issuer = new TokenIssuer(secret);
  }

  issue(
    tripId: string,
    userId: string,
    providerPlaceId: string,
    index: 0 | 1 | 2,
    fingerprint: string,
    photoName: string,
  ): GooglePhotoCapabilityValue {
    const now = this.now();
    const exp = Math.floor(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 2,
    ) / 1_000) - 1;
    return {
      exp,
      sig: this.issuer.issue(this.identifier(tripId, userId, providerPlaceId, index, fingerprint, photoName, exp)),
    };
  }

  matches(
    tripId: string,
    userId: string,
    providerPlaceId: string,
    index: 0 | 1 | 2,
    fingerprint: string,
    photoName: string,
    rawExpiry: string | null,
    signature: string | null,
  ) {
    if (!rawExpiry || !/^[1-9][0-9]{9}$/.test(rawExpiry)
      || !signature || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return false;
    const exp = Number(rawExpiry);
    if (!Number.isSafeInteger(exp) || exp < Math.floor(this.now().getTime() / 1_000)) return false;
    return this.issuer.matches(
      this.identifier(tripId, userId, providerPlaceId, index, fingerprint, photoName, exp),
      signature,
    );
  }

  private identifier(
    tripId: string,
    userId: string,
    providerPlaceId: string,
    index: 0 | 1 | 2,
    fingerprint: string,
    photoName: string,
    exp: number,
  ) {
    return `${tripId}|${userId}|${providerPlaceId}|${index}|${fingerprint}|${photoName}|${exp}`;
  }
}
