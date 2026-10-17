import { Temporal } from "@js-temporal/polyfill";
import { lodgingForNight, resolveDayTimeZone } from "@along-the-way/contracts/day-time-zone";
import type {
  ApplyDayPlaceOrderInput,
  CreateDayTimetableInput,
  DayLegDto,
  DayTimetableDto,
  DayTimetableOrder,
  SavedDayWindowDto,
  DayPlaceOrderResponse,
  TripPlanDayDto,
  TripPlanDto,
  TripPlanUnplacedDto,
  UpdateDayWindowInput,
  TravelMode,
} from "@along-the-way/contracts/day-plans";
import { MAX_DAY_TIMETABLE_STOPS, TRAVEL_MODES } from "@along-the-way/contracts/day-plans";
import type { RouteObservationProvider } from "@along-the-way/contracts/planning-observations";
import type { TripPlaceDto } from "@along-the-way/contracts/trip-places";
import type { ItineraryItemDto, TimelineDayDto, TripSkeletonDto } from "@along-the-way/contracts/trip-skeleton";
import type { Kysely, Transaction } from "kysely";

import type { AlongTheWayDatabase } from "../database/database";
import { AppError } from "../private-trips/private-trip-module";
import {
  lockMutation,
  recordEvent,
  remember,
  replayed,
  requireIdempotencyKey,
  requireDayVersion,
  requireScheduler,
} from "../private-trips/postgres-private-trip-store";
import type { TripPlaceModule } from "../trip-places/trip-place-module";
import type { TripSkeletonModule } from "../trip-skeleton/trip-skeleton-module";
import { orderByStraightLine, straightLineMeters, type GeoPoint } from "./day-route-order";
import { stayMinutesFor } from "@along-the-way/contracts/day-plans";
import {
  dayLoadLevel,
  scheduleDay,
  type TimetableBlock,
  type TimetableResult,
  type TimetableStop,
} from "./day-timetable";
import { hoursOn, type LookedUpHours, type PlaceHoursLookup } from "./opening-hours";
import { distributePlaces } from "./trip-distribution";
import { tripPlanBasis } from "./trip-plan-basis";
import { legFor, routeModesFor, taxiAlternative, walkLimitFor } from "./travel-modes";
import { ProviderQuotaError } from "../trip-places/google-places-provider";

/** A lookup that failed (or a place that never had one): hours unknown, worth retrying. */
const FAILED_LOOKUP: LookedUpHours = { missing: "failed" };
const QUOTA_LOOKUP: LookedUpHours = { missing: "quota" };

const DAY_MINUTES = 24 * 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface DayPlanModule {
  /** A draft timetable for the day; computed on request, never stored. */
  timetable(
    userId: string,
    tripId: string,
    dayId: string,
    input: CreateDayTimetableInput,
    reservePlanningWork?: (cost: number) => Promise<void>,
  ): Promise<DayTimetableDto>;
  /** A draft adding the wishlist places not yet on any day to days; computed on request, never stored. */
  tripPlan(userId: string, tripId: string, reservePlanningWork?: (cost: number) => Promise<void>): Promise<TripPlanDto>;
  getWindow(userId: string, tripId: string, dayId: string): Promise<SavedDayWindowDto>;
  applyOrder(
    userId: string,
    tripId: string,
    dayId: string,
    idempotencyKey: string,
    input: ApplyDayPlaceOrderInput,
  ): Promise<DayPlaceOrderResponse>;
  updateWindow(
    userId: string,
    tripId: string,
    dayId: string,
    idempotencyKey: string,
    input: UpdateDayWindowInput,
  ): Promise<SavedDayWindowDto>;
}

interface ModuleOptions {
  database: Kysely<AlongTheWayDatabase>;
  tripSkeleton: TripSkeletonModule;
  tripPlaces: TripPlaceModule;
  /** Consulted in order; the first available observation per mode wins. */
  routeProviders: RouteObservationProvider[];
  placeHours: PlaceHoursLookup;
  now?: () => Date;
}

interface RoutePoint extends GeoPoint {
  name: string;
  timeZone: string | null;
}

interface PlannedStop extends RoutePoint {
  place: TripPlaceDto;
}

/** Everything about a day that does not depend on which places are drafted into it. */
interface DayContext {
  day: TimelineDayDto;
  window: SavedDayWindowDto;
  /** The lodging slept in the night before; null on the first day or when none is known. */
  morning: RoutePoint | null;
  /** The lodging slept in that night. */
  night: RoutePoint | null;
  /** Where the day starts: the morning's lodging, or that night's when nobody is arriving. */
  start: RoutePoint | null;
  /** Without a morning lodging, the flight or transport that brings the traveller in. */
  arrivalItemId: string | null;
  /** Moving to a new lodging: luggage is left there after this flight or transport, or first thing. */
  dropLuggage: { afterItemId: string | null } | null;
  /** The last day: luggage is collected at the morning's lodging before this flight or transport. */
  collectLuggageBeforeItemId: string | null;
  timeZone: string;
  /** The current date where the day is, for choosing dated opening hours. */
  today: string;
  blocks: TimetableBlock[];
  /** Map points of the fixed items, by place ID. */
  points: Map<string, RoutePoint>;
}

/** Default time at the airport before a flight unless a member confirmed a buffer. */
const FLIGHT_CHECK_IN_MINUTES = 120;
/** Default time after landing for entry and luggage. */
const FLIGHT_ARRIVAL_MINUTES = 60;
/** A move ending this close to where the next one starts takes the traveller to it. */
const FEEDER_METERS = 2_000;

function isMove(block: TimetableBlock) {
  return block.itemType === "flight" || block.itemType === "transport";
}

function located(value: { latitude: number | null; longitude: number | null }) {
  return value.latitude !== null && value.longitude !== null;
}

/** A member's arranged day: located places on the day or on no day yet, each at most once. */
function customOrder(ids: string[] | undefined, pool: Map<string, TripPlaceDto>) {
  const ordered = (ids ?? []).map((id) => id.toLowerCase());
  if (new Set(ordered).size !== ordered.length || ordered.some((id) => !pool.has(id))) {
    throw new AppError("validation_error", "orderedTripPlaceIds must list located places on this day or on no day, each once");
  }
  return ordered;
}

/** A member's per-leg choices, kept only for places in the draft and known ways to travel. */
function validLegModes(value: Record<string, TravelMode> | undefined, stops: Map<string, PlannedStop>) {
  return Object.fromEntries(Object.entries(value ?? {}).flatMap(([id, mode]) => {
    const key = id.toLowerCase();
    return stops.has(key) && TRAVEL_MODES.includes(mode) ? [[key, mode] as const] : [];
  })) as Record<string, TravelMode>;
}

function savedWindow(row: { day_start_minute: number; day_end_minute: number; version: number; travel_mode: TravelMode; walk_limit_minutes: number }): SavedDayWindowDto {
  return {
    startMinute: row.day_start_minute,
    endMinute: row.day_end_minute,
    version: row.version,
    travelMode: row.travel_mode,
    walkLimitMinutes: row.walk_limit_minutes,
  };
}


/**
 * Every writer of day places, order or hours takes the trip row first, so they queue in one
 * order instead of deadlocking with "Use this plan" (which holds the trip, then the days).
 */
async function lockTrip(transaction: Transaction<AlongTheWayDatabase>, tripId: string) {
  await transaction.selectFrom("trips").select("id").where("id", "=", tripId).forUpdate().execute();
}

function plannedStop(place: TripPlaceDto): PlannedStop {
  return {
    id: place.id,
    name: place.name,
    latitude: place.latitude!,
    longitude: place.longitude!,
    timeZone: place.timeZone,
    place,
  };
}

function stayMinutes(place: TripPlaceDto) {
  return stayMinutesFor(place);
}

/**
 * Minutes of the day's hours it cannot use for places, overlaps counted once: fixed items with
 * their buffers, the time before an arrival, and the time after leaving for a departure.
 */
function unusableMinutes(context: DayContext) {
  const { window, blocks } = context;
  const intervals: Array<[number, number]> = blocks.map((block) =>
    [block.startMinute - block.bufferMinutes, block.endMinute + block.afterBufferMinutes]);
  const arrival = blocks.find((block) => block.itemId === context.arrivalItemId);
  if (arrival) intervals.push([window.startMinute, arrival.endMinute + arrival.afterBufferMinutes]);
  const departure = blocks.find((block) => block.itemId === context.collectLuggageBeforeItemId);
  if (departure) intervals.push([departure.startMinute - departure.bufferMinutes, window.endMinute]);
  let total = 0;
  let countedUntil = window.startMinute;
  for (const [start, end] of intervals.sort((left, right) => left[0] - right[0])) {
    const clippedEnd = Math.min(end, window.endMinute);
    total += Math.max(0, clippedEnd - Math.max(start, countedUntil));
    countedUntil = Math.max(countedUntil, clippedEnd);
  }
  return total;
}

/** Applied order first; places without one keep their list order after them. */
function byDayPosition(left: TripPlaceDto, right: TripPlaceDto) {
  if (left.dayPosition === right.dayPosition) return 0;
  if (left.dayPosition === null) return 1;
  if (right.dayPosition === null) return -1;
  return left.dayPosition - right.dayPosition;
}

function windowMinute(value: unknown, field: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > DAY_MINUTES) {
    throw new AppError("validation_error", `${field} must be a whole minute of the day`);
  }
  return value as number;
}

function endpoint(item: ItineraryItemDto, role: "start" | "end") {
  return item.endpoints.find((entry) => entry.role === role) ?? null;
}

/** Item length when it has no end endpoint. */
function plannedMinutes(item: ItineraryItemDto) {
  return "durationMinutes" in item.details ? item.details.durationMinutes : 0;
}

export class PostgresDayPlanModule implements DayPlanModule {
  private readonly database: Kysely<AlongTheWayDatabase>;
  private readonly tripSkeleton: TripSkeletonModule;
  private readonly tripPlaces: TripPlaceModule;
  private readonly routeProviders: RouteObservationProvider[];
  private readonly placeHours: PlaceHoursLookup;
  private readonly now: () => Date;

  constructor(options: ModuleOptions) {
    this.database = options.database;
    this.tripSkeleton = options.tripSkeleton;
    this.tripPlaces = options.tripPlaces;
    this.routeProviders = options.routeProviders;
    this.placeHours = options.placeHours;
    this.now = options.now ?? (() => new Date());
  }

  async timetable(
    userId: string,
    tripId: string,
    dayId: string,
    input: CreateDayTimetableInput,
    reservePlanningWork?: (cost: number) => Promise<void>,
  ): Promise<DayTimetableDto> {
    const order = input?.order;
    if (order !== "current" && order !== "suggested" && order !== "custom") {
      throw new AppError("validation_error", "order must be current, suggested or custom");
    }
    const requestedStops = (input.orderedTripPlaceIds?.length ?? 0)
      + (input.insertTripPlaceId ? 1 : 0);
    if (order === "custom" && requestedStops > MAX_DAY_TIMETABLE_STOPS) {
      throw new AppError("validation_error", `A timetable may plan at most ${MAX_DAY_TIMETABLE_STOPS} stops`);
    }
    const insertId = order === "custom" && input.insertTripPlaceId ? input.insertTripPlaceId.toLowerCase() : null;
    const { context, planned, stops, stopsById, hours, storedModes } = await this.prepareDraft(
      userId,
      tripId,
      dayId,
      order,
      insertId ? [...(input.orderedTripPlaceIds ?? []), insertId] : input.orderedTripPlaceIds,
      reservePlanningWork,
    );
    // A member's draft says how each leg is travelled; the saved order uses what was saved.
    const legModes = order === "custom" ? validLegModes(input.legModes, stopsById) : storedModes;
    const legs = new Map<string, Promise<DayLegDto>>();
    let orderedIds: string[];
    let result: TimetableResult;
    if (insertId) {
      // Adding a place: keep the slot that fits the most places, then ends earliest, then travels least.
      const { tries } = await this.everySlot(context, stops.map((stop) => stop.id).filter((id) => id !== insertId), insertId, stopsById, hours, legs, legModes);
      let best = tries[0]!;
      for (const entry of tries) {
        const [a, b] = [entry.score, best.score];
        if (a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])))) best = entry;
      }
      ({ ids: orderedIds, result } = best);
    } else {
      orderedIds = order === "suggested"
        ? orderByStraightLine(stops, context.night ?? context.start)
        : stops.map((stop) => stop.id);
      result = await this.draftDay(context, orderedIds.map((id) => stopsById.get(id)!), hours, legs, legModes);
    }
    // A place just added, at its best slot or where it was dropped: offer taxi when the day's way
    // does not fit it (only that slot is tried, to keep drive lookups to two).
    const fallbackId = insertId ?? (order === "custom" && input.taxiFallbackFor ? input.taxiFallbackFor.toLowerCase() : null);
    if (!fallbackId || !stopsById.has(fallbackId)) return this.timetableDto(context, orderedIds, result, planned, order, legModes);
    const alternative = await taxiAlternative({
      orderedIds,
      placeId: fallbackId,
      legModes,
      withPlace: result,
      draft: (ids, modes) => this.draftDay(context, ids.map((id) => stopsById.get(id)!), hours, legs, modes),
    });
    return this.timetableDto(context, orderedIds, result, planned, order, legModes, alternative && {
      legModes: alternative.legModes,
      timetable: this.timetableDto(context, orderedIds, alternative.result, planned, order, alternative.legModes),
    });
  }

  /** Drafts `insertId` in every slot of `base`; all tries share one route lookup per pair. */
  private async everySlot(
    context: DayContext,
    base: string[],
    insertId: string,
    stopsById: Map<string, PlannedStop>,
    hours: Map<string, LookedUpHours>,
    legs: Map<string, Promise<DayLegDto>>,
    legModes: Record<string, TravelMode> = {},
  ) {
    const tries: Array<{ ids: string[]; result: TimetableResult; score: [number, number, number] }> = [];
    for (let index = 0; index <= base.length; index += 1) {
      const ids = [...base.slice(0, index), insertId, ...base.slice(index)];
      const result = await this.draftDay(context, ids.map((id) => stopsById.get(id)!), hours, legs, legModes);
      const placed = result.rows.filter((row) => row.kind === "visit").length;
      const last = result.rows.at(-1);
      const end = last?.kind === "return" ? last.arriveMinute : Math.max(0, ...result.rows.flatMap((row) => (row.kind === "visit" ? [row.endMinute] : [])));
      tries.push({ ids, result, score: [-placed, end, result.load.busyMinutes] });
    }
    return { tries };
  }

  /** Reads the day once and resolves its stops: the day's places, or a member's custom list. */
  private async prepareDraft(
    userId: string,
    tripId: string,
    dayId: string,
    order: DayTimetableOrder,
    customList: string[] | undefined,
    reservePlanningWork?: (cost: number) => Promise<void>,
  ) {
    const before = await this.getWindow(userId, tripId, dayId);
    // Both reads authorize membership and resolve names, coordinates, and zones. Saved ways of
    // arrival are read before the version is checked again, so they belong to that version.
    const [skeleton, places, arrivalModes] = await Promise.all([
      this.tripSkeleton.getSkeleton(userId, tripId),
      this.tripPlaces.list(userId, tripId),
      this.arrivalModes(tripId),
    ]);
    const day = skeleton.days.find((entry) => entry.id === dayId.toLowerCase());
    if (!day) throw new AppError("trip_day_not_found", "Trip day not found", 404);
    const window = await this.getWindow(userId, tripId, dayId);
    if (window.version !== before.version) {
      throw new AppError("conflict", "The day changed while its draft was being read", 409, undefined, window.version, dayId);
    }
    const planned = this.plannedOn(places, day.id);
    // A custom order may leave out the day's places and bring in located places with no day yet.
    const pool = order === "custom"
      ? places.filter((place) => !place.scheduled && located(place) && (place.assignedDayId === day.id || place.assignedDayId === null))
      : planned.filter(located);
    const poolById = new Map(pool.map((place) => [place.id, place]));
    const stops = (order === "custom" ? customOrder(customList, poolById).map((id) => poolById.get(id)!) : pool).map(plannedStop);
    await reservePlanningWork?.(Math.min(100, Math.max(1, stops.length)));
    const context = this.dayContext(skeleton, day, window, stops, null);
    const stopsById = new Map(stops.map((stop) => [stop.id, stop]));
    const hours = await this.hoursFor(stops.map((stop) => stop.place));
    return { context, planned, stops, stopsById, hours, storedModes: arrivalModes.get(day.id) ?? {} };
  }

  /** Saved ways of arrival, by day and then by place; a place without one follows its day. */
  private async arrivalModes(tripId: string) {
    const rows = await this.database.selectFrom("trip_place_day_assignments")
      .select(["trip_day_id", "trip_place_id", "arrival_mode"])
      .where("trip_id", "=", tripId).where("arrival_mode", "is not", null).execute();
    const byDay = new Map<string, Record<string, TravelMode>>();
    for (const row of rows) {
      byDay.set(row.trip_day_id, { ...byDay.get(row.trip_day_id), [row.trip_place_id]: row.arrival_mode as TravelMode });
    }
    return byDay;
  }

  async tripPlan(
    userId: string,
    tripId: string,
    reservePlanningWork?: (cost: number) => Promise<void>,
  ): Promise<TripPlanDto> {
    // Fingerprint before and after the reads: a plan never claims a basis it was not built on.
    const basis = await tripPlanBasis(this.database, tripId);
    const [skeleton, places, arrivalModes] = await Promise.all([
      this.tripSkeleton.getSkeleton(userId, tripId),
      this.tripPlaces.list(userId, tripId),
      this.arrivalModes(tripId),
    ]);
    const windows = await this.readWindows(tripId);
    if (await tripPlanBasis(this.database, tripId) !== basis) {
      throw new AppError("conflict", "The trip changed while planning; plan again", 409);
    }

    const unplanned = places.filter((place) => !place.scheduled && place.assignedDayId === null);
    const unplaced: TripPlanUnplacedDto[] = unplanned.filter((place) => !located(place)).map((place) => ({
      tripPlaceId: place.id,
      name: place.name,
      reason: "no_location",
      date: null,
    }));
    const candidates = unplanned.filter(located).map(plannedStop);
    await reservePlanningWork?.(Math.min(100, Math.max(1, candidates.length)));
    if (candidates.length === 0) {
      return { basis, days: [], unplaced };
    }

    // A day without lodging, places or timed items takes the zone of the trip's places.
    const fallbackZone = places.find((place) => place.timeZone)?.timeZone ?? null;
    const kept = new Map(skeleton.days.map((day) => [day.id, this.plannedOn(places, day.id)]));
    const contexts = skeleton.days.map((day) =>
      this.dayContext(skeleton, day, windows.get(day.id)!, kept.get(day.id)!.filter(located).map(plannedStop), fallbackZone));
    const contextById = new Map(contexts.map((context) => [context.day.id, context]));
    const candidateHours = await this.hoursFor(candidates.map((stop) => stop.place));
    const distribution = distributePlaces(
      contexts.map((context) => ({
        id: context.day.id,
        date: context.day.date,
        windowMinutes: context.window.endMinute - context.window.startMinute,
        fixedMinutes: unusableMinutes(context),
        start: (context.dropLuggage ? context.night : context.start) ?? null,
        end: context.night ?? (context.collectLuggageBeforeItemId ? context.morning : null),
        kept: kept.get(context.day.id)!.filter(located).map((place) => ({
          ...plannedStop(place),
          stayMinutes: stayMinutes(place),
        })),
        unmappedStays: kept.get(context.day.id)!.filter((place) => !located(place)).map(stayMinutes),
        fixedPoints: context.blocks.flatMap((block) => [block.startPointId, block.endPointId])
          .flatMap((id) => (id ? [context.points.get(id)!] : [])),
      })),
      candidates.map((stop) => ({
        id: stop.id,
        latitude: stop.latitude,
        longitude: stop.longitude,
        stayMinutes: stayMinutes(stop.place),
        voteCount: stop.place.votingAvailable ? stop.place.voteCount : 0,
        hours: (dayId: string) => {
          const context = contextById.get(dayId)!;
          return hoursOn(candidateHours.get(stop.id) ?? FAILED_LOOKUP, context.day.date, context.today);
        },
      })),
    );
    const candidateById = new Map(candidates.map((stop) => [stop.id, stop]));
    for (const entry of distribution.unplaced) {
      unplaced.push({ tripPlaceId: entry.id, name: candidateById.get(entry.id)!.name, reason: entry.reason, date: null });
    }

    // Each day that received places is checked with its real timetable; existing places come first.
    const checked = await Promise.all(contexts.map(async (context) => {
      const addedIds = distribution.added.get(context.day.id)!;
      if (addedIds.length === 0) return null;
      const keptPlaces = kept.get(context.day.id)!;
      const keptStops = keptPlaces.filter(located).map(plannedStop);
      const hours = await this.hoursFor(keptStops.map((stop) => stop.place), candidateHours);
      const stops = [...keptStops, ...addedIds.map((id) => candidateById.get(id)!)];
      const legModes = arrivalModes.get(context.day.id) ?? {};
      const result = await this.draftDay(context, stops, hours, undefined, legModes);
      return { context, addedIds, keptPlaces, keptStops, result, legModes };
    }));
    const days: TripPlanDayDto[] = [];
    for (const entry of checked) {
      if (!entry) continue;
      const { context, addedIds, keptPlaces, keptStops, result, legModes } = entry;
      const dropped = new Map(result.unscheduled.map((place) => [place.tripPlaceId, place.reason]));
      for (const id of addedIds) {
        const reason = dropped.get(id);
        if (reason) unplaced.push({ tripPlaceId: id, name: candidateById.get(id)!.name, reason, date: context.day.date });
      }
      const placedIds = addedIds.filter((id) => !dropped.has(id));
      if (placedIds.length === 0) continue;
      // A skipped place leaves the rest of the day exactly as if it had never been tried, so the
      // load level is re-derived without the dropped candidates' "not enough time" verdicts.
      const keptUnscheduled = result.unscheduled.filter((place) => !addedIds.includes(place.tripPlaceId));
      const keptResult = {
        ...result,
        unscheduled: keptUnscheduled,
        load: { ...result.load, level: dayLoadLevel(result.load.busyMinutes, result.load.windowMinutes, keptUnscheduled) },
      };
      days.push({
        timetable: this.timetableDto(
          context, [...keptStops.map((stop) => stop.id), ...placedIds], keptResult, keptPlaces, "current", legModes,
        ),
        addedTripPlaceIds: placedIds,
        orderedTripPlaceIds: [...keptPlaces.map((place) => place.id), ...placedIds],
      });
    }
    return { basis, days, unplaced };
  }

  /** Places planned for a day, in its order: applied positions first, then list (creation) order. */
  private plannedOn(places: TripPlaceDto[], dayId: string) {
    return places.filter((place) => place.assignedDayId === dayId && !place.scheduled).sort(byDayPosition);
  }

  private dayContext(
    skeleton: TripSkeletonDto,
    day: TimelineDayDto,
    window: SavedDayWindowDto,
    stops: RoutePoint[],
    fallbackZone: string | null,
  ): DayContext {
    const morning = this.lodgingFor(skeleton, Temporal.PlainDate.from(day.date).subtract({ days: 1 }).toString());
    const night = this.lodgingFor(skeleton, day.date);
    const timeZone = resolveDayTimeZone(skeleton, day, stops, fallbackZone) ?? "UTC";
    const { blocks, points } = this.blocksFor(skeleton, day, timeZone);
    const landings = blocks.filter((block) => isMove(block) && !block.endsAfterDay)
      .sort((left, right) => left.endMinute - right.endMinute || left.itemId.localeCompare(right.itemId));
    const departures = blocks.filter((block) => isMove(block) && !block.startsBeforeDay)
      .sort((left, right) => left.startMinute - right.startMinute || left.itemId.localeCompare(right.itemId));
    // The traveller arrives on the trip's first day, or on a day with a lodging but none the night
    // before. On other days without a lodging a train is just a train.
    const firstDay = skeleton.days[0]?.id === day.id;
    const arrivalItemId = !morning && (night !== null || firstDay) ? landings[0]?.itemId ?? null : null;
    // A new lodging takes the luggage after the last move of the day, or first thing.
    const moving = night !== null && (morning ? morning.id !== night.id : arrivalItemId !== null);
    const dropLuggage = moving ? { afterItemId: landings.at(-1)?.itemId ?? null } : null;
    // The last day: luggage is collected before the move that leaves, which is the first flight
    // out (or the last move without one), or an earlier move that takes the traveller to it.
    const feeds = (move: TimetableBlock, into: TimetableBlock) => {
      if (move.endMinute > into.startMinute || !move.endPointId || !into.startPointId) return false;
      if (move.endPointId === into.startPointId) return true;
      return straightLineMeters(points.get(move.endPointId)!, points.get(into.startPointId)!) <= FEEDER_METERS;
    };
    let leaving = departures.find((block) => block.itemType === "flight") ?? departures.at(-1) ?? null;
    for (let feeder = leaving; feeder; ) {
      leaving = feeder;
      const into = feeder;
      feeder = departures.filter((block) => block.startMinute < into.startMinute && feeds(block, into)).at(-1) ?? null;
    }
    const collectLuggageBeforeItemId = morning && !night ? leaving?.itemId ?? null : null;
    const today = Temporal.Instant.fromEpochMilliseconds(this.now().getTime())
      .toZonedDateTimeISO(timeZone).toPlainDate().toString();
    return {
      day,
      window,
      morning,
      night,
      start: morning ?? (arrivalItemId ? null : night),
      arrivalItemId,
      dropLuggage,
      collectLuggageBeforeItemId,
      timeZone,
      today,
      // The arrival is boarded elsewhere and the departure leaves: their check-in and entry time
      // respectively do not happen here.
      blocks: blocks.map((block) =>
        block.itemId === arrivalItemId
          ? { ...block, bufferMinutes: 0, bufferEstimated: false }
          : block.itemId === collectLuggageBeforeItemId
            ? { ...block, afterBufferMinutes: 0 }
            : block),
      points,
    };
  }

  /** Opening hours per place ID, reusing `known` and looking each other place up once. */
  private async hoursFor(
    places: TripPlaceDto[],
    known = new Map<string, LookedUpHours>(),
  ) {
    const missing = places.filter((place) => !known.has(place.id));
    const fetched = await Promise.all(missing.map((place) => this.openingHours(place)));
    const hours = new Map(known);
    missing.forEach((place, index) => hours.set(place.id, fetched[index]!));
    return hours;
  }

  /** The day's timetable with `stops` in this order; `legs` lets several drafts of one day share route lookups. */
  private async draftDay(
    context: DayContext,
    stops: PlannedStop[],
    hours: Map<string, LookedUpHours>,
    legs = new Map<string, Promise<DayLegDto>>(),
    legModes: Record<string, TravelMode> = {},
  ): Promise<TimetableResult> {
    const { day, window, start, night, blocks } = context;
    const points = new Map(context.points);
    for (const point of [...(start ? [start] : []), ...(night ? [night] : []), ...stops]) points.set(point.id, point);
    // Every leg is looked up as if leaving at the day's start, so one pair has one answer.
    const departureTime = Temporal.PlainDate.from(day.date)
      .toZonedDateTime({ timeZone: context.timeZone })
      .add({ minutes: window.startMinute })
      .toString({ timeZoneName: "never" });
    // A leg is travelled the way chosen for the place it reaches, else the day's way.
    const travel = (fromId: string, toId: string) => {
      const mode = legModes[toId] ?? window.travelMode;
      const key = `${fromId}>${toId}>${mode}`;
      let pending = legs.get(key);
      if (!pending) {
        pending = this.leg(points.get(fromId)!, points.get(toId)!, departureTime, mode, walkLimitFor(mode, window.walkLimitMinutes));
        legs.set(key, pending);
      }
      return pending;
    };
    const scheduleStops: TimetableStop[] = stops.map((stop) => ({
      id: stop.id,
      name: stop.name,
      type: stop.place.type,
      durationMinutes: stop.place.durationMinutes,
      hours: hoursOn(hours.get(stop.id) ?? FAILED_LOOKUP, day.date, context.today),
    }));
    // Start, at once, the legs a schedule uses when every open place fits; the scheduler then
    // mostly reads finished answers. Returns to the lodging are only certain without fixed items.
    const open = scheduleStops.filter((stop) => stop.hours.status !== "closed").map((stop) => stop.id);
    const firstOrigin = context.dropLuggage ? night : start;
    const path = firstOrigin ? [firstOrigin.id, ...open] : open;
    for (const [index, id] of path.slice(1).entries()) void travel(path[index]!, id);
    if (night) {
      for (const id of blocks.length === 0 ? open : open.slice(-1)) void travel(id, night.id);
    }
    return scheduleDay({
      window,
      start: start ? { id: start.id, name: start.name } : null,
      end: night ? { id: night.id, name: night.name } : null,
      arrivalItemId: context.arrivalItemId,
      dropLuggage: context.dropLuggage,
      collectLuggageBeforeItemId: context.collectLuggageBeforeItemId,
      stops: scheduleStops,
      blocks,
      travel,
    });
  }

  private timetableDto(
    context: DayContext,
    orderedTripPlaceIds: string[],
    result: TimetableResult,
    planned: TripPlaceDto[],
    order: DayTimetableDto["order"],
    legModes: Record<string, TravelMode> = {},
    taxiAlternative: DayTimetableDto["taxiAlternative"] = null,
  ): DayTimetableDto {
    const unscheduled = [
      ...result.unscheduled,
      ...planned.filter((place) => !located(place)).map((place) => ({
        tripPlaceId: place.id,
        name: place.name,
        reason: "no_location" as const,
      })),
    ];
    const listed = new Set(orderedTripPlaceIds);
    return {
      dayId: context.day.id,
      date: context.day.date,
      window: context.window,
      order,
      orderedTripPlaceIds,
      startsAt: context.start ? { placeId: context.start.id, name: context.start.name } : null,
      endsAt: context.night ? { placeId: context.night.id, name: context.night.name } : null,
      rows: result.rows,
      unscheduled,
      load: result.load,
      capacity: result.capacity,
      legModes: Object.fromEntries(Object.entries(legModes).filter(([id]) => listed.has(id))),
      taxiAlternative,
    };
  }

  async applyOrder(
    userId: string,
    tripId: string,
    dayId: string,
    rawKey: string,
    input: ApplyDayPlaceOrderInput,
  ) {
    const ids = Array.isArray(input.orderedTripPlaceIds) ? input.orderedTripPlaceIds : null;
    if (!ids || ids.length === 0 || ids.length > 100 || ids.some((id) => typeof id !== "string" || !UUID.test(id))) {
      throw new AppError("validation_error", "orderedTripPlaceIds must contain 1 to 100 place IDs");
    }
    const orderedTripPlaceIds = ids.map((id) => id.toLowerCase());
    if (new Set(orderedTripPlaceIds).size !== orderedTripPlaceIds.length) {
      throw new AppError("validation_error", "orderedTripPlaceIds cannot repeat a place");
    }
    const day = dayId.toLowerCase();
    const key = requireIdempotencyKey(rawKey);
    // mutation_requests.operation is varchar(80); two UUIDs leave room for a 6-character prefix.
    const operation = `dpo:${tripId.toLowerCase()}:${day}`;
    return this.database.transaction().execute(async (transaction) => {
      await requireScheduler(transaction, userId, tripId);
      await lockMutation(transaction, userId, operation, key);
      const replay = await replayed(transaction, userId, operation, key);
      if (replay) return replay as DayPlaceOrderResponse;
      await lockTrip(transaction, tripId);
      await requireDayVersion(transaction, tripId, day, input.expectedVersion);
      const assignments = await transaction.selectFrom("trip_place_day_assignments")
        .select("trip_place_id")
        .where("trip_id", "=", tripId)
        .where("trip_day_id", "=", day)
        .forUpdate()
        .execute();
      const onDay = new Set(assignments.map((row) => row.trip_place_id));
      if (orderedTripPlaceIds.some((id) => !onDay.has(id))) {
        throw new AppError("conflict", "This day's places changed; plan the day again", 409);
      }
      await transaction.updateTable("trip_place_day_assignments").set({ day_position: null })
        .where("trip_id", "=", tripId).where("trip_day_id", "=", day).execute();
      for (const [position, id] of orderedTripPlaceIds.entries()) {
        await transaction.updateTable("trip_place_day_assignments").set({ day_position: position })
          .where("trip_place_id", "=", id).execute();
      }
      await recordEvent(transaction, {
        tripId,
        actorId: userId,
        eventType: "trip_day.places_ordered",
        targetType: "trip_day",
        targetId: day,
        summary: `Ordered ${orderedTripPlaceIds.length} planned places for a day`,
      });
      const saved = await transaction.selectFrom("trip_days").select("version").where("id", "=", day).executeTakeFirstOrThrow();
      const response = { orderedTripPlaceIds, version: saved.version };
      await remember(transaction, userId, operation, key, response);
      return response;
    });
  }

  async updateWindow(
    userId: string,
    tripId: string,
    dayId: string,
    rawKey: string,
    input: UpdateDayWindowInput,
  ): Promise<SavedDayWindowDto> {
    const startMinute = windowMinute(input?.startMinute, "startMinute");
    const endMinute = windowMinute(input?.endMinute, "endMinute");
    if (startMinute >= endMinute) {
      throw new AppError("validation_error", "The day must end after it starts");
    }
    if (input.travelMode !== undefined && !TRAVEL_MODES.includes(input.travelMode)) {
      throw new AppError("validation_error", "travelMode must be transit, taxi or walk");
    }
    if (input.walkLimitMinutes !== undefined && (!Number.isInteger(input.walkLimitMinutes) || input.walkLimitMinutes < 5 || input.walkLimitMinutes > 60)) {
      throw new AppError("validation_error", "walkLimitMinutes must be a whole number from 5 to 60");
    }
    const day = dayId.toLowerCase();
    const key = requireIdempotencyKey(rawKey);
    // mutation_requests.operation is varchar(80); two UUIDs leave room for a 6-character prefix.
    const operation = `dpw:${tripId.toLowerCase()}:${day}`;
    return this.database.transaction().execute(async (transaction) => {
      await requireScheduler(transaction, userId, tripId);
      await lockMutation(transaction, userId, operation, key);
      const replay = await replayed(transaction, userId, operation, key);
      if (replay) return replay as SavedDayWindowDto;
      await lockTrip(transaction, tripId);
      await requireDayVersion(transaction, tripId, day, input.expectedVersion);
      const updated = await transaction.updateTable("trip_days")
        .set({
          day_start_minute: startMinute,
          day_end_minute: endMinute,
          ...(input.travelMode !== undefined ? { travel_mode: input.travelMode } : {}),
          ...(input.walkLimitMinutes !== undefined ? { walk_limit_minutes: input.walkLimitMinutes } : {}),
        })
        .where("trip_id", "=", tripId).where("id", "=", day)
        .returning(["id", "day_start_minute", "day_end_minute", "version", "travel_mode", "walk_limit_minutes"]).executeTakeFirst();
      if (!updated) throw new AppError("trip_day_not_found", "Trip day not found", 404);
      const time = (minute: number) =>
        `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
      await recordEvent(transaction, {
        tripId,
        actorId: userId,
        eventType: "trip_day.window_changed",
        targetType: "trip_day",
        targetId: day,
        summary: `Set a day to plan from ${time(startMinute)} to ${time(endMinute)}`,
      });
      const response = savedWindow(updated);
      await remember(transaction, userId, operation, key, response);
      return response;
    });
  }

  async getWindow(userId: string, tripId: string, dayId: string): Promise<SavedDayWindowDto> {
    const member = await this.database.selectFrom("trip_members").select("id")
      .where("trip_id", "=", tripId).where("user_id", "=", userId).where("removed_at", "is", null).executeTakeFirst();
    if (!member) throw new AppError("trip_not_found", "Trip not found", 404);
    const day = await this.database.selectFrom("trip_days")
      .select(["day_start_minute", "day_end_minute", "version", "travel_mode", "walk_limit_minutes"])
      .where("trip_id", "=", tripId).where("id", "=", dayId).executeTakeFirst();
    if (!day) throw new AppError("trip_day_not_found", "Trip day not found", 404);
    return savedWindow(day);
  }

  /** Each day's planned hours, by day ID. */
  private async readWindows(tripId: string) {
    const rows = await this.database.selectFrom("trip_days")
      .select(["id", "day_start_minute", "day_end_minute", "version", "travel_mode", "walk_limit_minutes"])
      .where("trip_id", "=", tripId)
      .execute();
    return new Map(rows.map((row): [string, SavedDayWindowDto] => [row.id, savedWindow(row)]));
  }

  /** Opening hours from the place's provider, or why there are none: not a provider place, or the lookup failed. */
  private async openingHours(place: TripPlaceDto): Promise<LookedUpHours> {
    if (place.provider !== "google" || !place.providerPlaceId) return { missing: "manual" };
    try {
      return await this.placeHours.openingHours(place.providerPlaceId);
    } catch (reason) {
      // The timetable still drafts without hours; keep quota separate so retry advice stays honest.
      console.error(JSON.stringify({
        event: "opening_hours_lookup_failed",
        tripPlaceId: place.id,
        providerPlaceId: place.providerPlaceId,
        error: reason instanceof Error ? reason.name : typeof reason,
      }));
      return reason instanceof ProviderQuotaError ? QUOTA_LOOKUP : FAILED_LOOKUP;
    }
  }

  /**
   * Timed items on the day, except lodging, which is where the day starts and ends.
   * Times are converted to minutes of the day in the day's zone.
   */
  private blocksFor(skeleton: TripSkeletonDto, day: TripSkeletonDto["days"][number], timeZone: string) {
    const placesById = new Map(skeleton.places.map((place) => [place.id, place]));
    const itemsById = new Map(skeleton.items.map((item) => [item.id, item]));
    const points = new Map<string, RoutePoint>();
    const dayStart = Temporal.PlainDate.from(day.date).toZonedDateTime({ timeZone }).toInstant();
    const minuteOf = (instant: Temporal.Instant) =>
      Math.round(dayStart.until(instant).total({ unit: "minutes" }));
    const pointFor = (placeId: string | undefined) => {
      const place = placeId ? placesById.get(placeId) : undefined;
      if (!place || !located(place)) return null;
      points.set(place.id, {
        id: place.id,
        name: place.name,
        latitude: place.latitude!,
        longitude: place.longitude!,
        timeZone: place.timeZone,
      });
      return place.id;
    };
    const blocks: TimetableBlock[] = [];
    for (const entry of day.entries) {
      const item = itemsById.get(entry.itemId);
      const start = item ? endpoint(item, "start") : null;
      if (!item || !start || item.type === "lodging") continue;
      const end = endpoint(item, "end");
      const startInstant = Temporal.Instant.from(start.instant);
      const endInstant = end ? Temporal.Instant.from(end.instant) : startInstant.add({ minutes: plannedMinutes(item) });
      const startMinute = minuteOf(startInstant);
      const endMinute = minuteOf(endInstant);
      const confirmed = item.constraints.flatMap((constraint) =>
        constraint.type === "minimum_buffer" && constraint.status === "confirmed" && constraint.minimumBufferMinutes !== null
          ? [constraint.minimumBufferMinutes]
          : []);
      const flight = item.type === "flight";
      const startPointId = pointFor(start.placeId);
      blocks.push({
        itemId: item.id,
        title: item.title,
        itemType: item.type,
        startMinute: Math.min(DAY_MINUTES, Math.max(0, startMinute)),
        endMinute: Math.min(DAY_MINUTES, Math.max(0, endMinute)),
        startsBeforeDay: startMinute < 0,
        endsAfterDay: endMinute > DAY_MINUTES,
        startPointId,
        endPointId: end ? pointFor(end.placeId) : startPointId,
        // A confirmed buffer wins; a flight otherwise gets the default check-in time.
        bufferMinutes: confirmed.length > 0 ? Math.max(...confirmed) : flight ? FLIGHT_CHECK_IN_MINUTES : 0,
        bufferEstimated: confirmed.length === 0 && flight,
        afterBufferMinutes: flight ? FLIGHT_ARRIVAL_MINUTES : 0,
      });
    }
    return { blocks, points };
  }

  /** The lodging slept in that night: check-in on or before the date, checkout after it. */
  private lodgingFor(skeleton: TripSkeletonDto, date: string): RoutePoint | null {
    const lodging = lodgingForNight(skeleton, date);
    if (!lodging) return null;
    return {
      id: lodging.place.id,
      name: lodging.place.name,
      latitude: lodging.place.latitude!,
      longitude: lodging.place.longitude!,
      timeZone: lodging.timeZone,
    };
  }

  /**
   * One leg, travelled `mode`: taxi drives (plus the wait); transit and walk walk when the walk is
   * within `walkLimit` and otherwise take transit. A long walk never stands in for missing transit:
   * the leg is then unknown, so the day is not judged on a two-hour walk nobody would take.
   */
  private async leg(
    from: RoutePoint,
    to: RoutePoint,
    departureTime: string,
    mode: TravelMode,
    walkLimit: number,
  ): Promise<DayLegDto> {
    const query = {
      origin: { placeId: from.id, latitude: from.latitude, longitude: from.longitude },
      destination: { placeId: to.id, latitude: to.latitude, longitude: to.longitude },
      departureTime,
      modes: routeModesFor(mode),
    };
    const observations = (await Promise.all(
      this.routeProviders.map((provider) => provider.observe(query)),
    )).flat();
    return legFor(observations, { fromName: from.name, toName: to.name }, mode, walkLimit);
  }
}
