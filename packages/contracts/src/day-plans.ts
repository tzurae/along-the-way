import type { ItineraryItemType, PlaceType } from "./trip-skeleton";
import { isRecord } from "./type-guards";

/** Stay used when nobody entered one, by place type; the scheduler and the client's estimates share it. */
export const DEFAULT_STAY_MINUTES: Record<PlaceType, number> = {
  activity: 90,
  worship: 60,
  museum: 90,
  nature: 75,
  restaurant: 75,
  cafe: 45,
  shopping: 60,
  other: 60,
  lodging: 60,
  station: 30,
  airport: 30,
};

/** A place's stay: what someone entered, else the default for its type. */
export function stayMinutesFor(place: { type: PlaceType; durationMinutes: number | null }) {
  return place.durationMinutes ?? DEFAULT_STAY_MINUTES[place.type];
}

/**
 * A day's list after taking `removedId` out. Placed stops keep their order and the ones the day
 * could not hold move after them, so a stop that the freed time now lets in can only use time
 * after every placed one: taking a place out never pushes another out.
 */
export function orderWithout(orderedIds: readonly string[], removedId: string, placedIds: readonly string[]) {
  const placed = new Set(placedIds);
  const rest = orderedIds.filter((id) => id !== removedId);
  return [...rest.filter((id) => placed.has(id)), ...rest.filter((id) => !placed.has(id))];
}

/**
 * What dropping a place into a day comes to. It fits when it is placed and every place placed
 * before still is; else taxi, when the server found a taxi choice that fits; else a swap, when
 * it is placed only by pushing others out; else it does not fit and nothing changes.
 */
export type AddOutcome<Taxi> =
  | { kind: "fits" }
  | { kind: "taxi"; taxi: Taxi }
  | { kind: "swap"; pushed: string[] }
  | { kind: "nofit" };

export function addOutcome<Taxi>(
  placedBefore: readonly string[],
  placedAfter: readonly string[],
  placeId: string,
  taxi: Taxi | null,
): AddOutcome<Taxi> {
  const after = new Set(placedAfter);
  const pushed = placedBefore.filter((id) => !after.has(id));
  if (after.has(placeId) && pushed.length === 0) return { kind: "fits" };
  if (taxi !== null) return { kind: "taxi", taxi };
  return after.has(placeId) ? { kind: "swap", pushed } : { kind: "nofit" };
}

/** How a leg was travelled. */
export type DayLegMode = "walking" | "transit" | "taxi";

/** How members choose to travel: a day's default, or one leg's. */
export type TravelMode = "transit" | "taxi" | "walk";
export const TRAVEL_MODES: readonly TravelMode[] = ["transit", "taxi", "walk"];
/** Minutes added to a taxi ride for waiting and getting in and out. */
export const TAXI_BUFFER_MINUTES = 5;

export interface DayLegDto {
  fromName: string;
  toName: string;
  /** Way travelled; null when the chosen way's time is unknown. */
  mode: DayLegMode | null;
  /** Includes the taxi buffer for a taxi leg. */
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

export interface SavedDayWindowDto extends DayWindowDto {
  version: number;
  /** How the day's legs are travelled unless a leg says otherwise. */
  travelMode: TravelMode;
  /** Longest walk taken instead of transit (or a taxi), in minutes. */
  walkLimitMinutes: number;
}

/** `current` the day's saved order, `suggested` the shortest straight-line order, `custom` one a member arranged. */
export type DayTimetableOrder = "current" | "suggested" | "custom";

export interface CreateDayTimetableInput {
  /** `current` keeps the day's order; `suggested` orders closest places first; `custom` uses `orderedTripPlaceIds`. */
  order: DayTimetableOrder;
  /** Only with `custom`: every located place planned on the day, each once. */
  orderedTripPlaceIds?: string[];
  /** Only with `custom`: a place to add; the server tries it in every slot and returns the best fit. */
  insertTripPlaceId?: string;
  /** Only with `custom`: how to reach a place, by trip place id; missing ones follow the day. */
  legModes?: Record<string, TravelMode>;
  /**
   * Only with `custom`: a place just dropped into the list. When it does not fit (or pushes a
   * placed one out), the server also tries taxi for the legs into and out of it.
   */
  taxiFallbackFor?: string;
}

export interface ApplyDayPlaceOrderInput {
  expectedVersion: number;
  orderedTripPlaceIds: string[];
}

export interface UpdateDayWindowInput extends DayWindowDto {
  expectedVersion: number;
  /** Omitted keeps the day's current value. */
  travelMode?: TravelMode;
  walkLimitMinutes?: number;
}

export interface DayPlaceOrderResponse {
  orderedTripPlaceIds: string[];
  version: number;
}

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
      /**
       * `listed`: checked against Google opening hours, which never include last entry.
       * Otherwise why hours were not checked: `none` Google has no hours for the place,
       * `failed` the lookup failed (drafting again may succeed), `manual` not a Google place.
       */
      hours: "listed" | "none" | "failed" | "manual";
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
      /** Minutes to be there before the item starts. */
      bufferMinutes: number;
      /** The buffer is a default (for flights), not one a member confirmed. */
      bufferEstimated: boolean;
      /** Default minutes after the item ends before anything else, such as entry and luggage after landing. */
      afterBufferMinutes: number;
    }
  | {
      kind: "luggage";
      /** `drop` at the new lodging on a moving day; `collect` at the morning's lodging on the last day. */
      action: "drop" | "collect";
      name: string;
      travel: DayLegDto | null;
      /** Null when the travel there is unknown. */
      arriveMinute: number | null;
      leaveMinute: number | null;
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

/**
 * Why the day has the room it has, straight from the scheduler: places are only ever tried in
 * `gaps`, so these facts explain every `not_enough_time` without the client re-deriving rules.
 */
export interface DayCapacityDto {
  /** The fixed item that brings the traveller in (e.g. the outbound flight); nothing is placed before it ends plus its after-buffer. */
  arrival: { title: string; endMinute: number; afterBufferMinutes: number } | null;
  /** The last day's departure; nothing is placed once the traveller leaves for it. */
  departure: { title: string; startMinute: number } | null;
  /** Free time places may use, in order, before any place is put in; empty when there is none. */
  gaps: { startMinute: number; endMinute: number }[];
}

/** A draft computed on request; it is never stored and never changes the itinerary. */
export interface DayTimetableDto {
  dayId: string;
  date: string;
  window: SavedDayWindowDto;
  order: DayTimetableOrder;
  /** Located places in the order tried; saving the order stores exactly this. */
  orderedTripPlaceIds: string[];
  /** The morning's lodging, where the day starts; null starts at the first place or the arrival. */
  startsAt: { placeId: string; name: string } | null;
  /** That night's lodging, where the day ends; null when there is none. */
  endsAt: { placeId: string; name: string } | null;
  rows: DayTimetableRowDto[];
  unscheduled: UnscheduledPlaceDto[];
  load: DayLoadDto;
  capacity: DayCapacityDto;
  /** Legs the draft travels differently from the day, keyed by the place they reach. */
  legModes: Record<string, TravelMode>;
  /** With `taxiFallbackFor`: the same list with taxi for the place's legs, when that fits and this does not. */
  taxiAlternative: { legModes: Record<string, TravelMode>; timetable: DayTimetableDto } | null;
}

export interface DayTimetableResponse {
  timetable: DayTimetableDto;
}

export interface DayWindowResponse {
  window: SavedDayWindowDto;
}

/** Why a wishlist place is not in a trip plan. */
export type TripPlanReason = UnscheduledReason | "closed_all_trip_days" | "no_day_fits";

export interface TripPlanUnplacedDto {
  tripPlaceId: string;
  name: string;
  reason: TripPlanReason;
  /** The day whose timetable could not fit the place; null when no day was chosen. */
  date: string | null;
}

export interface TripPlanDayDto {
  /** The day with its new places after the existing ones; `unscheduled` lists existing places only. */
  timetable: DayTimetableDto;
  addedTripPlaceIds: string[];
  /** Every place on the day once the plan is used, in order: existing ones, then new ones. */
  orderedTripPlaceIds: string[];
}

/** A draft that adds unplanned wishlist places to days; never stored. */
export interface TripPlanDto {
  /** Fingerprint of the data the plan used; using the plan fails once that data changes. */
  basis: string;
  /** Days that receive at least one place. */
  days: TripPlanDayDto[];
  unplaced: TripPlanUnplacedDto[];
}

export interface TripPlanResponse {
  plan: TripPlanDto;
}

export interface ApplyTripPlanInput {
  basis: string;
  days: Array<{ tripDayId: string; orderedTripPlaceIds: string[]; expectedVersion: number }>;
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
    mode: row.mode === null ? null : oneOf(row.mode, ["walking", "transit", "taxi"] as const),
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

function window(value: unknown): SavedDayWindowDto {
  const row = record(value);
  return {
    startMinute: integer(row.startMinute),
    endMinute: integer(row.endMinute),
    version: integer(row.version),
    travelMode: oneOf(row.travelMode, TRAVEL_MODES),
    walkLimitMinutes: integer(row.walkLimitMinutes),
  };
}

function legModes(value: unknown): Record<string, TravelMode> {
  const row = record(value);
  return Object.fromEntries(Object.entries(row).map(([id, mode]) => [id, oneOf(mode, TRAVEL_MODES)]));
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
        hours: oneOf(row.hours, ["listed", "none", "failed", "manual"] as const),
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
        bufferEstimated: bool(row.bufferEstimated),
        afterBufferMinutes: integer(row.afterBufferMinutes),
      };
    case "luggage":
      return {
        kind: "luggage",
        action: oneOf(row.action, ["drop", "collect"] as const),
        name: text(row.name),
        travel: nullableLeg(row.travel),
        arriveMinute: nullableInteger(row.arriveMinute),
        leaveMinute: nullableInteger(row.leaveMinute),
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

function placeRef(value: unknown) {
  if (value === null) return null;
  const item = record(value);
  return { placeId: text(item.placeId), name: text(item.name) };
}

function timetable(value: unknown): DayTimetableDto {
  const row = record(value);
  const load = record(row.load);
  return {
    dayId: text(row.dayId),
    date: text(row.date),
    window: window(row.window),
    order: oneOf(row.order, ["current", "suggested", "custom"] as const),
    orderedTripPlaceIds: list(row.orderedTripPlaceIds, text),
    startsAt: placeRef(row.startsAt),
    endsAt: placeRef(row.endsAt),
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
    capacity: capacity(record(row.capacity)),
    legModes: legModes(row.legModes ?? {}),
    taxiAlternative: row.taxiAlternative == null ? null : {
      legModes: legModes(record(row.taxiAlternative).legModes),
      timetable: timetable(record(row.taxiAlternative).timetable),
    },
  };
}

function capacity(value: Record<string, unknown>): DayCapacityDto {
  const arrival = value.arrival === null ? null : record(value.arrival);
  const departure = value.departure === null ? null : record(value.departure);
  return {
    arrival: arrival
      ? { title: text(arrival.title), endMinute: integer(arrival.endMinute), afterBufferMinutes: integer(arrival.afterBufferMinutes) }
      : null,
    departure: departure ? { title: text(departure.title), startMinute: integer(departure.startMinute) } : null,
    gaps: list(value.gaps, (entry) => {
      const gap = record(entry);
      return { startMinute: integer(gap.startMinute), endMinute: integer(gap.endMinute) };
    }),
  };
}

export function parseDayTimetableResponse(value: unknown): DayTimetableResponse {
  return { timetable: timetable(record(value).timetable) };
}

export function parseTripPlanResponse(value: unknown): TripPlanResponse {
  const row = record(record(value).plan);
  return {
    plan: {
      basis: text(row.basis),
      days: list(row.days, (entry) => {
        const day = record(entry);
        return {
          timetable: timetable(day.timetable),
          addedTripPlaceIds: list(day.addedTripPlaceIds, text),
          orderedTripPlaceIds: list(day.orderedTripPlaceIds, text),
        };
      }),
      unplaced: list(row.unplaced, (entry) => {
        const place = record(entry);
        return {
          tripPlaceId: text(place.tripPlaceId),
          name: text(place.name),
          reason: oneOf(place.reason, [...REASONS, "closed_all_trip_days", "no_day_fits"] as const),
          date: nullableText(place.date),
        };
      }),
    },
  };
}

export function parseDayWindowResponse(value: unknown): DayWindowResponse {
  return { window: window(record(value).window) };
}
