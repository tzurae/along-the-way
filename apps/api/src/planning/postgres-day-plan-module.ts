import { Temporal } from "@js-temporal/polyfill";
import type {
  ApplyDayPlaceOrderInput,
  CreateDayTimetableInput,
  DayLegDto,
  DayTimetableDto,
  DayWindowDto,
  UpdateDayWindowInput,
} from "@along-the-way/contracts/day-plans";
import type {
  RouteObservation,
  RouteObservationProvider,
} from "@along-the-way/contracts/planning-observations";
import type { TripPlaceDto } from "@along-the-way/contracts/trip-places";
import type { ItineraryItemDto, TripSkeletonDto } from "@along-the-way/contracts/trip-skeleton";
import type { Kysely } from "kysely";

import type { AlongTheWayDatabase } from "../database/database";
import { AppError } from "../private-trips/private-trip-module";
import {
  lockMutation,
  recordEvent,
  remember,
  replayed,
  requireIdempotencyKey,
} from "../private-trips/postgres-private-trip-store";
import type { TripPlaceModule } from "../trip-places/trip-place-module";
import type { TripSkeletonModule } from "../trip-skeleton/trip-skeleton-module";
import { orderByStraightLine, type GeoPoint } from "./day-route-order";
import { scheduleDay, type TimetableBlock, type TimetableStop } from "./day-timetable";
import { hoursOn, type PlaceHoursLookup, type PlaceOpeningHours } from "./opening-hours";

/** Walking is suggested when it takes at most this long. */
const PREFERRED_WALK_MINUTES = 15;
const DAY_MINUTES = 24 * 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface DayPlanModule {
  /** A draft timetable for the day; computed on request, never stored. */
  timetable(userId: string, tripId: string, dayId: string, input: CreateDayTimetableInput): Promise<DayTimetableDto>;
  applyOrder(
    userId: string,
    tripId: string,
    dayId: string,
    idempotencyKey: string,
    input: ApplyDayPlaceOrderInput,
  ): Promise<{ orderedTripPlaceIds: string[] }>;
  updateWindow(
    userId: string,
    tripId: string,
    dayId: string,
    idempotencyKey: string,
    input: UpdateDayWindowInput,
  ): Promise<DayWindowDto>;
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

function located(value: { latitude: number | null; longitude: number | null }) {
  return value.latitude !== null && value.longitude !== null;
}

type AvailableObservation = Extract<RouteObservation, { status: "available" }>;

function firstAvailable(observations: RouteObservation[], mode: RouteObservation["mode"]) {
  return observations.find((entry): entry is AvailableObservation =>
    entry.mode === mode && entry.status === "available") ?? null;
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
  ): Promise<DayTimetableDto> {
    const order = input?.order;
    if (order !== "current" && order !== "suggested") {
      throw new AppError("validation_error", "order must be current or suggested");
    }
    // Both reads authorize membership and resolve names, coordinates, and zones.
    const [skeleton, places] = await Promise.all([
      this.tripSkeleton.getSkeleton(userId, tripId),
      this.tripPlaces.list(userId, tripId),
    ]);
    const day = skeleton.days.find((entry) => entry.id === dayId.toLowerCase());
    if (!day) throw new AppError("trip_day_not_found", "Trip day not found", 404);
    const window = await this.readWindow(tripId, day.id);

    // The list is in creation order; a stable sort keeps it for places without a position.
    const planned = places.filter((place) => place.assignedDayId === day.id && !place.scheduled)
      .sort(byDayPosition);
    const stops: Array<RoutePoint & { place: TripPlaceDto }> = planned.filter(located).map((place) => ({
      id: place.id,
      name: place.name,
      latitude: place.latitude!,
      longitude: place.longitude!,
      timeZone: place.timeZone,
      place,
    }));
    const lodging = this.lodgingFor(skeleton, day.date);
    const orderedIds = order === "suggested"
      ? orderByStraightLine(stops, lodging)
      : stops.map((stop) => stop.id);
    const stopsById = new Map(stops.map((stop) => [stop.id, stop]));
    const ordered = orderedIds.map((id) => stopsById.get(id)!);

    const timeZone = lodging?.timeZone
      ?? stops.find((stop) => stop.timeZone)?.timeZone
      ?? day.entries.flatMap((entry) => skeleton.items.find((item) => item.id === entry.itemId)?.endpoints ?? [])[0]?.timeZone
      ?? "UTC";
    const { blocks, points } = this.blocksFor(skeleton, day, timeZone);
    for (const point of [...(lodging ? [lodging] : []), ...stops]) points.set(point.id, point);

    // Every leg is looked up as if leaving at the day's start, so one pair has one answer.
    const departureTime = Temporal.PlainDate.from(day.date)
      .toZonedDateTime({ timeZone })
      .add({ minutes: window.startMinute })
      .toString({ timeZoneName: "never" });
    const legs = new Map<string, Promise<DayLegDto>>();
    const travel = (fromId: string, toId: string) => {
      const key = `${fromId}>${toId}`;
      let pending = legs.get(key);
      if (!pending) {
        pending = this.leg(points.get(fromId)!, points.get(toId)!, departureTime);
        legs.set(key, pending);
      }
      return pending;
    };

    const today = Temporal.Instant.fromEpochMilliseconds(this.now().getTime())
      .toZonedDateTimeISO(timeZone).toPlainDate().toString();
    const hours = await Promise.all(ordered.map((stop) => this.openingHours(stop.place)));
    const scheduleStops: TimetableStop[] = ordered.map((stop, index) => ({
      id: stop.id,
      name: stop.name,
      type: stop.place.type,
      durationMinutes: stop.place.durationMinutes,
      hours: hoursOn(hours[index]!, day.date, today),
    }));
    // Start, at once, the legs a schedule uses when every open place fits; the scheduler then
    // mostly reads finished answers. Returns to the lodging are only certain without fixed items.
    const open = scheduleStops.filter((stop) => stop.hours.status !== "closed").map((stop) => stop.id);
    const path = lodging ? [lodging.id, ...open] : open;
    for (const [index, id] of path.slice(1).entries()) void travel(path[index]!, id);
    if (lodging) {
      for (const id of blocks.length === 0 ? open : open.slice(-1)) void travel(id, lodging.id);
    }
    const result = await scheduleDay({
      window,
      lodging: lodging ? { id: lodging.id, name: lodging.name } : null,
      stops: scheduleStops,
      blocks,
      travel,
    });

    return {
      dayId: day.id,
      date: day.date,
      window,
      order,
      orderedTripPlaceIds: orderedIds,
      lodging: lodging ? { placeId: lodging.id, name: lodging.name } : null,
      rows: result.rows,
      unscheduled: [
        ...result.unscheduled,
        ...planned.filter((place) => !located(place)).map((place) => ({
          tripPlaceId: place.id,
          name: place.name,
          reason: "no_location" as const,
        })),
      ],
      load: result.load,
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
      const membership = await transaction.selectFrom("trip_members").select("role")
        .where("trip_id", "=", tripId).where("user_id", "=", userId)
        .where("removed_at", "is", null).executeTakeFirst();
      if (!membership) throw new AppError("trip_not_found", "Trip not found", 404);
      await lockMutation(transaction, userId, operation, key);
      const replay = await replayed(transaction, userId, operation, key);
      if (replay) return replay as { orderedTripPlaceIds: string[] };
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
      const response = { orderedTripPlaceIds };
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
  ): Promise<DayWindowDto> {
    const startMinute = windowMinute(input?.startMinute, "startMinute");
    const endMinute = windowMinute(input?.endMinute, "endMinute");
    if (startMinute >= endMinute) {
      throw new AppError("validation_error", "The day must end after it starts");
    }
    const day = dayId.toLowerCase();
    const key = requireIdempotencyKey(rawKey);
    // mutation_requests.operation is varchar(80); two UUIDs leave room for a 6-character prefix.
    const operation = `dpw:${tripId.toLowerCase()}:${day}`;
    return this.database.transaction().execute(async (transaction) => {
      const membership = await transaction.selectFrom("trip_members").select("role")
        .where("trip_id", "=", tripId).where("user_id", "=", userId)
        .where("removed_at", "is", null).executeTakeFirst();
      if (!membership) throw new AppError("trip_not_found", "Trip not found", 404);
      await lockMutation(transaction, userId, operation, key);
      const replay = await replayed(transaction, userId, operation, key);
      if (replay) return replay as DayWindowDto;
      const updated = await transaction.updateTable("trip_days")
        .set({ day_start_minute: startMinute, day_end_minute: endMinute })
        .where("trip_id", "=", tripId).where("id", "=", day)
        .returning("id").executeTakeFirst();
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
      const response = { startMinute, endMinute };
      await remember(transaction, userId, operation, key, response);
      return response;
    });
  }

  private async readWindow(tripId: string, dayId: string): Promise<DayWindowDto> {
    const row = await this.database.selectFrom("trip_days")
      .select(["day_start_minute", "day_end_minute"])
      .where("trip_id", "=", tripId).where("id", "=", dayId)
      .executeTakeFirstOrThrow();
    return { startMinute: row.day_start_minute, endMinute: row.day_end_minute };
  }

  /** Opening hours from the place's provider; unknown when it has none or the lookup fails. */
  private async openingHours(place: TripPlaceDto): Promise<PlaceOpeningHours | null> {
    if (place.provider !== "google" || !place.providerPlaceId) return null;
    try {
      return await this.placeHours.openingHours(place.providerPlaceId);
    } catch {
      return null;
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
      const buffers = item.constraints.flatMap((constraint) =>
        constraint.type === "minimum_buffer" && constraint.status === "confirmed" && constraint.minimumBufferMinutes !== null
          ? [constraint.minimumBufferMinutes]
          : []);
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
        bufferMinutes: Math.max(0, ...buffers),
      });
    }
    return { blocks, points };
  }

  /** The lodging slept in that night: check-in on or before the date, checkout after it. */
  private lodgingFor(skeleton: TripSkeletonDto, date: string): RoutePoint | null {
    const placesById = new Map(skeleton.places.map((place) => [place.id, place]));
    for (const item of skeleton.items) {
      if (item.type !== "lodging") continue;
      const start = endpoint(item, "start");
      const end = endpoint(item, "end");
      if (!start || !end) continue;
      if (start.localDateTime.slice(0, 10) > date || end.localDateTime.slice(0, 10) <= date) continue;
      const place = placesById.get(start.placeId);
      if (!place || !located(place)) continue;
      return {
        id: place.id,
        name: place.name,
        latitude: place.latitude!,
        longitude: place.longitude!,
        timeZone: start.timeZone,
      };
    }
    return null;
  }

  private async leg(from: RoutePoint, to: RoutePoint, departureTime: string): Promise<DayLegDto> {
    const query = {
      origin: { placeId: from.id, latitude: from.latitude, longitude: from.longitude },
      destination: { placeId: to.id, latitude: to.latitude, longitude: to.longitude },
      departureTime,
    };
    const settled = await Promise.allSettled(this.routeProviders.map((provider) => provider.observe(query)));
    const observations = settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    const walking = firstAvailable(observations, "walking");
    const transit = firstAvailable(observations, "transit");
    const chosen = walking && walking.durationMinutes <= PREFERRED_WALK_MINUTES
      ? walking
      : transit ?? walking;
    const reasons = [...new Set(observations.flatMap((entry) => entry.status === "unavailable" ? [entry.reason] : []))];
    return {
      fromName: from.name,
      toName: to.name,
      mode: chosen?.mode ?? null,
      durationMinutes: chosen?.durationMinutes ?? null,
      walkingMinutes: walking?.durationMinutes ?? null,
      transitMinutes: transit?.durationMinutes ?? null,
      estimated: chosen?.manualChecks.includes("transit_duration_estimated") ?? false,
      attribution: chosen?.attribution ?? null,
      unavailableReason: chosen ? null : (reasons.join(", ") || "no_route"),
    };
  }
}
