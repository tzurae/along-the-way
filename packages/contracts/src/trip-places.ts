import { isRecord } from "./type-guards";
import type { PlaceType } from "./trip-skeleton";

export type PreferenceLevel =
  | "must"
  | "want"
  | "optional"
  | "neutral"
  | "dislike";
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

export interface TripPlaceContributionDto {
  id: string;
  memberUserId: string;
  memberEmail: string;
  memberDisplayName: string | null;
  intakeMethod: IntakeMethod;
  sourceUrl: string | null;
  originalNote: string | null;
  createdAt: string;
  withdrawnAt: string | null;
  isOwn: boolean;
}

export interface MemberPlacePreferenceDto {
  memberUserId: string;
  memberEmail: string;
  memberDisplayName: string | null;
  level: PreferenceLevel | null;
  version: number | null;
  updatedAt: string | null;
  isOwn: boolean;
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
  durationMinutes: number | null;
  desiredDayIds: string[];
  excludedDayIds: string[];
  budgetAmountMinor: number | null;
  budgetCurrency: string | null;
  notes: string | null;
  preferenceConflict: boolean;
  contributions: TripPlaceContributionDto[];
  preferences: MemberPlacePreferenceDto[];
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
  desiredDayIds: string[];
  excludedDayIds: string[];
  budgetAmountMinor?: number | null;
  budgetCurrency?: string | null;
  notes?: string | null;
}

export interface UpdateMemberPreferenceInput {
  level: PreferenceLevel;
  expectedVersion?: number | null;
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

function preferenceLevel(value: unknown): PreferenceLevel {
  if (
    value === "must" ||
    value === "want" ||
    value === "optional" ||
    value === "neutral" ||
    value === "dislike"
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

function contribution(value: unknown): TripPlaceContributionDto {
  const row = record(value);
  const intakeMethod = row.intakeMethod;
  if (intakeMethod !== "google-maps-url" && intakeMethod !== "search" && intakeMethod !== "manual") return invalid();
  return {
    id: text(row.id),
    memberUserId: text(row.memberUserId),
    memberEmail: text(row.memberEmail),
    memberDisplayName: nullableText(row.memberDisplayName),
    intakeMethod,
    sourceUrl: nullableText(row.sourceUrl),
    originalNote: nullableText(row.originalNote),
    createdAt: text(row.createdAt),
    withdrawnAt: nullableText(row.withdrawnAt),
    isOwn: boolean(row.isOwn),
  };
}

function preference(value: unknown): MemberPlacePreferenceDto {
  const row = record(value);
  return {
    memberUserId: text(row.memberUserId),
    memberEmail: text(row.memberEmail),
    memberDisplayName: nullableText(row.memberDisplayName),
    level: row.level === null ? null : preferenceLevel(row.level),
    version: row.version === null ? null : integer(row.version),
    updatedAt: nullableText(row.updatedAt),
    isOwn: boolean(row.isOwn),
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
  return {
    id: text(row.id),
    tripId: text(row.tripId),
    placeId: text(row.placeId),
    provider: row.provider,
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
    scheduled: boolean(row.scheduled),
    durationMinutes: nullableInteger(row.durationMinutes),
    desiredDayIds: strings(row.desiredDayIds),
    excludedDayIds: strings(row.excludedDayIds),
    budgetAmountMinor: nullableInteger(row.budgetAmountMinor),
    budgetCurrency: nullableText(row.budgetCurrency),
    notes: nullableText(row.notes),
    preferenceConflict: boolean(row.preferenceConflict),
    contributions: Array.isArray(row.contributions) ? row.contributions.map(contribution) : invalid(),
    preferences: Array.isArray(row.preferences) ? row.preferences.map(preference) : invalid(),
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
