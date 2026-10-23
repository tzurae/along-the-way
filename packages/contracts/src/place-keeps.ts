import { isRecord } from "./type-guards";
import { isPlaceType, type PlaceType } from "./trip-skeleton";

/** Longest 下次還要來 reason, counted in Unicode code points (PostgreSQL `char_length`). */
export const PLACE_KEEP_NOTE_MAX = 280;

/**
 * 下次還要來: one traveller's mark on a canonical place, as seen from one trip.
 * Visible to the keeper and to everyone who currently shares at least one trip with them.
 */
export interface PlaceKeepDto {
  id: string;
  placeIdentityId: string;
  provider: "google" | "manual";
  /** Google place ID used to add the place again; null for manual places. */
  providerPlaceId: string | null;
  name: string;
  type: PlaceType;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  timeZone: string | null;
  note: string | null;
  /** The keeper's nickname; null when they have not set one. Emails are never exposed. */
  keeperDisplayName: string | null;
  own: boolean;
  /** The trip the place was kept from, only while the viewer is still a member of it. */
  fromTrip: { name: string; startDate: string } | null;
  createdAt: string;
  /** The place identity is an active (non-archived) place of the trip in the request URL. */
  alreadyInTrip: boolean;
}

export interface PlaceKeepListResponse {
  keeps: PlaceKeepDto[];
}

export interface PlaceKeepResponse {
  keep: PlaceKeepDto;
}

export interface KeepTripPlaceInput {
  note?: string | null;
}

function invalid(): never {
  throw new Error("Invalid place keep response");
}

function text(value: unknown) {
  return typeof value === "string" ? value : invalid();
}

function nullableText(value: unknown) {
  return value === null || typeof value === "string" ? value : invalid();
}

function placeKeep(value: unknown): PlaceKeepDto {
  const row = isRecord(value) ? value : invalid();
  if (row.provider !== "google" && row.provider !== "manual") return invalid();
  if (!isPlaceType(row.type)) return invalid();
  if (typeof row.own !== "boolean" || typeof row.alreadyInTrip !== "boolean") return invalid();
  const { latitude, longitude } = row;
  if ((latitude !== null && typeof latitude !== "number") || (longitude !== null && typeof longitude !== "number")) {
    return invalid();
  }
  let fromTrip: PlaceKeepDto["fromTrip"] = null;
  if (row.fromTrip !== null) {
    const trip = isRecord(row.fromTrip) ? row.fromTrip : invalid();
    const startDate = text(trip.startDate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return invalid();
    fromTrip = { name: text(trip.name), startDate };
  }
  return {
    id: text(row.id),
    placeIdentityId: text(row.placeIdentityId),
    provider: row.provider,
    providerPlaceId: nullableText(row.providerPlaceId),
    name: text(row.name),
    type: row.type,
    address: nullableText(row.address),
    latitude,
    longitude,
    timeZone: nullableText(row.timeZone),
    note: nullableText(row.note),
    keeperDisplayName: nullableText(row.keeperDisplayName),
    own: row.own,
    fromTrip,
    createdAt: text(row.createdAt),
    alreadyInTrip: row.alreadyInTrip,
  };
}

export function parsePlaceKeepListResponse(value: unknown): PlaceKeepListResponse {
  const row = isRecord(value) ? value : invalid();
  return { keeps: Array.isArray(row.keeps) ? row.keeps.map(placeKeep) : invalid() };
}

export function parsePlaceKeepResponse(value: unknown): PlaceKeepResponse {
  const row = isRecord(value) ? value : invalid();
  return { keep: placeKeep(row.keep) };
}
