import {
  parseNearbyActivitiesResponse,
  type NearbyActivitiesResponse,
} from "@along-the-way/contracts/trip-places";
import { sql, type Kysely } from "kysely";

import type { AlongTheWayDatabase } from "../database/database";
import { straightLineMeters } from "../planning/day-route-order";
import { AppError } from "../private-trips/private-trip-module";
import type {
  ClaimNearbyActivityLookup,
  FoundNearbyActivity,
  NearbyActivityModel,
  NearbyActivityModule,
  NearbyActivityQuery,
} from "./nearby-activity-module";

/** A stop's answer for a date is reused for the rest of the local day it was fetched on. */
function localDay(at: Date, timeZone: string | null) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timeZone ?? "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

interface Located {
  latitude: number;
  longitude: number;
}

export class PostgresNearbyActivityModule implements NearbyActivityModule {
  /** Concurrent taps on the same stop and date share one provider call. */
  private readonly flights = new Map<string, Promise<{ found: FoundNearbyActivity[]; fetchedAt: Date }>>();
  private readonly now: () => Date;

  constructor(private readonly options: {
    database: Kysely<AlongTheWayDatabase>;
    model: NearbyActivityModel;
    now?: () => Date;
  }) {
    this.now = options.now ?? (() => new Date());
  }

  async nearbyActivities(
    userId: string,
    tripId: string,
    rawDayId: string,
    rawTripPlaceId: string,
    claimLookup: ClaimNearbyActivityLookup,
  ): Promise<NearbyActivitiesResponse> {
    const { database } = this.options;
    const dayId = rawDayId.toLowerCase();
    const tripPlaceId = rawTripPlaceId.toLowerCase();
    const member = await database.selectFrom("trip_members").select("user_id")
      .where("trip_id", "=", tripId).where("user_id", "=", userId).where("removed_at", "is", null)
      .executeTakeFirst();
    if (!member) throw new AppError("trip_not_found", "Trip not found", 404);
    const day = await database.selectFrom("trip_days")
      .select(sql<string>`date::text`.as("date"))
      .where("trip_id", "=", tripId).where("id", "=", dayId)
      .executeTakeFirst();
    if (!day) throw new AppError("trip_day_not_found", "Trip day not found", 404);
    const stop = await database.selectFrom("trip_places as place")
      .leftJoin("trip_place_day_assignments as assignment", (join) => join
        .onRef("assignment.trip_id", "=", "place.trip_id")
        .onRef("assignment.trip_place_id", "=", "place.id"))
      .select([
        "place.name", "place.address", "place.latitude", "place.longitude", "place.time_zone",
        "assignment.trip_day_id",
      ])
      .where("place.trip_id", "=", tripId).where("place.id", "=", tripPlaceId)
      .where("place.archived_at", "is", null)
      .executeTakeFirst();
    if (!stop) throw new AppError("trip_place_not_found", "Trip place not found", 404);
    if (stop.trip_day_id !== dayId) {
      throw new AppError("conflict", "The stop is no longer on this day", 409, undefined, undefined, dayId);
    }
    const { latitude, longitude } = stop;
    if (latitude === null || longitude === null) {
      throw new AppError("activities_unsupported", "Nearby activities require the stop's coordinates", 422);
    }
    const located = { latitude, longitude };

    const countries = await database.selectFrom("trip_country_stops")
      .select(["country_code", "time_zone"])
      .where("trip_id", "=", tripId).orderBy("position").execute();
    const timeZone = stop.time_zone ?? null;
    const countryCodes = new Set(countries.map((country) => country.country_code));
    const country = countries.find((entry) => timeZone !== null && entry.time_zone === timeZone)
      ?? (countryCodes.size === 1 ? countries[0] : undefined);
    const cacheZone = timeZone ?? country?.time_zone ?? null;
    // What is happening near a stop does not change within the day: reuse the day's answer.
    const cached = await database.selectFrom("nearby_activity_results")
      .select(["results", "fetched_at"])
      .where("trip_place_id", "=", tripPlaceId).where("local_date", "=", sql<Date>`${day.date}::date`)
      .executeTakeFirst();
    if (cached && localDay(new Date(cached.fetched_at), cacheZone) === localDay(this.now(), cacheZone)) {
      const response = this.response(tripPlaceId, day.date, located, cached.results, cached.fetched_at);
      if (response) return response;
    }
    if (!this.options.model.available) {
      throw new AppError("activities_unavailable", "Nearby activities are not configured", 503);
    }

    const query: NearbyActivityQuery = {
      stopName: stop.name,
      address: stop.address,
      ...located,
      date: day.date,
      timeZone: timeZone ?? country?.time_zone ?? null,
      countryCode: country?.country_code ?? null,
    };
    const key = `${tripPlaceId}:${day.date}`;
    let flight = this.flights.get(key);
    if (!flight) {
      flight = this.lookup(tripId, tripPlaceId, query, claimLookup);
      this.flights.set(key, flight);
      const settled = flight;
      void settled.then(
        () => this.flights.get(key) === settled && this.flights.delete(key),
        () => this.flights.get(key) === settled && this.flights.delete(key),
      );
    }
    const { found, fetchedAt } = await flight;
    const response = this.response(tripPlaceId, day.date, located, found, fetchedAt);
    if (!response) throw new AppError("provider_unavailable", "Nearby activities are temporarily unavailable", 503);
    return response;
  }

  private async lookup(
    tripId: string,
    tripPlaceId: string,
    query: NearbyActivityQuery,
    claimLookup: ClaimNearbyActivityLookup,
  ) {
    await claimLookup();
    let found: FoundNearbyActivity[];
    try {
      found = await this.options.model.find(query);
    } catch {
      throw new AppError("provider_unavailable", "Nearby activities are temporarily unavailable", 503);
    }
    const fetchedAt = this.now();
    const results = JSON.stringify(found);
    await this.options.database.insertInto("nearby_activity_results").values({
      trip_id: tripId,
      trip_place_id: tripPlaceId,
      local_date: query.date,
      results,
      fetched_at: fetchedAt,
    }).onConflict((conflict) => conflict.columns(["trip_place_id", "local_date"])
      .doUpdateSet({ results, fetched_at: fetchedAt }))
      .execute();
    return { found, fetchedAt };
  }

  /** Adds each venue's straight-line distance from the stop; null when a stored answer no longer parses. */
  private response(
    stopTripPlaceId: string,
    date: string,
    stop: Located,
    found: unknown,
    fetchedAt: Date,
  ): NearbyActivitiesResponse | null {
    if (!Array.isArray(found)) return null;
    try {
      return parseNearbyActivitiesResponse({
        stopTripPlaceId,
        date,
        fetchedAt: fetchedAt.toISOString(),
        activities: found.map((activity: Record<string, unknown>) => {
          const { latitude, longitude } = activity;
          return {
            ...activity,
            straightLineMeters: typeof latitude === "number" && typeof longitude === "number"
              ? Math.round(straightLineMeters({ id: stopTripPlaceId, ...stop }, { id: "venue", latitude, longitude }))
              : null,
          };
        }),
      });
    } catch {
      return null;
    }
  }
}
