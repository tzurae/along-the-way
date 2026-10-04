import { Temporal } from "@js-temporal/polyfill";
import type {
  ApplyDayPlaceOrderInput,
  DayRouteLegDto,
  DayRouteLodgingDto,
  DayRoutePlanDto,
  DayRouteStopDto,
} from "@along-the-way/contracts/day-routes";
import type {
  RouteObservation,
  RouteObservationProvider,
} from "@along-the-way/contracts/planning-observations";
import type { TripSkeletonDto } from "@along-the-way/contracts/trip-skeleton";
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

/** Walking is suggested when it takes at most this long. */
const PREFERRED_WALK_MINUTES = 15;
/** Route queries assume the day starts at this local time. */
const DAY_START = "10:00";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface DayRouteModule {
  plan(userId: string, tripId: string, dayId: string): Promise<DayRoutePlanDto>;
  applyOrder(
    userId: string,
    tripId: string,
    dayId: string,
    idempotencyKey: string,
    input: ApplyDayPlaceOrderInput,
  ): Promise<{ orderedTripPlaceIds: string[] }>;
}

interface ModuleOptions {
  database: Kysely<AlongTheWayDatabase>;
  tripSkeleton: TripSkeletonModule;
  tripPlaces: TripPlaceModule;
  /** Consulted in order; the first available observation per mode wins. */
  routeProviders: RouteObservationProvider[];
}

interface RoutePoint extends GeoPoint {
  name: string;
  timeZone: string | null;
}

function located(value: { latitude: number | null; longitude: number | null }) {
  return value.latitude !== null && value.longitude !== null;
}

function departureTime(date: string, timeZone: string | null) {
  // Without a known zone, fall back to UTC; providers still return durations.
  const zone = timeZone ?? "UTC";
  return Temporal.PlainDateTime.from(`${date}T${DAY_START}`)
    .toZonedDateTime(zone)
    .toString({ timeZoneName: "never" });
}

type AvailableObservation = Extract<RouteObservation, { status: "available" }>;

function firstAvailable(observations: RouteObservation[], mode: RouteObservation["mode"]) {
  return observations.find((entry): entry is AvailableObservation =>
    entry.mode === mode && entry.status === "available") ?? null;
}

export class PostgresDayRouteModule implements DayRouteModule {
  private readonly database: Kysely<AlongTheWayDatabase>;
  private readonly tripSkeleton: TripSkeletonModule;
  private readonly tripPlaces: TripPlaceModule;
  private readonly routeProviders: RouteObservationProvider[];

  constructor(options: ModuleOptions) {
    this.database = options.database;
    this.tripSkeleton = options.tripSkeleton;
    this.tripPlaces = options.tripPlaces;
    this.routeProviders = options.routeProviders;
  }

  async plan(userId: string, tripId: string, dayId: string): Promise<DayRoutePlanDto> {
    // Both reads authorize membership and resolve names, coordinates, and zones.
    const [skeleton, places] = await Promise.all([
      this.tripSkeleton.getSkeleton(userId, tripId),
      this.tripPlaces.list(userId, tripId),
    ]);
    const day = skeleton.days.find((entry) => entry.id === dayId.toLowerCase());
    if (!day) throw new AppError("trip_day_not_found", "Trip day not found", 404);

    const planned = places.filter((place) => place.assignedDayId === day.id && !place.scheduled);
    const unplaceable: DayRouteStopDto[] = planned
      .filter((place) => !located(place))
      .map((place) => ({ tripPlaceId: place.id, name: place.name }));
    const stops: RoutePoint[] = planned.filter(located).map((place) => ({
      id: place.id,
      name: place.name,
      latitude: place.latitude!,
      longitude: place.longitude!,
      timeZone: place.timeZone,
    }));

    const lodging = this.lodgingFor(skeleton, day.date);
    const order = orderByStraightLine(stops, lodging);
    const byId = new Map(stops.map((stop) => [stop.id, stop]));
    const ordered = order.map((id) => byId.get(id)!);
    const path = lodging ? [lodging, ...ordered, lodging] : ordered;
    const legs = await Promise.all(path.slice(1).map((to, index) => this.leg(path[index]!, to, day.date)));

    return {
      dayId: day.id,
      date: day.date,
      lodging: lodging ? { placeId: lodging.id, name: lodging.name } satisfies DayRouteLodgingDto : null,
      stops: ordered.map((stop) => ({ tripPlaceId: stop.id, name: stop.name })),
      legs: ordered.length > 0 ? legs : [],
      totalMinutes: legs.reduce((sum, entry) => sum + (entry.durationMinutes ?? 0), 0),
      unknownLegs: ordered.length > 0 ? legs.filter((entry) => entry.durationMinutes === null).length : 0,
      unplaceable,
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

  /** The lodging slept in that night: check-in on or before the date, checkout after it. */
  private lodgingFor(skeleton: TripSkeletonDto, date: string): RoutePoint | null {
    const placesById = new Map(skeleton.places.map((place) => [place.id, place]));
    for (const item of skeleton.items) {
      if (item.type !== "lodging") continue;
      const start = item.endpoints.find((endpoint) => endpoint.role === "start");
      const end = item.endpoints.find((endpoint) => endpoint.role === "end");
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

  private async leg(from: RoutePoint, to: RoutePoint, date: string): Promise<DayRouteLegDto> {
    const query = {
      origin: { placeId: from.id, latitude: from.latitude, longitude: from.longitude },
      destination: { placeId: to.id, latitude: to.latitude, longitude: to.longitude },
      departureTime: departureTime(date, from.timeZone ?? to.timeZone),
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
