import { Temporal } from "@js-temporal/polyfill";
import {
  MAX_DAY_ROUTE_STOPS,
  type CreateDayRouteInput,
  type DayRouteDto,
} from "@along-the-way/contracts/day-plans";
import type { TripPlaceDto } from "@along-the-way/contracts/trip-places";
import type { TripSkeletonDto } from "@along-the-way/contracts/trip-skeleton";
import type { Kysely, Transaction } from "kysely";

import type { AlongTheWayDatabase } from "../database/database";
import { AppError } from "../private-trips/private-trip-module";
import {
  lockMutation,
  recordEvent,
  remember,
  replayed,
  requireDayVersion,
  requireIdempotencyKey,
  requireScheduler,
} from "../private-trips/postgres-private-trip-store";
import type { TripPlaceModule } from "../trip-places/trip-place-module";
import type { TripSkeletonModule } from "../trip-skeleton/trip-skeleton-module";
import { buildDayRoute } from "./day-route";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ApplyDayPlaceOrderInput {
  expectedVersion: number;
  orderedTripPlaceIds: string[];
}

interface DayPlaceOrderResponse {
  orderedTripPlaceIds: string[];
  version: number;
}

export interface DayPlanModule {
  route(userId: string, tripId: string, dayId: string, input: CreateDayRouteInput): Promise<DayRouteDto>;
  applyOrder(
    userId: string,
    tripId: string,
    dayId: string,
    idempotencyKey: string,
    input: ApplyDayPlaceOrderInput,
  ): Promise<DayPlaceOrderResponse>;
}

interface ModuleOptions {
  database: Kysely<AlongTheWayDatabase>;
  tripSkeleton: TripSkeletonModule;
  tripPlaces: TripPlaceModule;
}

/** Applied order first; places without one keep their list order after them. */
function byDayPosition(left: TripPlaceDto, right: TripPlaceDto): number {
  if (left.dayPosition === right.dayPosition) return 0;
  if (left.dayPosition === null) return 1;
  if (right.dayPosition === null) return -1;
  return left.dayPosition - right.dayPosition;
}

/** A booked stay for this night, whether or not its hotel has map coordinates. */
function bookedLodgingForNight(skeleton: TripSkeletonDto, date: string) {
  for (const item of skeleton.items) {
    if (item.type !== "lodging") continue;
    const start = item.endpoints.find((endpoint) => endpoint.role === "start");
    const end = item.endpoints.find((endpoint) => endpoint.role === "end");
    if (
      !start
      || !end
      || start.localDateTime.slice(0, 10) > date
      || end.localDateTime.slice(0, 10) <= date
    ) {
      continue;
    }
    const place = skeleton.places.find((entry) => entry.id === start.placeId);
    if (place) return place;
  }
  return null;
}

/** Every writer takes the trip row before a day row, keeping the repository's lock order. */
async function lockTrip(transaction: Transaction<AlongTheWayDatabase>, tripId: string): Promise<void> {
  const trip = await transaction.selectFrom("trips")
    .select("id")
    .where("id", "=", tripId)
    .forUpdate()
    .executeTakeFirst();
  if (!trip) throw new AppError("trip_not_found", "Trip not found", 404);
}

export class PostgresDayPlanModule implements DayPlanModule {
  private readonly database: Kysely<AlongTheWayDatabase>;
  private readonly tripSkeleton: TripSkeletonModule;
  private readonly tripPlaces: TripPlaceModule;

  constructor(options: ModuleOptions) {
    this.database = options.database;
    this.tripSkeleton = options.tripSkeleton;
    this.tripPlaces = options.tripPlaces;
  }

  async route(
    userId: string,
    tripId: string,
    dayId: string,
    input: CreateDayRouteInput,
  ): Promise<DayRouteDto> {
    const order = input?.order;
    if (order !== "current" && order !== "suggested" && order !== "custom") {
      throw new AppError("validation_error", "order must be current, suggested or custom");
    }
    if (order !== "custom" && input.orderedTripPlaceIds !== undefined) {
      throw new AppError("validation_error", "orderedTripPlaceIds is only valid with custom order");
    }
    if (order === "custom" && !Array.isArray(input.orderedTripPlaceIds)) {
      throw new AppError("validation_error", "orderedTripPlaceIds is required with custom order");
    }

    const normalizedDayId = dayId.toLowerCase();
    const beforeVersion = await this.dayVersion(userId, tripId, normalizedDayId);
    const [skeleton, places] = await Promise.all([
      this.tripSkeleton.getSkeleton(userId, tripId),
      this.tripPlaces.list(userId, tripId),
    ]);
    const version = await this.dayVersion(userId, tripId, normalizedDayId);
    if (version !== beforeVersion) {
      throw new AppError("conflict", "The day changed while its route was being read", 409, undefined, version, normalizedDayId);
    }
    const day = skeleton.days.find((entry) => entry.id === normalizedDayId);
    if (!day) throw new AppError("trip_day_not_found", "Trip day not found", 404);

    const planned = places
      .filter((place) => place.assignedDayId === normalizedDayId && !place.scheduled)
      .sort(byDayPosition);
    const requestedIds = order === "custom"
      ? input.orderedTripPlaceIds!.map((id) => typeof id === "string" ? id.toLowerCase() : "")
      : [];
    const requested = new Set(requestedIds);
    const plannedById = new Map(planned.map((place) => [place.id, place]));
    if (
      order === "custom"
      && (requested.size !== requestedIds.length || requestedIds.some((id) => !plannedById.has(id)))
    ) {
      throw new AppError("validation_error", "orderedTripPlaceIds must list distinct places from this day");
    }
    if ((order === "custom" ? requestedIds.length : planned.length) > MAX_DAY_ROUTE_STOPS) {
      throw new AppError("validation_error", `A route may contain at most ${MAX_DAY_ROUTE_STOPS} stops`);
    }

    // Snapshot freshness is checked above before membership validation can misclassify a race.
    // Lodging comes from the itinerary, whose places carry no Google ID; a wishlist entry backed by
    // the same itinerary place supplies one when the hotel was also added from Google.
    const lodgingOn = (date: string) => {
      const lodging = bookedLodgingForNight(skeleton, date);
      if (!lodging) return null;
      const providerPlaceId = places.find((place) => place.legacyPlaceId === lodging.id && place.providerPlaceId)
        ?.providerPlaceId ?? null;
      return { place: { ...lodging, providerPlaceId } };
    };
    return buildDayRoute({
      dayId: normalizedDayId,
      date: day.date,
      version,
      order,
      planned,
      ...(order === "custom" ? { orderedIds: requestedIds } : {}),
      morningLodging: lodgingOn(Temporal.PlainDate.from(day.date).subtract({ days: 1 }).toString()),
      nightLodging: lodgingOn(day.date),
    });
  }

  async applyOrder(
    userId: string,
    tripId: string,
    dayId: string,
    rawKey: string,
    input: ApplyDayPlaceOrderInput,
  ): Promise<DayPlaceOrderResponse> {
    const ids = Array.isArray(input.orderedTripPlaceIds) ? input.orderedTripPlaceIds : null;
    if (!ids || ids.length === 0 || ids.length > MAX_DAY_ROUTE_STOPS || ids.some((id) => typeof id !== "string" || !UUID.test(id))) {
      throw new AppError("validation_error", `orderedTripPlaceIds must contain 1 to ${MAX_DAY_ROUTE_STOPS} place IDs`);
    }
    const orderedTripPlaceIds = ids.map((id) => id.toLowerCase());
    if (new Set(orderedTripPlaceIds).size !== orderedTripPlaceIds.length) {
      throw new AppError("validation_error", "orderedTripPlaceIds cannot repeat a place");
    }
    const day = dayId.toLowerCase();
    const key = requireIdempotencyKey(rawKey);
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

  private async dayVersion(userId: string, tripId: string, dayId: string): Promise<number> {
    const member = await this.database.selectFrom("trip_members")
      .select("id")
      .where("trip_id", "=", tripId)
      .where("user_id", "=", userId)
      .where("removed_at", "is", null)
      .executeTakeFirst();
    if (!member) throw new AppError("trip_not_found", "Trip not found", 404);
    const day = await this.database.selectFrom("trip_days")
      .select("version")
      .where("trip_id", "=", tripId)
      .where("id", "=", dayId)
      .executeTakeFirst();
    if (!day) throw new AppError("trip_day_not_found", "Trip day not found", 404);
    return day.version;
  }
}
