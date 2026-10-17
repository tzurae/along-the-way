export interface EmailSender {
  sendMagicLink(message: { to: string; url: string; code: string }): Promise<void>;
  sendTripInvite(message: {
    to: string;
    tripName: string;
    inviterName: string;
    url: string;
  }): Promise<void>;
}

// These labels are untrusted user content, not links endorsed by the official sender.
export function safeInviteLabel(value: string) {
  return value.normalize("NFKC")
    .replace(/(?:https?[^\s]*|www\.[^\s]*|(?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,}(?:[/:?#][^\s]*)?)/giu, "")
    .replace(/[\p{Cc}\p{Cf}\s]+/gu, " ")
    .trim().slice(0, 60);
}
