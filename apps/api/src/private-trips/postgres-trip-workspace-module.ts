import {
  inferCountryRoute,
  MAX_TRIP_COUNTRY_STOPS,
} from "@along-the-way/contracts/countries";
import { parseTripResponse } from "@along-the-way/contracts/private-trips";
import { sql, type Kysely } from "kysely";

import type { AlongTheWayDatabase } from "../database/database";
import {
  AppError,
  type CreateTripInput,
  type TripReadModel,
  type TripSummaryReadModel,
  type TripWorkspaceModule,
} from "./private-trip-module";
import {
  dateOnly,
  type DatabaseExecutor,
  inviteStatus,
  isoTimestamp,
  lockMutation,
  parseDateOnly,
  recordEvent,
  remember,
  replayed,
  requireIdempotencyKey,
} from "./postgres-private-trip-store";

interface ModuleOptions {
  database: Kysely<AlongTheWayDatabase>;
  now?: () => Date;
}

function validateTripInput(input: CreateTripInput) {
  const name = input.name.trim();
  if (input.countryCodes.length === 0) {
    throw new AppError("validation_error", "At least one country is required");
  }
  if (input.countryCodes.length > MAX_TRIP_COUNTRY_STOPS) {
    throw new AppError(
      "validation_error",
      `A trip can have at most ${MAX_TRIP_COUNTRY_STOPS} country stops`,
    );
  }
  const countryCodes = input.countryCodes.map((value) =>
    value.trim().toUpperCase(),
  );
  const start = parseDateOnly(input.startDate, "startDate");
  const end = parseDateOnly(input.endDate, "endDate");

  if (!name || name.length > 200) {
    throw new AppError("validation_error", "Trip name is required");
  }
  if (end < start) {
    throw new AppError("validation_error", "endDate must not precede startDate");
  }
  const dayCount = Math.floor((end.valueOf() - start.valueOf()) / 86_400_000) + 1;
  if (dayCount > 366) {
    throw new AppError("validation_error", "A trip cannot exceed 366 days");
  }
  for (let index = 1; index < countryCodes.length; index += 1) {
    if (countryCodes[index] === countryCodes[index - 1]) {
      throw new AppError(
        "adjacent_country_stops",
        "Adjacent country stops must be different",
      );
    }
  }

  const route = inferCountryRoute(countryCodes);
  if (!route) {
    throw new AppError("validation_error", "countryCodes contains an unknown country");
  }

  const countryStops = route.countries.map((country, position) => ({
    countryCode: country.code,
    position,
    timeZone: country.timeZones.length === 1 ? country.timeZones[0]! : null,
  }));
  const stopTimeZones = new Set(
    countryStops.flatMap((stop) => (stop.timeZone ? [stop.timeZone] : [])),
  );
  const sharedTimeZone =
    countryStops.every((stop) => stop.timeZone !== null) &&
    stopTimeZones.size === 1
      ? (stopTimeZones.values().next().value ?? null)
      : null;

  return {
    name,
    startDate: input.startDate,
    endDate: input.endDate,
    countryStops,
    defaultCurrency: route.defaultCurrency,
    compatibilityTimeZone: sharedTimeZone ?? "",
    compatibilityCurrency: route.defaultCurrency ?? "",
    dayCount,
  };
}

function replayedTrip(value: unknown) {
  try {
    return parseTripResponse({ trip: value }).trip;
  } catch {
    throw new AppError("conflict", "Stored mutation result is invalid", 409);
  }
}

export class PostgresTripWorkspaceModule implements TripWorkspaceModule {
  private readonly database: Kysely<AlongTheWayDatabase>;
  private readonly now: () => Date;

  constructor(options: ModuleOptions) {
    this.database = options.database;
    this.now = options.now ?? (() => new Date());
  }

  async listTrips(userId: string): Promise<TripSummaryReadModel[]> {
    const result = await sql<{
      id: string;
      name: string;
      startDate: Date | string;
      endDate: Date | string;
      defaultCurrency: string | null;
      role: "owner" | "editor";
      memberCount: string | number;
      dayCount: string | number;
      countryStops: Array<{
        id: string;
        countryCode: string;
        position: number;
        timeZone: string | null;
      }>;
    }>`
      select
        trips.id,
        trips.name,
        trips.start_date as "startDate",
        trips.end_date as "endDate",
        trips.default_currency as "defaultCurrency",
        trip_members.role,
        (select count(*) from trip_members members
          where members.trip_id = trips.id and members.removed_at is null) as "memberCount",
        (select count(*) from trip_days where trip_days.trip_id = trips.id) as "dayCount",
        coalesce((select jsonb_agg(jsonb_build_object(
          'id', id,
          'countryCode', country_code,
          'position', position,
          'timeZone', time_zone
        ) order by position)
          from trip_country_stops where trip_country_stops.trip_id = trips.id), '[]'::jsonb) as "countryStops"
      from trips
      join trip_members on trip_members.trip_id = trips.id
      where trip_members.user_id = ${userId}
        and trip_members.removed_at is null
      order by trips.start_date, trips.created_at
    `.execute(this.database);

    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      startDate: dateOnly(row.startDate),
      endDate: dateOnly(row.endDate),
      defaultCurrency: row.defaultCurrency,
      countryStops: row.countryStops,
      memberCount: Number(row.memberCount),
      dayCount: Number(row.dayCount),
      role: row.role,
    }));
  }

  async createTrip(
    userId: string,
    rawKey: string,
    input: CreateTripInput,
  ): Promise<TripReadModel> {
    const key = requireIdempotencyKey(rawKey);
    const validated = validateTripInput(input);

    return this.database.transaction().execute(async (transaction) => {
      await lockMutation(transaction, userId, "create_trip", key);
      const replay = await replayed(transaction, userId, "create_trip", key);
      if (replay) return replayedTrip(replay);

      const trip = await transaction
        .insertInto("trips")
        .values({
          name: validated.name,
          start_date: validated.startDate,
          end_date: validated.endDate,
          // Retained only so the previous release can read rows after rollback.
          // Empty strings mean unknown; the current API never exposes these columns.
          time_zone: validated.compatibilityTimeZone,
          currency: validated.compatibilityCurrency,
          default_currency: validated.defaultCurrency,
          status: "planning",
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      await transaction
        .insertInto("trip_country_stops")
        .values(
          validated.countryStops.map((stop) => ({
            trip_id: trip.id,
            country_code: stop.countryCode,
            position: stop.position,
            time_zone: stop.timeZone,
          })),
        )
        .execute();

      const days: Array<{ trip_id: string; date: string; title: null }> = [];
      const cursor = parseDateOnly(validated.startDate, "startDate");
      for (let index = 0; index < validated.dayCount; index += 1) {
        days.push({
          trip_id: trip.id,
          date: cursor.toISOString().slice(0, 10),
          title: null,
        });
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
      await transaction.insertInto("trip_days").values(days).execute();
      await transaction
        .insertInto("trip_members")
        .values({
          trip_id: trip.id,
          user_id: userId,
          role: "owner",
          removed_at: null,
        })
        .execute();
      await recordEvent(transaction, {
        tripId: trip.id,
        actorId: userId,
        eventType: "trip.created",
        targetType: "trip",
        targetId: trip.id,
        summary: "Created a trip",
      });

      const response = await this.readTrip(transaction, userId, trip.id);
      await remember(transaction, userId, "create_trip", key, response);
      return response;
    });
  }

  async getTrip(userId: string, tripId: string) {
    return this.readTrip(this.database, userId, tripId);
  }

  private async readTrip(
    executor: DatabaseExecutor,
    userId: string,
    tripId: string,
  ): Promise<TripReadModel> {
    const trip = await executor
      .selectFrom("trips")
      .innerJoin("trip_members", "trip_members.trip_id", "trips.id")
      .select([
        "trips.id",
        "trips.name",
        "trips.start_date",
        "trips.end_date",
        "trips.default_currency",
        "trips.version",
        "trip_members.role",
      ])
      .where("trips.id", "=", tripId)
      .where("trip_members.user_id", "=", userId)
      .where("trip_members.removed_at", "is", null)
      .executeTakeFirst();
    if (!trip) throw new AppError("trip_not_found", "Trip not found", 404);

    const countryStops = await executor
      .selectFrom("trip_country_stops")
      .select(["id", "country_code", "position", "time_zone"])
      .where("trip_id", "=", tripId)
      .orderBy("position")
      .execute();
    const days = await executor
      .selectFrom("trip_days")
      .select(["id", "date", "title"])
      .where("trip_id", "=", tripId)
      .orderBy("date")
      .execute();
    const members = await executor
      .selectFrom("trip_members")
      .innerJoin("users", "users.id", "trip_members.user_id")
      .select([
        "trip_members.id",
        "users.id as userId",
        "users.email",
        "users.display_name as displayName",
        "trip_members.role",
      ])
      .where("trip_members.trip_id", "=", tripId)
      .where("trip_members.removed_at", "is", null)
      .orderBy("trip_members.joined_at")
      .execute();
    const invites = await executor
      .selectFrom("invites")
      .select([
        "id",
        "email",
        "role",
        "expires_at",
        "accepted_at",
        "revoked_at",
      ])
      .where("trip_id", "=", tripId)
      .orderBy("created_at")
      .execute();
    const now = this.now();

    return {
      id: trip.id,
      name: trip.name,
      startDate: dateOnly(trip.start_date),
      endDate: dateOnly(trip.end_date),
      defaultCurrency: trip.default_currency,
      countryStops: countryStops.map((stop) => ({
        id: stop.id,
        countryCode: stop.country_code,
        position: stop.position,
        timeZone: stop.time_zone,
      })),
      days: days.map((day) => ({
        id: day.id,
        date: dateOnly(day.date),
        title: day.title,
      })),
      members,
      invites: invites.map((invite) => ({
        id: invite.id,
        email: invite.email,
        role: "editor",
        expiresAt: isoTimestamp(invite.expires_at),
        status: inviteStatus(invite, now),
      })),
      memberCount: members.length,
      dayCount: days.length,
      role: trip.role,
      version: trip.version,
    };
  }
}
