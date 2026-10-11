import { isRecord } from "./type-guards";
import type { PlaceType } from "./trip-skeleton";

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
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  timeZone: string | null;
  sourceUrl: string | null;
  attribution: string;
  observedAt: string;
  expiresAt: string;
}

export interface MemberVoteDto {
  memberUserId: string;
  memberEmail: string;
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
  assignedDayId: string | null;
  /** Applied order within the assigned day; null until a route order is applied. */
  dayPosition: number | null;
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

export interface ProviderCandidatesResponse {
  candidates: ProviderPlaceCandidateDto[];
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

export interface UpdateTripPlacePlanningInput {
  expectedVersion: number;
  durationMinutes?: number | null;
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
  if (
    value === "airport" ||
    value === "station" ||
    value === "lodging" ||
    value === "restaurant" ||
    value === "activity" ||
    value === "other"
  ) return value;
  return invalid();
}


function candidate(value: unknown): ProviderPlaceCandidateDto {
  const row = record(value);
  if (row.provider !== "google") return invalid();
  return {
    provider: "google",
    providerPlaceId: text(row.providerPlaceId),
    name: text(row.name),
    type: placeType(row.type),
    address: nullableText(row.address),
    latitude: row.latitude === null || typeof row.latitude === "number" ? row.latitude : invalid(),
    longitude: row.longitude === null || typeof row.longitude === "number" ? row.longitude : invalid(),
    timeZone: nullableText(row.timeZone),
    sourceUrl: nullableText(row.sourceUrl),
    attribution: text(row.attribution),
    observedAt: text(row.observedAt),
    expiresAt: text(row.expiresAt),
  };
}

export function parseMemberVote(value: unknown): MemberVoteDto {
  const row = record(value);
  return {
    memberUserId: text(row.memberUserId),
    memberEmail: text(row.memberEmail),
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
    assignedDayId,
    dayPosition: nullableInteger(row.dayPosition),
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

export function parseProviderCandidatesResponse(value: unknown): ProviderCandidatesResponse {
  const row = record(value);
  return {
    candidates: Array.isArray(row.candidates) ? row.candidates.map(candidate) : invalid(),
    ...(row.resolvedUrl === undefined ? {} : { resolvedUrl: text(row.resolvedUrl) }),
    attribution: text(row.attribution),
  };
}
