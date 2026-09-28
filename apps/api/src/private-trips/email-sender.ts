export interface EmailSender {
  sendMagicLink(message: { to: string; url: string }): Promise<void>;
  sendTripInvite(message: {
    to: string;
    tripName: string;
    url: string;
  }): Promise<void>;
}
