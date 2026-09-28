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

const ISO_CURRENCIES = new Set(Intl.supportedValuesOf("currency"));

interface ModuleOptions {
  database: Kysely<AlongTheWayDatabase>;
  now?: () => Date;
}

function validateTripInput(input: CreateTripInput) {
  const name = input.name.trim();
  const destinations = input.destinations.map((value) => value.trim()).filter(Boolean);
  const timeZone = input.timeZone.trim();
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
  if (destinations.length === 0 || destinations.some((value) => value.length > 160)) {
    throw new AppError("validation_error", "At least one destination is required");
  }
  if (!timeZone || timeZone.startsWith("+") || timeZone.startsWith("-")) {
    throw new AppError("validation_error", "timeZone must be a named IANA time zone");
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(start);
  } catch {
    throw new AppError("validation_error", "timeZone must be a named IANA time zone");
  }
  const currency = input.currency.trim().toUpperCase();
  if (!ISO_CURRENCIES.has(currency)) {
    throw new AppError("validation_error", "currency must be a valid ISO 4217 code");
  }

  return {
    name,
    startDate: input.startDate,
    endDate: input.endDate,
    timeZone,
    currency,
    destinations,
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
      timeZone: string;
      currency: string;
      role: "owner" | "editor";
      memberCount: string | number;
      dayCount: string | number;
      destinations: string[];
    }>`
      select
        trips.id,
        trips.name,
        trips.start_date as "startDate",
        trips.end_date as "endDate",
        trips.time_zone as "timeZone",
        trips.currency,
        trip_members.role,
        (select count(*) from trip_members members
          where members.trip_id = trips.id and members.removed_at is null) as "memberCount",
        (select count(*) from trip_days where trip_days.trip_id = trips.id) as "dayCount",
        coalesce((select jsonb_agg(name order by position)
          from trip_destinations where trip_destinations.trip_id = trips.id), '[]'::jsonb) as destinations
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
      timeZone: row.timeZone,
      currency: row.currency,
      destinations: row.destinations,
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
          time_zone: validated.timeZone,
          currency: validated.currency,
          status: "planning",
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      await transaction
        .insertInto("trip_destinations")
        .values(
          validated.destinations.map((name, position) => ({
            trip_id: trip.id,
            name,
            position,
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
        "trips.time_zone",
        "trips.currency",
        "trips.version",
        "trip_members.role",
      ])
      .where("trips.id", "=", tripId)
      .where("trip_members.user_id", "=", userId)
      .where("trip_members.removed_at", "is", null)
      .executeTakeFirst();
    if (!trip) throw new AppError("trip_not_found", "Trip not found", 404);

    const destinations = await executor
      .selectFrom("trip_destinations")
      .select("name")
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
      timeZone: trip.time_zone,
      currency: trip.currency,
      destinations: destinations.map((destination) => destination.name),
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
