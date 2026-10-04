import type { ItineraryItemType } from "./trip-skeleton";
import { isRecord } from "./type-guards";

export type DayLegMode = "walking" | "transit";

export interface DayLegDto {
  fromName: string;
  toName: string;
  /** Suggested way to travel; null when neither walking nor transit is known. */
  mode: DayLegMode | null;
  durationMinutes: number | null;
  walkingMinutes: number | null;
  transitMinutes: number | null;
  /** Transit duration is an average, not a timetable. */
  estimated: boolean;
  attribution: string | null;
  unavailableReason: string | null;
}

/** The part of a day that may be planned, in minutes from local midnight. */
export interface DayWindowDto {
  startMinute: number;
  endMinute: number;
}

export type DayTimetableOrder = "current" | "suggested";

export interface CreateDayTimetableInput {
  /** `current` keeps the day's order; `suggested` orders closest places first. */
  order: DayTimetableOrder;
}

export interface ApplyDayPlaceOrderInput {
  orderedTripPlaceIds: string[];
}

export type UpdateDayWindowInput = DayWindowDto;

/** Times are minutes from local midnight of the day. */
export type DayTimetableRowDto =
  | { kind: "start"; name: string; departMinute: number }
  | {
      kind: "visit";
      tripPlaceId: string;
      name: string;
      travel: DayLegDto | null;
      arriveMinute: number;
      /** Minutes spent waiting for the place to open. */
      waitMinutes: number;
      startMinute: number;
      endMinute: number;
      stayMinutes: number;
      /** The stay is a default for the place type, not a value someone entered. */
      stayEstimated: boolean;
      /** `listed`: checked against Google opening hours, which never include last entry. */
      hours: "listed" | "unknown";
    }
  | {
      kind: "fixed";
      itemId: string;
      title: string;
      itemType: ItineraryItemType;
      travel: DayLegDto | null;
      startMinute: number;
      endMinute: number;
      startsBeforeDay: boolean;
      endsAfterDay: boolean;
      /** Confirmed minimum time to arrive before the item starts. */
      bufferMinutes: number;
    }
  | { kind: "return"; name: string; travel: DayLegDto; arriveMinute: number };

export type UnscheduledReason =
  | "closed_that_day"
  | "temporarily_closed"
  | "permanently_closed"
  | "closes_too_early"
  | "not_enough_time"
  | "travel_unknown"
  | "no_location"
  | "cannot_return_to_lodging";

export interface UnscheduledPlaceDto {
  tripPlaceId: string;
  name: string;
  reason: UnscheduledReason;
}

export type DayLoadLevel = "relaxed" | "balanced" | "packed";

export interface DayLoadDto {
  /** Stays, fixed items, and travel inside the window. */
  busyMinutes: number;
  windowMinutes: number;
  level: DayLoadLevel;
}

/** A draft computed on request; it is never stored and never changes the itinerary. */
export interface DayTimetableDto {
  dayId: string;
  date: string;
  window: DayWindowDto;
  order: DayTimetableOrder;
  /** Located places in the order tried; saving the order stores exactly this. */
  orderedTripPlaceIds: string[];
  lodging: { placeId: string; name: string } | null;
  rows: DayTimetableRowDto[];
  unscheduled: UnscheduledPlaceDto[];
  load: DayLoadDto;
}

export interface DayTimetableResponse {
  timetable: DayTimetableDto;
}

export interface DayWindowResponse {
  window: DayWindowDto;
}

function invalid(): never {
  throw new Error("Invalid day plan response");
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
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : invalid();
}

function nullableInteger(value: unknown) {
  return value === null ? null : integer(value);
}

function bool(value: unknown) {
  return typeof value === "boolean" ? value : invalid();
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  return allowed.includes(value as T) ? value as T : invalid();
}

function list<T>(value: unknown, parse: (entry: unknown) => T) {
  return Array.isArray(value) ? value.map(parse) : invalid();
}

const ITEM_TYPES = ["flight", "lodging", "transport", "reservation", "meal", "activity", "free-time"] as const;
const REASONS = [
  "closed_that_day",
  "temporarily_closed",
  "permanently_closed",
  "closes_too_early",
  "not_enough_time",
  "travel_unknown",
  "no_location",
  "cannot_return_to_lodging",
] as const;

function leg(value: unknown): DayLegDto {
  const row = record(value);
  return {
    fromName: text(row.fromName),
    toName: text(row.toName),
    mode: row.mode === null ? null : oneOf(row.mode, ["walking", "transit"] as const),
    durationMinutes: nullableInteger(row.durationMinutes),
    walkingMinutes: nullableInteger(row.walkingMinutes),
    transitMinutes: nullableInteger(row.transitMinutes),
    estimated: bool(row.estimated),
    attribution: nullableText(row.attribution),
    unavailableReason: nullableText(row.unavailableReason),
  };
}

function nullableLeg(value: unknown) {
  return value === null ? null : leg(value);
}

function window(value: unknown): DayWindowDto {
  const row = record(value);
  return { startMinute: integer(row.startMinute), endMinute: integer(row.endMinute) };
}

function timetableRow(value: unknown): DayTimetableRowDto {
  const row = record(value);
  switch (row.kind) {
    case "start":
      return { kind: "start", name: text(row.name), departMinute: integer(row.departMinute) };
    case "visit":
      return {
        kind: "visit",
        tripPlaceId: text(row.tripPlaceId),
        name: text(row.name),
        travel: nullableLeg(row.travel),
        arriveMinute: integer(row.arriveMinute),
        waitMinutes: integer(row.waitMinutes),
        startMinute: integer(row.startMinute),
        endMinute: integer(row.endMinute),
        stayMinutes: integer(row.stayMinutes),
        stayEstimated: bool(row.stayEstimated),
        hours: oneOf(row.hours, ["listed", "unknown"] as const),
      };
    case "fixed":
      return {
        kind: "fixed",
        itemId: text(row.itemId),
        title: text(row.title),
        itemType: oneOf(row.itemType, ITEM_TYPES),
        travel: nullableLeg(row.travel),
        startMinute: integer(row.startMinute),
        endMinute: integer(row.endMinute),
        startsBeforeDay: bool(row.startsBeforeDay),
        endsAfterDay: bool(row.endsAfterDay),
        bufferMinutes: integer(row.bufferMinutes),
      };
    case "return":
      return {
        kind: "return",
        name: text(row.name),
        travel: leg(row.travel),
        arriveMinute: integer(row.arriveMinute),
      };
    default:
      return invalid();
  }
}

export function parseDayTimetableResponse(value: unknown): DayTimetableResponse {
  const row = record(record(value).timetable);
  const lodging = row.lodging === null
    ? null
    : (() => {
        const item = record(row.lodging);
        return { placeId: text(item.placeId), name: text(item.name) };
      })();
  const load = record(row.load);
  return {
    timetable: {
      dayId: text(row.dayId),
      date: text(row.date),
      window: window(row.window),
      order: oneOf(row.order, ["current", "suggested"] as const),
      orderedTripPlaceIds: list(row.orderedTripPlaceIds, text),
      lodging,
      rows: list(row.rows, timetableRow),
      unscheduled: list(row.unscheduled, (entry) => {
        const place = record(entry);
        return {
          tripPlaceId: text(place.tripPlaceId),
          name: text(place.name),
          reason: oneOf(place.reason, REASONS),
        };
      }),
      load: {
        busyMinutes: integer(load.busyMinutes),
        windowMinutes: integer(load.windowMinutes),
        level: oneOf(load.level, ["relaxed", "balanced", "packed"] as const),
      },
    },
  };
}

export function parseDayWindowResponse(value: unknown): DayWindowResponse {
  return { window: window(record(value).window) };
}
