import { parseGooglePlacePhoto, type GooglePlacePhotoDto } from "./place-details";
import { isRecord } from "./type-guards";
import { isPlaceType, type PlaceType } from "./trip-skeleton";

export type TripPlaceStatus =
  | "ready"
  | "needs-location"
  | "possible-duplicate"
  | "provider-unavailable"
  | "scheduled";
export type IntakeMethod = "google-maps-url" | "search" | "manual";

export interface ProviderPlaceCandidateDto {
  provider: "google";
  providerPlaceId: string;
  name: string;
  type: PlaceType;
  typeLabel: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  timeZone: string | null;
  sourceUrl: string | null;
  attribution: string;
  observedAt: string;
  expiresAt: string;
  photo: GooglePlacePhotoDto | null;
}

export interface ProviderPlaceSearchResultDto extends ProviderPlaceCandidateDto {
  alreadyInWishlist: boolean;
}


export type NearbyAlternativeDto = {
  providerPlaceId: string;
  name: string;
  type: PlaceType;
  address: string | null;
  latitude: number;
  longitude: number;
  sourceUrl: string | null;
  attribution: ProviderPlaceCandidateDto["attribution"];
  photo: GooglePlacePhotoDto | null;
  rating: number | null;
  userRatingCount: number | null;
  straightLineMeters: number;
};

export type NearbyAlternativesResponse = {
  dayId: string;
  stopTripPlaceId: string;
  dayVersion: number;
  alternatives: NearbyAlternativeDto[];
};

export type NearbyActivityKind = "event" | "experience";

/** One thing happening near a stop on one local date; view-only, never part of the itinerary. */
export type NearbyActivityDto = {
  title: string;
  /** One sentence in zh-TW. */
  description: string;
  /** Time wording a source states but that is not a plain start/end clock time; null when none. */
  timeText: string | null;
  /** Stop-local wall clock `YYYY-MM-DDTHH:MM`, only when a source states it. */
  startsAt: string | null;
  endsAt: string | null;
  kind: NearbyActivityKind;
  venueName: string | null;
  latitude: number | null;
  longitude: number | null;
  straightLineMeters: number | null;
  /** A page the provider's web search returned in the same request. */
  sourceUrl: string;
  sourceTitle: string | null;
};

export type NearbyActivitiesResponse = {
  stopTripPlaceId: string;
  /** The day's local date the activities were searched for. */
  date: string;
  /** When the provider answered; a cached answer keeps its original time. */
  fetchedAt: string;
  activities: NearbyActivityDto[];
};

export type StopReplacementDto = {
  replacementId: string;
  originalTripPlaceId: string;
  originalName: string;
};
export interface MemberVoteDto {
  memberUserId: string;
  memberEmail: string | null;
  memberDisplayName: string | null;
}

export interface DuplicateSuggestionDto {
  id: string;
  otherTripPlaceId: string;
  reason: string;
  status: "pending" | "kept-separate";
}

export interface TripPlaceDto {
  id: string;
  tripId: string;
  placeId: string;
  /** The skeleton/itinerary `PlaceDto.id` backing this wishlist place; differs from the canonical `placeId`. */
  legacyPlaceId: string | null;
  provider: "google" | "manual";
  aiProposalId: string | null;
  providerPlaceId: string | null;
  providerObservedAt: string | null;
  providerExpiresAt: string | null;
  providerAttribution: string | null;
  factsSource: "provider" | "member";
  providerFactsExpired: boolean;
  name: string;
  type: PlaceType;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  timeZone: string | null;
  status: TripPlaceStatus;
  scheduled: boolean;
  /** Durable itinerary intent; votes and Pocket intake do not select a place. */
  selectedForItinerary: boolean;
  /** Last removed placement's local date, or null when unknown or currently placed. */
  unplacedFromDate: string | null;
  durationMinutes: number | null;
  /** Historical responses without this field are read as null. */
  effortLevel: number | null;
  assignedDayId: string | null;
  /** Applied order within the assigned day; null until a route order is applied. */
  dayPosition: number | null;
  replacedStop: StopReplacementDto | null;
  budgetAmountMinor: number | null;
  budgetCurrency: string | null;
  notes: string | null;
  sourceUrl: string | null;
  voters: MemberVoteDto[];
  voteCount: number;
  ownVote: boolean;
  votingAvailable: boolean;
  duplicateSuggestions: DuplicateSuggestionDto[];
  version: number;
}

export interface TripPlaceListResponse {
  tripPlaces: TripPlaceDto[];
}

export interface TripPlaceResponse {
  tripPlace: TripPlaceDto;
}

export type MustItemKind = "buy" | "eat" | "drink";

export interface TripPlaceMustItemDto {
  id: string;
  tripPlaceId: string;
  kind: MustItemKind;
  label: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface TripPlaceMustItemListResponse {
  items: TripPlaceMustItemDto[];
}

export interface TripPlaceMustItemResponse {
  item: TripPlaceMustItemDto;
}

export interface ProviderCandidatesResponse {
  candidates: ProviderPlaceSearchResultDto[];
  resolvedUrl?: string;
  attribution: string;
}

export interface CreateManualTripPlaceInput {
  method: "manual";
  name: string;
  type: PlaceType;
  address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  timeZone?: string | null;
  sourceUrl?: string | null;
  originalNote?: string | null;
}

export interface CreateProviderTripPlaceInput {
  method: "google-maps-url" | "search";
  providerPlaceId: string;
  sourceUrl?: string | null;
  originalNote?: string | null;
}

export type CreateTripPlaceInput =
  | CreateManualTripPlaceInput
  | CreateProviderTripPlaceInput;

/**
 * Existing planning fields treat omission as null. effortLevel is tri-state:
 * omitted preserves, null clears, and an integer from 1 through 5 sets it.
 */
export interface UpdateTripPlacePlanningInput {
  expectedVersion: number;
  durationMinutes?: number | null;
  effortLevel?: number | null;
  budgetAmountMinor?: number | null;
  budgetCurrency?: string | null;
  notes?: string | null;
}

export interface RemoveTripPlaceInput {
  expectedVersion: number;
}

export interface TripPlaceDayAssignmentInput {
  tripPlaceId: string;
  tripDayId: string | null;
  expectedVersion: number;
}

export interface UpdateTripPlaceDayAssignmentsInput {
  assignments: TripPlaceDayAssignmentInput[];
}

export interface UpdateMemberVoteInput {
  voted: boolean;
}

export interface MergeTripPlacesInput {
  targetTripPlaceId: string;
  expectedSourceVersion: number;
  expectedTargetVersion: number;
}

function invalid(): never {
  throw new Error("Invalid trip place response");
}

function record(value: unknown) {
  return isRecord(value) ? value : invalid();
}

function text(value: unknown) {
  return typeof value === "string" ? value : invalid();
}

function nullableText(value: unknown) {
  return value === null || typeof value === "string" ? value : invalid();
}

function nullableDate(value: unknown) {
  if (value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return invalid();
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
    ? value
    : invalid();
}

function integer(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : invalid();
}

function nullableInteger(value: unknown) {
  return value === null ? null : integer(value);
}

function boolean(value: unknown) {
  return typeof value === "boolean" ? value : invalid();
}

function strings(value: unknown) {
  return Array.isArray(value) ? value.map(text) : invalid();
}

function placeType(value: unknown): PlaceType {
  return isPlaceType(value) ? value : invalid();
}


export function parseProviderPlaceCandidate(value: unknown): ProviderPlaceCandidateDto {
  const row = record(value);
  if (row.provider !== "google") return invalid();
  return {
    provider: "google",
    providerPlaceId: text(row.providerPlaceId),
    name: text(row.name),
    type: placeType(row.type),
    typeLabel: nullableText(row.typeLabel),
    address: nullableText(row.address),
    latitude: row.latitude === null || typeof row.latitude === "number" ? row.latitude : invalid(),
    longitude: row.longitude === null || typeof row.longitude === "number" ? row.longitude : invalid(),
    timeZone: nullableText(row.timeZone),
    sourceUrl: nullableText(row.sourceUrl),
    attribution: text(row.attribution),
    observedAt: text(row.observedAt),
    expiresAt: text(row.expiresAt),
    photo: row.photo === null ? null : parseGooglePlacePhoto(row.photo),
  };
}

function searchResult(value: unknown): ProviderPlaceSearchResultDto {
  const row = record(value);
  return { ...parseProviderPlaceCandidate(row), alreadyInWishlist: boolean(row.alreadyInWishlist) };
}

export function parseMemberVote(value: unknown): MemberVoteDto {
  const row = record(value);
  return {
    memberUserId: text(row.memberUserId),
    memberEmail: nullableText(row.memberEmail),
    memberDisplayName: nullableText(row.memberDisplayName),
  };
}

function duplicate(value: unknown): DuplicateSuggestionDto {
  const row = record(value);
  if (row.status !== "pending" && row.status !== "kept-separate") return invalid();
  return {
    id: text(row.id),
    otherTripPlaceId: text(row.otherTripPlaceId),
    reason: text(row.reason),
    status: row.status,
  };
}

function stopReplacement(value: unknown): StopReplacementDto {
  const row = record(value);
  return {
    replacementId: text(row.replacementId),
    originalTripPlaceId: text(row.originalTripPlaceId),
    originalName: text(row.originalName),
  };
}

function nearbyAlternative(value: unknown): NearbyAlternativeDto {
  const row = record(value);
  const latitude = row.latitude;
  const longitude = row.longitude;
  const rating = row.rating;
  const userRatingCount = nullableInteger(row.userRatingCount);
  const distance = integer(row.straightLineMeters);
  if (typeof latitude !== "number" || !Number.isFinite(latitude) || Math.abs(latitude) > 90
    || typeof longitude !== "number" || !Number.isFinite(longitude) || Math.abs(longitude) > 180
    || (rating !== null && (typeof rating !== "number" || !Number.isFinite(rating) || rating < 1 || rating > 5))
    || (userRatingCount !== null && userRatingCount < 0) || distance < 0) return invalid();
  return {
    providerPlaceId: text(row.providerPlaceId),
    name: text(row.name),
    type: placeType(row.type),
    address: nullableText(row.address),
    latitude,
    longitude,
    sourceUrl: nullableText(row.sourceUrl),
    attribution: text(row.attribution),
    photo: row.photo === null ? null : parseGooglePlacePhoto(row.photo),
    rating,
    userRatingCount,
    straightLineMeters: distance,
  };
}

export function parseNearbyAlternativesResponse(value: unknown): NearbyAlternativesResponse {
  const row = record(value);
  const dayVersion = integer(row.dayVersion);
  if (dayVersion < 1) return invalid();
  return {
    dayId: text(row.dayId),
    stopTripPlaceId: text(row.stopTripPlaceId),
    dayVersion,
    alternatives: Array.isArray(row.alternatives) ? row.alternatives.map(nearbyAlternative) : invalid(),
  };
}

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/;

function httpUrl(value: unknown) {
  const raw = text(value);
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? raw : invalid();
  } catch {
    return invalid();
  }
}

function nearbyActivity(value: unknown): NearbyActivityDto {
  const row = record(value);
  const { latitude, longitude } = row;
  const located = latitude !== null || longitude !== null;
  if (located && (typeof latitude !== "number" || !Number.isFinite(latitude) || Math.abs(latitude) > 90
    || typeof longitude !== "number" || !Number.isFinite(longitude) || Math.abs(longitude) > 180)) return invalid();
  const distance = nullableInteger(row.straightLineMeters);
  // A distance is measured to the venue, so it never exists without the venue's coordinates.
  if (distance !== null && (distance < 0 || !located)) return invalid();
  if (row.kind !== "event" && row.kind !== "experience") return invalid();
  for (const time of [row.startsAt, row.endsAt]) {
    if (time !== null && (typeof time !== "string" || !LOCAL_DATE_TIME.test(time))) return invalid();
  }
  const title = text(row.title);
  if (!title.trim()) return invalid();
  return {
    title,
    description: text(row.description),
    timeText: nullableText(row.timeText),
    startsAt: row.startsAt as string | null,
    endsAt: row.endsAt as string | null,
    kind: row.kind,
    venueName: nullableText(row.venueName),
    latitude: located ? latitude as number : null,
    longitude: located ? longitude as number : null,
    straightLineMeters: distance,
    sourceUrl: httpUrl(row.sourceUrl),
    sourceTitle: nullableText(row.sourceTitle),
  };
}

export function parseNearbyActivitiesResponse(value: unknown): NearbyActivitiesResponse {
  const row = record(value);
  const date = text(row.date);
  const fetchedAt = text(row.fetchedAt);
  if (!LOCAL_DATE.test(date) || !Number.isFinite(Date.parse(fetchedAt))) return invalid();
  return {
    stopTripPlaceId: text(row.stopTripPlaceId),
    date,
    fetchedAt,
    activities: Array.isArray(row.activities) ? row.activities.map(nearbyActivity) : invalid(),
  };
}

function tripPlace(value: unknown): TripPlaceDto {
  const row = record(value);
  const status = row.status;
  if (
    status !== "ready" &&
    status !== "needs-location" &&
    status !== "possible-duplicate" &&
    status !== "provider-unavailable" &&
    status !== "scheduled"
  ) return invalid();
  if (row.provider !== "google" && row.provider !== "manual") return invalid();
  if (row.factsSource !== "provider" && row.factsSource !== "member") return invalid();
  const scheduled = boolean(row.scheduled);
  const assignedDayId = nullableText(row.assignedDayId);
  const selectedForItinerary = boolean(row.selectedForItinerary);
  const unplacedFromDate = nullableDate(row.unplacedFromDate);
  if ((scheduled || assignedDayId !== null) && (!selectedForItinerary || unplacedFromDate !== null)) {
    return invalid();
  }
  if (unplacedFromDate !== null && !selectedForItinerary) return invalid();
  return {
    id: text(row.id),
    tripId: text(row.tripId),
    placeId: text(row.placeId),
    legacyPlaceId: nullableText(row.legacyPlaceId ?? null),
    provider: row.provider,
    aiProposalId: nullableText(row.aiProposalId),
    providerPlaceId: nullableText(row.providerPlaceId),
    providerObservedAt: nullableText(row.providerObservedAt),
    providerExpiresAt: nullableText(row.providerExpiresAt),
    providerAttribution: nullableText(row.providerAttribution),
    factsSource: row.factsSource,
    providerFactsExpired: boolean(row.providerFactsExpired),
    name: text(row.name),
    type: placeType(row.type),
    address: nullableText(row.address),
    latitude: row.latitude === null || typeof row.latitude === "number" ? row.latitude : invalid(),
    longitude: row.longitude === null || typeof row.longitude === "number" ? row.longitude : invalid(),
    timeZone: nullableText(row.timeZone),
    status,
    scheduled,
    selectedForItinerary,
    unplacedFromDate,
    durationMinutes: nullableInteger(row.durationMinutes),
    effortLevel: row.effortLevel == null ? null
      : typeof row.effortLevel === "number" && Number.isInteger(row.effortLevel) && row.effortLevel >= 1 && row.effortLevel <= 5
        ? row.effortLevel : invalid(),
    assignedDayId,
    dayPosition: nullableInteger(row.dayPosition),
    replacedStop: row.replacedStop == null ? null : stopReplacement(row.replacedStop),
    budgetAmountMinor: nullableInteger(row.budgetAmountMinor),
    budgetCurrency: nullableText(row.budgetCurrency),
    notes: nullableText(row.notes),
    // Stored idempotent replies predate sourceUrl; their contributions were ordered oldest first.
    sourceUrl: row.sourceUrl === undefined
      ? Array.isArray(row.contributions) && isRecord(row.contributions[0])
        ? nullableText(row.contributions[0].sourceUrl ?? null)
        : null
      : nullableText(row.sourceUrl),
    voters: Array.isArray(row.voters) ? row.voters.map(parseMemberVote) : invalid(),
    voteCount: integer(row.voteCount),
    ownVote: boolean(row.ownVote),
    votingAvailable: boolean(row.votingAvailable),
    duplicateSuggestions: Array.isArray(row.duplicateSuggestions)
      ? row.duplicateSuggestions.map(duplicate)
      : invalid(),
    version: integer(row.version),
  };
}

export function parseTripPlaceListResponse(value: unknown): TripPlaceListResponse {
  const row = record(value);
  return {
    tripPlaces: Array.isArray(row.tripPlaces) ? row.tripPlaces.map(tripPlace) : invalid(),
  };
}

export function parseTripPlaceResponse(value: unknown): TripPlaceResponse {
  return { tripPlace: tripPlace(record(value).tripPlace) };
}

function mustItem(value: unknown): TripPlaceMustItemDto {
  const row = record(value);
  if (row.kind !== "buy" && row.kind !== "eat" && row.kind !== "drink") return invalid();
  return {
    id: text(row.id),
    tripPlaceId: text(row.tripPlaceId),
    kind: row.kind,
    label: text(row.label),
    version: integer(row.version),
    createdAt: text(row.createdAt),
    updatedAt: text(row.updatedAt),
  };
}

export function parseTripPlaceMustItemListResponse(
  value: unknown,
): TripPlaceMustItemListResponse {
  const row = record(value);
  return {
    items: Array.isArray(row.items) ? row.items.map(mustItem) : invalid(),
  };
}

export function parseTripPlaceMustItemResponse(
  value: unknown,
): TripPlaceMustItemResponse {
  return { item: mustItem(record(value).item) };
}

export function parseProviderCandidatesResponse(value: unknown): ProviderCandidatesResponse {
  const row = record(value);
  return {
    candidates: Array.isArray(row.candidates) ? row.candidates.map(searchResult) : invalid(),
    ...(row.resolvedUrl === undefined ? {} : { resolvedUrl: text(row.resolvedUrl) }),
    attribution: text(row.attribution),
  };
}
