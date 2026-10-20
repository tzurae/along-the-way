import { isRecord } from "./type-guards";
export { isRecord };

export type MemberRole = "owner" | "editor";

export interface UserDto {
  id: string;
  email: string;
  displayName: string | null;
  isAdmin: boolean;
}

export interface TripMemberDto {
  id: string;
  userId: string;
  email: string | null;
  displayName: string | null;
  role: MemberRole;
}

export interface InviteDto {
  id: string;
  email: string;
  role: "editor";
  expiresAt: string;
  status: "pending" | "accepted" | "revoked" | "expired";
}

export interface TripDayDto {
  id: string;
  date: string;
  title: string | null;
}

export interface CountryStopDto {
  id: string;
  countryCode: string;
  position: number;
  timeZone: string | null;
}

export interface TripDto {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  defaultCurrency: string | null;
  countryStops: CountryStopDto[];
  days: TripDayDto[];
  members: TripMemberDto[];
  invites: InviteDto[];
  memberCount: number;
  dayCount: number;
  role: MemberRole;
  version: number;
  /** The owner has let editors arrange the itinerary (place, move, order, remove scheduled places). */
  editorsCanSchedule: boolean;
}

export interface TripSummaryDto {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  defaultCurrency: string | null;
  countryStops: CountryStopDto[];
  memberCount: number;
  dayCount: number;
  role: MemberRole;
}

export interface TripAirportInput {
  name: string;
  timeZone: string;
  latitude?: number;
  longitude?: number;
}

export interface TripFlightInput {
  /** Empty when unknown; the API derives the itinerary title from the route. */
  serviceNumber: string;
  carrier: string | null;
  departureAirport: TripAirportInput;
  arrivalAirport: TripAirportInput;
  departureLocalDateTime: string;
  arrivalLocalDateTime: string;
  departureUtcOffset?: string | null;
  arrivalUtcOffset?: string | null;
}

export interface CreateTripInput {
  name: string;
  startDate: string;
  endDate: string;
  countryCodes: string[];
  flights: { outbound: TripFlightInput; return: TripFlightInput };
}

export interface SessionResponse {
  user: UserDto;
}

export type LinkedInviteOutcome =
  | "accepted"
  | "already-member"
  | "expired-or-revoked";

export interface MagicLinkConsumeResponse extends SessionResponse {
  acceptedTripId?: string;
  inviteOutcome?: LinkedInviteOutcome;
}

export interface MagicLinkConfirmationResponse {
  error: { code: "confirmation_required"; message: string };
  targetEmail: string;
  currentEmail: string | null;
}

export interface TripListResponse {
  trips: TripSummaryDto[];
}

export interface TripResponse {
  trip: TripDto;
}

export interface InviteResponse {
  invite: InviteDto;
}

export interface ConflictChange {
  eventId: string;
  actorId: string;
  actorDisplayName: string | null;
  actorEmail: string | null;
  actorIsActiveMember: boolean;
  isOwn: boolean;
  changedAt: string;
}

export interface TripChangeNotification {
  id: string;
  /** Notification watermark, not an expected aggregate version. */
  tripVersion: number;
  entityType: string;
  entityId: string;
  kind: string;
  summary: string;
}

export interface TripHistoryEvent {
  id: string;
  actorId: string;
  actorDisplayName: string | null;
  actorEmail: string | null;
  actorIsActiveMember: boolean;
  createdAt: string;
  eventType: string;
  targetType: string;
  targetId: string;
  targetName: string | null;
  reappliedFromVersion: number | null;
  summary: string;
}

export interface TripHistoryResponse {
  events: TripHistoryEvent[];
  nextCursor: string | null;
}

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    correlationId?: string;
    currentVersion?: number;
    latestChange?: ConflictChange | null;
    transitCallsNeeded?: number;
  };
}


function invalidResponse(): never {
  throw new Error("Invalid API response");
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : invalidResponse();
}

function nullableString(value: unknown) {
  return value === null || typeof value === "string" ? value : invalidResponse();
}

function countValue(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : invalidResponse();
}

function roleValue(value: unknown): MemberRole {
  return value === "owner" || value === "editor" ? value : invalidResponse();
}

function countryCodeValue(value: unknown) {
  const code = stringValue(value);
  return /^[A-Z]{2}$/.test(code) ? code : invalidResponse();
}

function countryStopValue(value: unknown): CountryStopDto {
  if (!isRecord(value)) return invalidResponse();
  return {
    id: stringValue(value.id),
    countryCode: countryCodeValue(value.countryCode),
    position: countValue(value.position),
    timeZone: nullableString(value.timeZone),
  };
}

function userValue(value: unknown): UserDto {
  if (!isRecord(value) || typeof value.isAdmin !== "boolean") return invalidResponse();
  return {
    id: stringValue(value.id),
    email: stringValue(value.email),
    displayName: nullableString(value.displayName),
    isAdmin: value.isAdmin,
  };
}

function memberValue(value: unknown): TripMemberDto {
  if (!isRecord(value)) return invalidResponse();
  return {
    id: stringValue(value.id),
    userId: stringValue(value.userId),
    email: nullableString(value.email),
    displayName: nullableString(value.displayName),
    role: roleValue(value.role),
  };
}

function inviteValue(value: unknown): InviteDto {
  if (!isRecord(value)) return invalidResponse();
  const status = value.status;
  if (
    status !== "pending" &&
    status !== "accepted" &&
    status !== "revoked" &&
    status !== "expired"
  ) {
    return invalidResponse();
  }
  if (value.role !== "editor") return invalidResponse();
  return {
    id: stringValue(value.id),
    email: stringValue(value.email),
    role: "editor",
    expiresAt: stringValue(value.expiresAt),
    status,
  };
}

function dayValue(value: unknown): TripDayDto {
  if (!isRecord(value)) return invalidResponse();
  return {
    id: stringValue(value.id),
    date: stringValue(value.date),
    title: nullableString(value.title),
  };
}

function summaryValue(value: unknown): TripSummaryDto {
  if (!isRecord(value)) return invalidResponse();
  return {
    id: stringValue(value.id),
    name: stringValue(value.name),
    startDate: stringValue(value.startDate),
    endDate: stringValue(value.endDate),
    defaultCurrency: nullableString(value.defaultCurrency),
    countryStops: Array.isArray(value.countryStops)
      ? value.countryStops.map(countryStopValue)
      : invalidResponse(),
    memberCount: countValue(value.memberCount),
    dayCount: countValue(value.dayCount),
    role: roleValue(value.role),
  };
}

function tripValue(value: unknown): TripDto {
  if (!isRecord(value)) return invalidResponse();
  const summary = summaryValue(value);
  return {
    ...summary,
    days: Array.isArray(value.days) ? value.days.map(dayValue) : invalidResponse(),
    members: Array.isArray(value.members)
      ? value.members.map(memberValue)
      : invalidResponse(),
    invites: Array.isArray(value.invites)
      ? value.invites.map(inviteValue)
      : invalidResponse(),
    version: countValue(value.version),
    // Absent in snapshots saved before the setting existed: those trips only let owners schedule.
    editorsCanSchedule: value.editorsCanSchedule === true,
  };
}

export function parseSessionResponse(value: unknown): SessionResponse {
  if (!isRecord(value)) return invalidResponse();
  return { user: userValue(value.user) };
}

export function parseMagicLinkConfirmationResponse(value: unknown): MagicLinkConfirmationResponse {
  if (!isRecord(value) || !isRecord(value.error) || value.error.code !== "confirmation_required") {
    return invalidResponse();
  }
  return {
    error: { code: "confirmation_required", message: stringValue(value.error.message) },
    targetEmail: stringValue(value.targetEmail),
    currentEmail: nullableString(value.currentEmail),
  };
}

export function parseMagicLinkConsumeResponse(value: unknown): MagicLinkConsumeResponse {
  if (!isRecord(value)) return invalidResponse();
  const acceptedTripId = value.acceptedTripId;
  const inviteOutcome = value.inviteOutcome;
  if (acceptedTripId !== undefined && typeof acceptedTripId !== "string") {
    return invalidResponse();
  }
  if (
    inviteOutcome !== undefined &&
    inviteOutcome !== "accepted" &&
    inviteOutcome !== "already-member" &&
    inviteOutcome !== "expired-or-revoked"
  ) {
    return invalidResponse();
  }
  return {
    user: userValue(value.user),
    ...(acceptedTripId === undefined ? {} : { acceptedTripId }),
    ...(inviteOutcome === undefined ? {} : { inviteOutcome }),
  };
}

export function parseTripListResponse(value: unknown): TripListResponse {
  if (!isRecord(value) || !Array.isArray(value.trips)) return invalidResponse();
  return { trips: value.trips.map(summaryValue) };
}

export function parseTripResponse(value: unknown): TripResponse {
  if (!isRecord(value)) return invalidResponse();
  return { trip: tripValue(value.trip) };
}

export function parseInviteResponse(value: unknown): InviteResponse {
  if (!isRecord(value)) return invalidResponse();
  return { invite: inviteValue(value.invite) };
}

export function parseApiError(value: unknown): ApiErrorResponse {
  if (!isRecord(value) || !isRecord(value.error)) return invalidResponse();
  const correlationId = value.error.correlationId;
  if (correlationId !== undefined && typeof correlationId !== "string") {
    return invalidResponse();
  }
  const currentVersion = value.error.currentVersion;
  if (
    currentVersion !== undefined &&
    (typeof currentVersion !== "number" || !Number.isSafeInteger(currentVersion))
  ) {
    return invalidResponse();
  }
  const transitCallsNeeded = value.error.transitCallsNeeded;
  if (
    (transitCallsNeeded !== undefined && (typeof transitCallsNeeded !== "number"
      || !Number.isSafeInteger(transitCallsNeeded) || transitCallsNeeded < 0))
    || (value.error.code === "transit_calls_changed" && transitCallsNeeded === undefined)
  ) return invalidResponse();
  return {
    error: {
      code: stringValue(value.error.code),
      message: stringValue(value.error.message),
      ...(correlationId ? { correlationId } : {}),
      ...(currentVersion === undefined ? {} : { currentVersion }),
      ...(transitCallsNeeded === undefined ? {} : { transitCallsNeeded }),
      ...(value.error.latestChange === undefined ? {} : {
        latestChange: value.error.latestChange === null ? null : conflictChange(value.error.latestChange),
      }),
    },
  };
}

function conflictChange(value: unknown): ConflictChange {
  if (!isRecord(value) || typeof value.isOwn !== "boolean" || typeof value.actorIsActiveMember !== "boolean") return invalidResponse();
  return {
    eventId: stringValue(value.eventId),
    actorId: stringValue(value.actorId),
    actorDisplayName: nullableString(value.actorDisplayName),
    actorEmail: nullableString(value.actorEmail),
    actorIsActiveMember: value.actorIsActiveMember,
    isOwn: value.isOwn,
    changedAt: stringValue(value.changedAt),
  };
}

export function parseTripChangeNotification(value: unknown): TripChangeNotification {
  if (!isRecord(value)) return invalidResponse();
  return {
    id: stringValue(value.id),
    tripVersion: countValue(value.tripVersion),
    entityType: stringValue(value.entityType),
    entityId: stringValue(value.entityId),
    kind: stringValue(value.kind),
    summary: stringValue(value.summary),
  };
}

export function parseTripHistoryResponse(value: unknown): TripHistoryResponse {
  if (!isRecord(value) || !Array.isArray(value.events)) return invalidResponse();
  return {
    nextCursor: nullableString(value.nextCursor),
    events: value.events.map((event) => {
      if (!isRecord(event)) return invalidResponse();
      return {
        id: stringValue(event.id),
        actorId: stringValue(event.actorId),
        actorDisplayName: nullableString(event.actorDisplayName),
        actorEmail: nullableString(event.actorEmail),
        actorIsActiveMember: event.actorIsActiveMember === true
          ? true
          : event.actorIsActiveMember === false
            ? false
            : invalidResponse(),
        createdAt: stringValue(event.createdAt),
        eventType: stringValue(event.eventType),
        targetType: stringValue(event.targetType),
        targetId: stringValue(event.targetId),
        targetName: nullableString(event.targetName),
        reappliedFromVersion: event.reappliedFromVersion === null ? null : countValue(event.reappliedFromVersion),
        summary: stringValue(event.summary),
      };
    }),
  };
}
