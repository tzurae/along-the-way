import { isRecord } from "./type-guards";

export type DayRouteLegMode = "walking" | "transit";

export interface DayRouteStopDto {
  tripPlaceId: string;
  name: string;
}

export interface DayRouteLodgingDto {
  placeId: string;
  name: string;
}

export interface DayRouteLegDto {
  fromName: string;
  toName: string;
  /** Suggested way to travel; null when neither walking nor transit is known. */
  mode: DayRouteLegMode | null;
  durationMinutes: number | null;
  walkingMinutes: number | null;
  transitMinutes: number | null;
  /** Transit duration is an average, not a timetable. */
  estimated: boolean;
  attribution: string | null;
  unavailableReason: string | null;
}

export interface DayRoutePlanDto {
  dayId: string;
  date: string;
  /** Lodging for that night; the route starts and ends there when known. */
  lodging: DayRouteLodgingDto | null;
  stops: DayRouteStopDto[];
  legs: DayRouteLegDto[];
  totalMinutes: number;
  unknownLegs: number;
  /** Planned places without coordinates, which cannot be ordered. */
  unplaceable: DayRouteStopDto[];
}

export interface DayRoutePlanResponse {
  plan: DayRoutePlanDto;
}

export interface ApplyDayPlaceOrderInput {
  orderedTripPlaceIds: string[];
}

function invalid(): never {
  throw new Error("Invalid day route response");
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

function stop(value: unknown): DayRouteStopDto {
  const row = record(value);
  return { tripPlaceId: text(row.tripPlaceId), name: text(row.name) };
}

function leg(value: unknown): DayRouteLegDto {
  const row = record(value);
  const mode = row.mode === null || row.mode === "walking" || row.mode === "transit" ? row.mode : invalid();
  return {
    fromName: text(row.fromName),
    toName: text(row.toName),
    mode,
    durationMinutes: nullableInteger(row.durationMinutes),
    walkingMinutes: nullableInteger(row.walkingMinutes),
    transitMinutes: nullableInteger(row.transitMinutes),
    estimated: typeof row.estimated === "boolean" ? row.estimated : invalid(),
    attribution: nullableText(row.attribution),
    unavailableReason: nullableText(row.unavailableReason),
  };
}

export function parseDayRoutePlanResponse(value: unknown): DayRoutePlanResponse {
  const row = record(record(value).plan);
  const lodging = row.lodging === null
    ? null
    : (() => {
        const item = record(row.lodging);
        return { placeId: text(item.placeId), name: text(item.name) };
      })();
  return {
    plan: {
      dayId: text(row.dayId),
      date: text(row.date),
      lodging,
      stops: Array.isArray(row.stops) ? row.stops.map(stop) : invalid(),
      legs: Array.isArray(row.legs) ? row.legs.map(leg) : invalid(),
      totalMinutes: integer(row.totalMinutes),
      unknownLegs: integer(row.unknownLegs),
      unplaceable: Array.isArray(row.unplaceable) ? row.unplaceable.map(stop) : invalid(),
    },
  };
}
