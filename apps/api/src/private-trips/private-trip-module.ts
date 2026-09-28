import type {
  CreateTripInput,
  InviteDto,
  TripDto,
  TripSummaryDto,
  UserDto,
} from "@along-the-way/contracts/private-trips";

export type AuthenticatedUser = UserDto;
export type InviteReadModel = InviteDto;
export type TripReadModel = TripDto;
export type TripSummaryReadModel = TripSummaryDto;

export type { CreateTripInput };

export interface SessionResult {
  sessionToken: string;
  user: AuthenticatedUser;
}

export interface AcceptedInvite {
  tripId: string;
}

export interface IdentityAccessModule {
  requestMagicLink(email: string, inviteToken?: string): Promise<void>;
  consumeMagicLink(token: string): Promise<SessionResult>;
  authenticate(sessionToken: string): Promise<AuthenticatedUser | null>;
  logout(sessionToken: string): Promise<void>;
  inviteMember(
    userId: string,
    tripId: string,
    idempotencyKey: string,
    email: string,
  ): Promise<InviteReadModel>;
  acceptInvite(
    userId: string,
    idempotencyKey: string,
    token: string,
  ): Promise<AcceptedInvite>;
  revokeInvite(userId: string, tripId: string, inviteId: string): Promise<void>;
  removeMember(userId: string, tripId: string, memberUserId: string): Promise<void>;
}

export interface ReadinessProbe {
  isReady(): Promise<boolean>;
}

export interface TripWorkspaceModule {
  listTrips(userId: string): Promise<TripSummaryReadModel[]>;
  createTrip(
    userId: string,
    idempotencyKey: string,
    input: CreateTripInput,
  ): Promise<TripReadModel>;
  getTrip(userId: string, tripId: string): Promise<TripReadModel>;
}

export class AppError extends Error {
  constructor(
    readonly code:
      | "validation_error"
      | "rate_limited"
      | "unauthenticated"
      | "forbidden"
      | "trip_not_found"
      | "invite_not_found"
      | "conflict"
      | "invalid_magic_link"
      | "expired_magic_link"
      | "used_magic_link"
      | "revoked_magic_link"
      | "invalid_invite"
      | "expired_invite"
      | "used_invite"
      | "revoked_invite"
      | "invite_email_mismatch",
    message: string,
    readonly status: 400 | 401 | 403 | 404 | 409 | 429 = 400,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}
