import { isRecord } from "./type-guards";

/** `current` the day's saved order, `suggested` the shortest straight-line order, `custom` one a member arranged. */
export type DayRouteOrder = "current" | "suggested" | "custom";

/** Same bound as the arrangement writer, so an existing large day remains reorderable. */
export const MAX_DAY_ROUTE_STOPS = 100;

export interface CreateDayRouteInput {
  order: DayRouteOrder;
  /** Only with `custom`: this day's places in the wanted order, each once. Omitting one previews taking it off the day. */
  orderedTripPlaceIds?: string[];
}

/** A lodging the route starts or ends at. */
export interface DayRouteLodgingDto {
  placeId: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  /** Google place ID when known, so a Maps link names the place instead of showing coordinates. */
  providerPlaceId: string | null;
}

export interface DayRouteStopDto {
  tripPlaceId: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  /** Google place ID when known, so a Maps link names the place instead of showing coordinates. */
  providerPlaceId: string | null;
  /** Straight-line metres (rounded integer) from the previous point (startsAt lodging, else previous stop); null when either point lacks coordinates or there is no previous point. */
  metersFromPrevious: number | null;
}

export interface DayRouteDto {
  dayId: string;
  date: string;
  /** trip_days version; the expectedVersion for PUT place-order / arrangement. */
  version: number;
  order: DayRouteOrder;
  /** Every planned place in route order; located places first (ordered), places without coordinates appended in their saved order. Saving stores exactly this. */
  orderedTripPlaceIds: string[];
  /** The morning's lodging, where the day starts; null when none. */
  startsAt: DayRouteLodgingDto | null;
  /** That night's lodging, where the day ends; null when none. */
  endsAt: DayRouteLodgingDto | null;
  stops: DayRouteStopDto[];
  /** Straight-line metres from the last stop to endsAt; null when unknown or no endsAt. */
  metersToEnd: number | null;
  /** Sum of all non-null legs including metersToEnd. */
  totalMeters: number;
}

export interface DayRouteResponse {
  route: DayRouteDto;
}

function invalid(): never {
  throw new Error("Invalid day route response");
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : invalid();
}

function text(value: unknown): string {
  return typeof value === "string" ? value : invalid();
}

function integer(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : invalid();
}

function nullableInteger(value: unknown): number | null {
  return value === null ? null : integer(value);
}

function nullableNumber(value: unknown): number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value)) ? value : invalid();
}

function nullableText(value: unknown): string | null {
  return value === null ? null : text(value);
}

function point(value: unknown): DayRouteLodgingDto | null {
  if (value === null) return null;
  const entry = record(value);
  return {
    placeId: text(entry.placeId),
    name: text(entry.name),
    latitude: nullableNumber(entry.latitude),
    longitude: nullableNumber(entry.longitude),
    providerPlaceId: nullableText(entry.providerPlaceId),
  };
}

function stop(value: unknown): DayRouteStopDto {
  const entry = record(value);
  return {
    tripPlaceId: text(entry.tripPlaceId),
    name: text(entry.name),
    latitude: nullableNumber(entry.latitude),
    longitude: nullableNumber(entry.longitude),
    providerPlaceId: nullableText(entry.providerPlaceId),
    metersFromPrevious: nullableInteger(entry.metersFromPrevious),
  };
}

function order(value: unknown): DayRouteOrder {
  return value === "current" || value === "suggested" || value === "custom" ? value : invalid();
}

function route(value: unknown): DayRouteDto {
  const entry = record(value);
  return {
    dayId: text(entry.dayId),
    date: text(entry.date),
    version: integer(entry.version),
    order: order(entry.order),
    orderedTripPlaceIds: Array.isArray(entry.orderedTripPlaceIds)
      ? entry.orderedTripPlaceIds.map(text)
      : invalid(),
    startsAt: point(entry.startsAt),
    endsAt: point(entry.endsAt),
    stops: Array.isArray(entry.stops) ? entry.stops.map(stop) : invalid(),
    metersToEnd: nullableInteger(entry.metersToEnd),
    totalMeters: integer(entry.totalMeters),
  };
}

export function parseDayRouteResponse(value: unknown): DayRouteResponse {
  return { route: route(record(value).route) };
}
