import type {
  CreateTripInput,
  InviteDto,
  LinkedInviteOutcome,
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
  acceptedTripId?: string;
  inviteOutcome?: LinkedInviteOutcome;
}

export interface LoginContext {
  nonce: string;
  sessionToken: string;
  confirm: boolean;
}

export interface LoginConfirmation {
  confirmationRequired: true;
  targetEmail: string;
  currentEmail: string | null;
}

export type LoginResult = SessionResult | LoginConfirmation;

export interface AcceptedInvite {
  tripId: string;
}

export interface IdentityAccessModule {
  requestMagicLink(email: string, nonce: string): Promise<void>;
  requestInviteMagicLink(inviteToken: string, nonce: string): Promise<void>;
  consumeMagicLink(token: string, context: LoginContext): Promise<LoginResult>;
  verifyMagicLinkCode(email: string, code: string, context: LoginContext): Promise<LoginResult>;
  authenticate(sessionToken: string): Promise<AuthenticatedUser | null>;
  logout(sessionToken: string, targetUserId?: string): Promise<void>;
  logoutEverywhere(userId: string): Promise<void>;
  /** Self-only: set or clear the signed-in member's nickname. */
  updateDisplayName(userId: string, displayName: string | null): Promise<AuthenticatedUser>;
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
  revokeInvite(
    userId: string,
    tripId: string,
    inviteId: string,
    idempotencyKey: string,
  ): Promise<void>;
  removeMember(
    userId: string,
    tripId: string,
    memberUserId: string,
    idempotencyKey: string,
  ): Promise<void>;
  /** Owner-only: let editors arrange the itinerary, or take that back. */
  setEditorsCanSchedule(
    userId: string,
    tripId: string,
    idempotencyKey: string,
    enabled: boolean,
  ): Promise<void>;
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
      | "adjacent_country_stops"
      | "rate_limited"
      | "maps_daily_limit"
      | "invalid_local_time"
      | "ambiguous_local_time"
      | "place_not_found"
      | "item_not_found"
      | "constraint_not_found"
      | "item_locked"
      | "place_in_use"
      | "travel_place"
      | "flight_order"
      | "unauthenticated"
      | "forbidden"
      | "trip_not_found"
      | "trip_place_not_found"
      | "trip_day_not_found"
      | "already_in_wishlist"
      | "must_item_duplicate"
      | "must_item_limit"
      | "duplicate_suggestion_not_found"
      | "discovery_proposal_not_found"
      | "model_unavailable"
      | "provider_unavailable"
      | "provider_quota"
      | "research_in_progress"
      | "research_limit_reached"
      | "voting_unavailable"
      | "invite_not_found"
      | "conflict"
      | "logout_target_mismatch"
      | "invalid_magic_link"
      | "invalid_magic_code"
      | "expired_magic_link"
      | "used_magic_link"
      | "revoked_magic_link"
      | "invalid_invite"
      | "expired_invite"
      | "used_invite"
      | "revoked_invite"
      | "invite_email_mismatch"
      | "place_photo_not_found"
      | "commons_photo_not_found"
      | "service_unavailable"
      | "feedback_not_found"
      | "candidate_not_found"
      | "candidate_asset_not_found"
      | "candidate_already_decided"
      | "place_photo_unavailable",
    message: string,
    readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 502 | 503 = 400,
    readonly retryAfterSeconds?: number,
    readonly currentVersion?: number,
    readonly conflictTargetId?: string,
  ) {
    super(message);
  }
}
