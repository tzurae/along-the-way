import {
  parseItineraryItemResponse,
  parsePlaceResponse,
  type ConstraintDto,
  type ConstraintInput,
  type CreateItineraryItemInput,
  type CreatePlaceInput,
  type ItineraryItemDto,
  type ItineraryItemDetails,
  type ItineraryItemType,
  type PlaceDto,
  type PlaceType,
  type PlaceLocationStatus,
  type TimelineDayDto,
  type TripSkeletonDto,
  type UpdateItineraryItemInput,
  type UpdatePlaceInput,
  type ZonedEndpointDto,
} from "@along-the-way/contracts/trip-skeleton";
import { sql, type Kysely, type Transaction } from "kysely";

import type { AlongTheWayDatabase } from "../database/database";
import { AppError } from "../private-trips/private-trip-module";
import {
  dateOnly,
  isoTimestamp,
  lockMutation,
  recordEvent,
  remember,
  replayed,
  requireIdempotencyKey,
  type DatabaseExecutor,
} from "../private-trips/postgres-private-trip-store";
import { suggestPossibleTripPlaceDuplicates } from "../trip-places/postgres-trip-place-module";
import type { TripSkeletonModule } from "./trip-skeleton-module";
import {
  canonicalNamedTimeZone,
  resolveEndpoint,
  type ResolvedEndpoint,
} from "./zoned-endpoint";

interface ModuleOptions {
  database: Kysely<AlongTheWayDatabase>;
  now?: () => Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_CURRENCIES = new Set(Intl.supportedValuesOf("currency"));

function requiredText(value: string, name: string, maxLength: number) {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new AppError("validation_error", `${name} is required and must be at most ${maxLength} characters`);
  }
  return normalized;
}

function optionalText(value: string | null | undefined, name: string, maxLength: number) {
  if (value === null || value === undefined || value.trim() === "") return null;
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new AppError("validation_error", `${name} must be at most ${maxLength} characters`);
  }
  return normalized;
}

function optionalUrl(value: string | null | undefined) {
  const normalized = optionalText(value, "sourceUrl", 2_000);
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
    return url.toString();
  } catch {
    throw new AppError("validation_error", "sourceUrl must be an HTTP or HTTPS URL");
  }
}


function placeLocationStatus(place: {
  latitude: number | null;
  longitude: number | null;
  timeZone: string | null;
}): PlaceLocationStatus {
  if (place.latitude === null || place.longitude === null) return "coordinates_missing";
  if (place.timeZone === null) return "timezone_missing";
  return "complete";
}

function placeType(value: unknown): PlaceType {
  if (
    value === "airport" ||
    value === "station" ||
    value === "lodging" ||
    value === "restaurant" ||
    value === "activity" ||
    value === "other"
  ) {
    return value;
  }
  throw new AppError("validation_error", "Unknown place type");
}

function validatePlace(input: CreatePlaceInput) {
  const latitude = input.latitude ?? null;
  const longitude = input.longitude ?? null;
  if ((latitude === null) !== (longitude === null)) {
    throw new AppError("validation_error", "latitude and longitude must be provided together");
  }
  if (latitude !== null && (!Number.isFinite(latitude) || latitude < -90 || latitude > 90)) {
    throw new AppError("validation_error", "latitude must be between -90 and 90");
  }
  if (longitude !== null && (!Number.isFinite(longitude) || longitude < -180 || longitude > 180)) {
    throw new AppError("validation_error", "longitude must be between -180 and 180");
  }
  const suppliedTimeZone = optionalText(input.timeZone, "timeZone", 100);
  const timeZone = suppliedTimeZone
    ? canonicalNamedTimeZone(suppliedTimeZone)
    : null;
  if (suppliedTimeZone && !timeZone) {
    throw new AppError("validation_error", "timeZone must be a named IANA time zone");
  }
  return {
    name: requiredText(input.name, "name", 200),
    type: placeType(input.type),
    address: optionalText(input.address, "address", 2_000),
    latitude,
    longitude,
    timeZone,
    sourceUrl: optionalUrl(input.sourceUrl),
    notes: optionalText(input.notes, "notes", 10_000),
  };
}

function validateConstraint(input: ConstraintInput) {
  if (
    input.type !== "fixed_time" &&
    input.type !== "immovable" &&
    input.type !== "minimum_buffer"
  ) {
    throw new AppError("validation_error", "Unknown constraint type");
  }
  if (input.status !== "confirmed" && input.status !== "unknown" && input.status !== "conflicted") {
    throw new AppError("validation_error", "Unknown constraint status");
  }
  const minimumBufferMinutes = input.minimumBufferMinutes ?? null;
  if (input.type === "minimum_buffer") {
    if (!Number.isSafeInteger(minimumBufferMinutes) || minimumBufferMinutes! < 0) {
      throw new AppError("validation_error", "minimumBufferMinutes must be a non-negative integer");
    }
  } else if (minimumBufferMinutes !== null) {
    throw new AppError("validation_error", "Only minimum-buffer constraints accept minutes");
  }
  return { type: input.type, status: input.status, minimumBufferMinutes };
}

function validateUuid(value: string, name: string) {
  if (!UUID.test(value)) throw new AppError("validation_error", `${name} must be a UUID`);
  return value;
}

function validateMoney(input: CreateItineraryItemInput["money"]) {
  if (input === null || input === undefined) return null;
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 0) {
    throw new AppError("validation_error", "amountMinor must be a non-negative safe integer");
  }
  if (typeof input.currency !== "string") {
    throw new AppError("validation_error", "currency must be an ISO 4217 code");
  }
  const currency = input.currency.trim().toUpperCase();
  if (!ISO_CURRENCIES.has(currency)) {
    throw new AppError("validation_error", "currency must be an ISO 4217 code");
  }
  return { amountMinor: input.amountMinor, currency };
}

function itemType(value: unknown): ItineraryItemType {
  if (
    value === "flight" ||
    value === "lodging" ||
    value === "transport" ||
    value === "reservation" ||
    value === "meal" ||
    value === "activity" ||
    value === "free-time"
  ) {
    return value;
  }
  throw new AppError("validation_error", "Unknown itinerary item type");
}

function detailRecord(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppError("validation_error", "details must be an object");
  }
  return value as Record<string, unknown>;
}

function detailText(
  value: unknown,
  name: string,
  maxLength: number,
  required: true,
): string;
function detailText(
  value: unknown,
  name: string,
  maxLength: number,
  required: false,
): string | null;
function detailText(
  value: unknown,
  name: string,
  maxLength: number,
  required: boolean,
) {
  if (value === null || value === undefined || value === "") {
    if (required) throw new AppError("validation_error", `${name} is required`);
    return null;
  }
  if (typeof value !== "string") {
    throw new AppError("validation_error", `${name} must be text`);
  }
  return required
    ? requiredText(value, name, maxLength)
    : optionalText(value, name, maxLength);
}

function positiveDuration(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new AppError("validation_error", "durationMinutes must be a positive integer");
  }
  return value as number;
}

function itemDetails(
  type: ItineraryItemType,
  value: unknown,
): ItineraryItemDetails {
  const details = detailRecord(value);
  switch (type) {
    case "flight":
      return {
        carrier: detailText(details.carrier, "carrier", 200, false),
        serviceNumber: detailText(details.serviceNumber, "serviceNumber", 100, true),
        confirmationNotes: detailText(
          details.confirmationNotes,
          "confirmationNotes",
          2_000,
          false,
        ),
      };
    case "lodging":
      return {
        bookedBy: detailText(details.bookedBy, "bookedBy", 200, false),
        confirmationCode: detailText(
          details.confirmationCode,
          "confirmationCode",
          500,
          false,
        ),
      };
    case "transport":
      return {
        mode: detailText(details.mode, "mode", 100, true),
        ticketInfo: detailText(details.ticketInfo, "ticketInfo", 2_000, false),
      };
    case "reservation":
    case "meal":
    case "activity":
      return {
        durationMinutes: positiveDuration(details.durationMinutes),
        bookedBy: detailText(details.bookedBy, "bookedBy", 200, false),
        confirmationStatus: detailText(
          details.confirmationStatus,
          "confirmationStatus",
          200,
          false,
        ),
      };
    case "free-time":
      return { durationMinutes: positiveDuration(details.durationMinutes) };
  }
}

function replayedPlace(value: unknown) {
  try {
    return parsePlaceResponse({ place: value }).place;
  } catch {
    throw new AppError("conflict", "Stored mutation result is invalid", 409);
  }
}

function replayedItem(value: unknown) {
  try {
    return parseItineraryItemResponse({ item: value }).item;
  } catch {
    throw new AppError("conflict", "Stored mutation result is invalid", 409);
  }
}

export class PostgresTripSkeletonModule implements TripSkeletonModule {
  private readonly database: Kysely<AlongTheWayDatabase>;
  private readonly now: () => Date;

  constructor(options: ModuleOptions) {
    this.database = options.database;
    this.now = options.now ?? (() => new Date());
  }

  async getSkeleton(userId: string, tripId: string): Promise<TripSkeletonDto> {
    return this.database
      .transaction()
      .setIsolationLevel("repeatable read")
      .execute((transaction) => this.readSkeleton(transaction, userId, tripId));
  }

  private async readSkeleton(
    executor: DatabaseExecutor,
    userId: string,
    tripId: string,
  ): Promise<TripSkeletonDto> {
    await this.requireMember(executor, userId, tripId);
    const [trip, places, items, dayRows, eventRows] = await Promise.all([
      executor.selectFrom("trips").select("version").where("id", "=", tripId).executeTakeFirstOrThrow(),
      this.readPlaces(executor, tripId),
      this.readItems(executor, tripId),
      executor
        .selectFrom("trip_days")
        .select(["id", "date"])
        .where("trip_id", "=", tripId)
        .orderBy("date")
        .execute(),
      executor
        .selectFrom("change_events")
        .select([
          "id",
          "actor_id",
          "event_type",
          "target_type",
          "target_id",
          "summary",
          "created_at",
        ])
        .where("trip_id", "=", tripId)
        .orderBy("created_at", "desc")
        .limit(100)
        .execute(),
    ]);
    const dayByDate = new Map<string, TimelineDayDto>();
    const days = dayRows.map((day) => {
      const value: TimelineDayDto = { id: day.id, date: dateOnly(day.date), entries: [] };
      dayByDate.set(value.date, value);
      return value;
    });
    for (const item of items) {
      const start = item.endpoints.find((endpoint) => endpoint.role === "start");
      if (!start) continue;
      const startDate = start.localDateTime.slice(0, 10);
      dayByDate.get(startDate)?.entries.push({
        itemId: item.id,
        projection: "full",
        sortInstant: start.instant,
      });
      const end = item.endpoints.find((endpoint) => endpoint.role === "end");
      const endDate = end?.localDateTime.slice(0, 10);
      if (end && endDate !== startDate) {
        dayByDate.get(endDate!)?.entries.push({
          itemId: item.id,
          projection: "continuation",
          sortInstant: end.instant,
        });
      }
    }
    for (const day of days) {
      day.entries.sort((left, right) => left.sortInstant.localeCompare(right.sortInstant));
    }
    return {
      tripVersion: trip.version,
      places,
      items,
      days,
      tripInformationItemIds: items
        .filter(
          (item) =>
            item.type === "flight" ||
            item.type === "lodging" ||
            item.type === "transport",
        )
        .map((item) => item.id),
      events: eventRows.map((event) => ({
        id: event.id,
        actorId: event.actor_id,
        eventType: event.event_type,
        targetType: event.target_type,
        targetId: event.target_id,
        summary: event.summary,
        createdAt: isoTimestamp(event.created_at),
      })),
    };
  }

  async createPlace(
    userId: string,
    tripId: string,
    rawKey: string,
    expectedTripVersion: number,
    input: CreatePlaceInput,
  ) {
    const key = requireIdempotencyKey(rawKey);
    const place = validatePlace(input);
    const operation = `create_place:${tripId}`;
    return this.database.transaction().execute(async (transaction) => {
      await this.requireMemberForMutation(transaction, userId, tripId);
      await lockMutation(transaction, userId, operation, key);
      const replay = await replayed(transaction, userId, operation, key);
      if (replay) return replayedPlace(replay);
      await this.incrementTripVersion(transaction, tripId, expectedTripVersion);
      const created = await transaction
        .insertInto("places")
        .values({
          trip_id: tripId,
          name: place.name,
          place_type: place.type,
          address: place.address,
          latitude: place.latitude,
          longitude: place.longitude,
          time_zone: place.timeZone,
          source_url: place.sourceUrl,
          notes: place.notes,
          created_by: userId,
        })
        .returning(["id", "version"])
        .executeTakeFirstOrThrow();
      await transaction.insertInto("place_identities").values({
        id: created.id,
        provider: "manual",
        provider_place_id: null,
        canonical_name: place.name,
        canonical_type: place.type,
        canonical_address: place.address,
        latitude: place.latitude,
        longitude: place.longitude,
        time_zone: place.timeZone,
        provider_observed_at: null,
        provider_expires_at: null,
        provider_attribution: null,
      }).execute();
      await transaction.insertInto("trip_places").values({
        id: created.id,
        trip_id: tripId,
        place_id: created.id,
        legacy_place_id: created.id,
        legacy_place_version: created.version,
        facts_source: "member",
        name: place.name,
        place_type: place.type,
        address: place.address,
        latitude: place.latitude,
        longitude: place.longitude,
        time_zone: place.timeZone,
        duration_minutes: null,
        budget_amount_minor: null,
        budget_currency: null,
        notes: place.notes,
        provider_unavailable: false,
        archived_at: null,
        created_by: userId,
      }).execute();
      await transaction.insertInto("trip_place_contributions").values({
        trip_id: tripId,
        trip_place_id: created.id,
        member_user_id: userId,
        intake_method: "manual",
        source_url: place.sourceUrl,
        original_note: place.notes,
        provider_observed_at: null,
        withdrawn_at: null,
      }).execute();
      await suggestPossibleTripPlaceDuplicates(
        transaction,
        tripId,
        created.id,
        place,
      );
      const response = await this.readPlace(transaction, tripId, created.id);
      await recordEvent(transaction, {
        tripId,
        actorId: userId,
        eventType: "place.created",
        targetType: "place",
        targetId: response.id,
        summary: "Created a place",
      });
      await remember(transaction, userId, operation, key, response);
      return response;
    });
  }

  async updatePlace(
    userId: string,
    tripId: string,
    placeId: string,
    rawKey: string,
    input: UpdatePlaceInput,
  ) {
    const key = requireIdempotencyKey(rawKey);
    const operation = `pu:${tripId}:${placeId}`;
    const place = validatePlace(input);
    return this.database.transaction().execute(async (transaction) => {
      await this.requireMemberForMutation(transaction, userId, tripId);
      await lockMutation(transaction, userId, operation, key);
      const replay = await replayed(transaction, userId, operation, key);
      if (replay) return replayedPlace(replay);
      const current = await transaction.selectFrom("places")
        .select("version")
        .where("trip_id", "=", tripId)
        .where("id", "=", placeId)
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw new AppError("place_not_found", "Place not found", 404);
      this.requireExpectedVersion(current.version, input.expectedVersion);
      const lockedReference = await transaction
        .selectFrom("itinerary_endpoints as endpoint")
        .innerJoin("itinerary_items as item", "item.id", "endpoint.itinerary_item_id")
        .select("item.id")
        .where("endpoint.trip_id", "=", tripId)
        .where("endpoint.place_id", "=", placeId)
        .where("item.locked_at", "is not", null)
        .executeTakeFirst();
      if (lockedReference) {
        throw new AppError(
          "item_locked",
          "Unlock every item that references this Place before editing it",
          409,
        );
      }
      const updated = await transaction
        .updateTable("places")
        .set({
          name: place.name,
          place_type: place.type,
          address: place.address,
          latitude: place.latitude,
          longitude: place.longitude,
          time_zone: place.timeZone,
          source_url: place.sourceUrl,
          notes: place.notes,
          version: sql`version + 1`,
          updated_at: this.now(),
        })
        .where("trip_id", "=", tripId)
        .where("id", "=", placeId)
        .where("version", "=", input.expectedVersion)
        .returning(["id", "version"])
        .executeTakeFirst();
      if (!updated) await this.throwPlaceConflict(transaction, tripId, placeId);
      const tripPlace = await transaction.selectFrom("trip_places")
        .select(["id", "place_id"])
        .where("trip_id", "=", tripId)
        .where("legacy_place_id", "=", placeId)
        .executeTakeFirst();
      if (tripPlace) {
        await transaction.updateTable("trip_places").set({
          name: place.name,
          place_type: place.type,
          address: place.address,
          latitude: place.latitude,
          longitude: place.longitude,
          time_zone: place.timeZone,
          notes: place.notes,
          legacy_place_version: updated!.version,
          facts_source: "member",
          version: sql`version + 1`,
          updated_at: this.now(),
        }).where("id", "=", tripPlace.id).execute();
        await transaction.updateTable("place_identities").set({
          canonical_name: place.name,
          canonical_type: place.type,
          canonical_address: place.address,
          latitude: place.latitude,
          longitude: place.longitude,
          time_zone: place.timeZone,
          updated_at: this.now(),
        }).where("id", "=", tripPlace.place_id)
          .where("provider", "=", "manual").execute();
      }
      const response = await this.readPlace(transaction, tripId, placeId);
      await recordEvent(transaction, {
        tripId,
        actorId: userId,
        eventType: "place.updated",
        targetType: "place",
        targetId: placeId,
        summary: "Updated a place",
      });
      await remember(transaction, userId, operation, key, response);
      return response;
    });
  }

  async deletePlace(
    userId: string,
    tripId: string,
    placeId: string,
    rawKey: string,
    expectedVersion: number,
  ) {
    const key = requireIdempotencyKey(rawKey);
    const operation = `pd:${tripId}:${placeId}`;
    await this.database.transaction().execute(async (transaction) => {
      await this.requireMemberForMutation(transaction, userId, tripId);
      await lockMutation(transaction, userId, operation, key);
      const replay = await replayed(transaction, userId, operation, key);
      if (replay) return;
      const current = await transaction
        .selectFrom("places")
        .select("version")
        .where("trip_id", "=", tripId)
        .where("id", "=", placeId)
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw new AppError("place_not_found", "Place not found", 404);
      this.requireExpectedVersion(current.version, expectedVersion);
      const tripPlace = await transaction.selectFrom("trip_places")
        .select(["id", "place_id"])
        .where("trip_id", "=", tripId)
        .where("legacy_place_id", "=", placeId)
        .executeTakeFirst();
      if (tripPlace) {
        const [retainedByAnotherMember, activeContributions, activePreference] = await Promise.all([
          transaction.selectFrom("trip_place_contributions")
            .select("id")
            .where("trip_place_id", "=", tripPlace.id)
            .where("member_user_id", "!=", userId)
            .where("withdrawn_at", "is", null)
            .executeTakeFirst(),
          transaction.selectFrom("trip_place_contributions")
            .select((builder) => builder.fn.countAll().as("count"))
            .where("trip_place_id", "=", tripPlace.id)
            .where("withdrawn_at", "is", null)
            .executeTakeFirstOrThrow(),
          transaction.selectFrom("member_place_preferences as preference")
            .innerJoin("trip_members as member", "member.user_id", "preference.member_user_id")
            .select("preference.member_user_id")
            .where("preference.trip_place_id", "=", tripPlace.id)
            .where("member.trip_id", "=", tripId)
            .where("member.removed_at", "is", null)
            .executeTakeFirst(),
        ]);
        if (
          retainedByAnotherMember ||
          Number(activeContributions.count) > 1 ||
          activePreference
        ) {
          throw new AppError(
            "place_in_use",
            "A member still retains this place",
            409,
          );
        }
      }
      const referenced = await transaction
        .selectFrom("itinerary_endpoints")
        .select((builder) => builder.fn.countAll().as("count"))
        .where("trip_id", "=", tripId)
        .where("place_id", "=", placeId)
        .executeTakeFirstOrThrow();
      if (Number(referenced.count) > 0) {
        throw new AppError("place_in_use", "A referenced place cannot be deleted", 409);
      }
      await transaction
        .deleteFrom("places")
        .where("trip_id", "=", tripId)
        .where("id", "=", placeId)
        .execute();
      await recordEvent(transaction, {
        tripId,
        actorId: userId,
        eventType: "place.deleted",
        targetType: "place",
        targetId: placeId,
        summary: "Deleted a place",
      });
      await remember(transaction, userId, operation, key, { deleted: true });
    });
  }

  async createItem(
    userId: string,
    tripId: string,
    rawKey: string,
    expectedTripVersion: number,
    input: CreateItineraryItemInput,
  ) {
    const key = requireIdempotencyKey(rawKey);
    const operation = `create_itinerary_item:${tripId}`;
    return this.database.transaction().execute(async (transaction) => {
      await this.requireMemberForMutation(transaction, userId, tripId);
      await lockMutation(transaction, userId, operation, key);
      const replay = await replayed(transaction, userId, operation, key);
      if (replay) return replayedItem(replay);
      await this.incrementTripVersion(transaction, tripId, expectedTripVersion);
      const validated = await this.validateItem(transaction, tripId, input);
      const created = await transaction
        .insertInto("itinerary_items")
        .values({
          trip_id: tripId,
          item_type: validated.type,
          title: validated.title,
          notes: validated.notes,
          source_url: validated.sourceUrl,
          amount_minor: validated.money?.amountMinor ?? null,
          currency: validated.money?.currency ?? null,
          details: validated.details,
          locked_at: null,
          locked_by: null,
          created_by: userId,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await this.replaceEndpoints(transaction, tripId, created.id, validated.endpoints);
      if (validated.constraints.length > 0) {
        await transaction.insertInto("itinerary_constraints").values(
          validated.constraints.map((constraint) => ({
            trip_id: tripId,
            itinerary_item_id: created.id,
            constraint_type: constraint.type,
            status: constraint.status,
            minimum_buffer_minutes: constraint.minimumBufferMinutes,
            created_by: userId,
          })),
        ).execute();
      }
      const response = await this.readItem(transaction, tripId, created.id);
      await recordEvent(transaction, {
        tripId,
        actorId: userId,
        eventType: "itinerary_item.created",
        targetType: "itinerary_item",
        targetId: created.id,
        summary: `Created a ${validated.type} itinerary item`,
      });
      await remember(transaction, userId, operation, key, response);
      return response;
    });
  }

  async updateItem(
    userId: string,
    tripId: string,
    itemId: string,
    rawKey: string,
    input: UpdateItineraryItemInput,
  ) {
    const key = requireIdempotencyKey(rawKey);
    const operation = `iu:${tripId}:${itemId}`;
    return this.database.transaction().execute(async (transaction) => {
      await this.requireMemberForMutation(transaction, userId, tripId);
      await lockMutation(transaction, userId, operation, key);
      const replay = await replayed(transaction, userId, operation, key);
      if (replay) return replayedItem(replay);
      const current = await this.lockItemRow(transaction, tripId, itemId);
      this.requireExpectedVersion(current.version, input.expectedVersion);
      this.requireUnlocked(current.locked_at);
      const validated = await this.validateItem(transaction, tripId, input);
      await transaction
        .updateTable("itinerary_items")
        .set({
          item_type: validated.type,
          title: validated.title,
          notes: validated.notes,
          source_url: validated.sourceUrl,
          amount_minor: validated.money?.amountMinor ?? null,
          currency: validated.money?.currency ?? null,
          details: validated.details,
          version: sql`version + 1`,
          updated_at: this.now(),
        })
        .where("id", "=", itemId)
        .execute();
      await this.replaceEndpoints(transaction, tripId, itemId, validated.endpoints);
      await recordEvent(transaction, {
        tripId,
        actorId: userId,
        eventType: "itinerary_item.updated",
        targetType: "itinerary_item",
        targetId: itemId,
        summary: "Updated an itinerary item",
      });
      const response = await this.readItem(transaction, tripId, itemId);
      await remember(transaction, userId, operation, key, response);
      return response;
    });
  }

  async deleteItem(
    userId: string,
    tripId: string,
    itemId: string,
    rawKey: string,
    expectedVersion: number,
  ) {
    const key = requireIdempotencyKey(rawKey);
    const operation = `id:${tripId}:${itemId}`;
    await this.database.transaction().execute(async (transaction) => {
      await this.requireMemberForMutation(transaction, userId, tripId);
      await lockMutation(transaction, userId, operation, key);
      const replay = await replayed(transaction, userId, operation, key);
      if (replay) return;
      const current = await this.lockItemRow(transaction, tripId, itemId);
      this.requireExpectedVersion(current.version, expectedVersion);
      this.requireUnlocked(current.locked_at);
      await transaction.deleteFrom("itinerary_items").where("id", "=", itemId).execute();
      await recordEvent(transaction, {
        tripId,
        actorId: userId,
        eventType: "itinerary_item.deleted",
        targetType: "itinerary_item",
        targetId: itemId,
        summary: "Deleted an itinerary item",
      });
      await remember(transaction, userId, operation, key, { deleted: true });
    });
  }

  async lockItem(
    userId: string,
    tripId: string,
    itemId: string,
    rawKey: string,
    expectedVersion: number,
  ) {
    return this.setItemLock(userId, tripId, itemId, rawKey, expectedVersion, true);
  }

  async unlockItem(
    userId: string,
    tripId: string,
    itemId: string,
    rawKey: string,
    expectedVersion: number,
  ) {
    return this.setItemLock(userId, tripId, itemId, rawKey, expectedVersion, false);
  }

  async createConstraint(
    userId: string,
    tripId: string,
    itemId: string,
    rawKey: string,
    expectedItemVersion: number,
    input: ConstraintInput,
  ) {
    const key = requireIdempotencyKey(rawKey);
    const operation = `cc:${tripId}:${itemId}`;
    return this.database.transaction().execute(async (transaction) => {
      await this.requireMemberForMutation(transaction, userId, tripId);
      await lockMutation(transaction, userId, operation, key);
      const replay = await replayed(transaction, userId, operation, key);
      if (replay) return replayedItem(replay);
      const item = await this.lockItemRow(transaction, tripId, itemId);
      this.requireExpectedVersion(item.version, expectedItemVersion);
      this.requireUnlocked(item.locked_at);
      const constraint = validateConstraint(input);
      await transaction.insertInto("itinerary_constraints").values({
        trip_id: tripId,
        itinerary_item_id: itemId,
        constraint_type: constraint.type,
        status: constraint.status,
        minimum_buffer_minutes: constraint.minimumBufferMinutes,
        created_by: userId,
      }).execute();
      await this.incrementItemVersion(transaction, itemId);
      const response = await this.readItem(transaction, tripId, itemId);
      await recordEvent(transaction, {
        tripId,
        actorId: userId,
        eventType: "constraint.created",
        targetType: "itinerary_item",
        targetId: itemId,
        summary: "Created an itinerary constraint",
      });
      await remember(transaction, userId, operation, key, response);
      return response;
    });
  }

  async updateConstraint(
    userId: string,
    tripId: string,
    itemId: string,
    constraintId: string,
    rawKey: string,
    expectedItemVersion: number,
    expectedVersion: number,
    input: ConstraintInput,
  ) {
    const key = requireIdempotencyKey(rawKey);
    const operation = `cu:${tripId}:${constraintId}`;
    return this.database.transaction().execute(async (transaction) => {
      await this.requireMemberForMutation(transaction, userId, tripId);
      await lockMutation(transaction, userId, operation, key);
      const replay = await replayed(transaction, userId, operation, key);
      if (replay) return replayedItem(replay);
      const item = await this.lockItemRow(transaction, tripId, itemId);
      this.requireExpectedVersion(item.version, expectedItemVersion);
      this.requireUnlocked(item.locked_at);
      const constraint = validateConstraint(input);
      const updated = await transaction.updateTable("itinerary_constraints").set({
        constraint_type: constraint.type,
        status: constraint.status,
        minimum_buffer_minutes: constraint.minimumBufferMinutes,
        version: sql`version + 1`,
        updated_at: this.now(),
      }).where("trip_id", "=", tripId)
        .where("itinerary_item_id", "=", itemId)
        .where("id", "=", constraintId)
        .where("version", "=", expectedVersion)
        .returning("id")
        .executeTakeFirst();
      if (!updated) await this.throwConstraintConflict(transaction, tripId, itemId, constraintId);
      await this.incrementItemVersion(transaction, itemId);
      await recordEvent(transaction, {
        tripId,
        actorId: userId,
        eventType: "constraint.updated",
        targetType: "constraint",
        targetId: constraintId,
        summary: "Updated an itinerary constraint",
      });
      const response = await this.readItem(transaction, tripId, itemId);
      await remember(transaction, userId, operation, key, response);
      return response;
    });
  }

  async deleteConstraint(
    userId: string,
    tripId: string,
    itemId: string,
    constraintId: string,
    rawKey: string,
    expectedItemVersion: number,
    expectedVersion: number,
  ) {
    const key = requireIdempotencyKey(rawKey);
    const operation = `cd:${tripId}:${constraintId}`;
    return this.database.transaction().execute(async (transaction) => {
      await this.requireMemberForMutation(transaction, userId, tripId);
      await lockMutation(transaction, userId, operation, key);
      const replay = await replayed(transaction, userId, operation, key);
      if (replay) return replayedItem(replay);
      const item = await this.lockItemRow(transaction, tripId, itemId);
      this.requireExpectedVersion(item.version, expectedItemVersion);
      this.requireUnlocked(item.locked_at);
      const deleted = await transaction.deleteFrom("itinerary_constraints")
        .where("trip_id", "=", tripId)
        .where("itinerary_item_id", "=", itemId)
        .where("id", "=", constraintId)
        .where("version", "=", expectedVersion)
        .returning("id")
        .executeTakeFirst();
      if (!deleted) await this.throwConstraintConflict(transaction, tripId, itemId, constraintId);
      await this.incrementItemVersion(transaction, itemId);
      await recordEvent(transaction, {
        tripId,
        actorId: userId,
        eventType: "constraint.deleted",
        targetType: "constraint",
        targetId: constraintId,
        summary: "Deleted an itinerary constraint",
      });
      const response = await this.readItem(transaction, tripId, itemId);
      await remember(transaction, userId, operation, key, response);
      return response;
    });
  }

  private async setItemLock(
    userId: string,
    tripId: string,
    itemId: string,
    rawKey: string,
    expectedVersion: number,
    locked: boolean,
  ) {
    const key = requireIdempotencyKey(rawKey);
    const operation = `${locked ? "il" : "in"}:${tripId}:${itemId}`;
    return this.database.transaction().execute(async (transaction) => {
      await this.requireMemberForMutation(transaction, userId, tripId);
      await lockMutation(transaction, userId, operation, key);
      const replay = await replayed(transaction, userId, operation, key);
      if (replay) return replayedItem(replay);
      const current = await this.lockItemRow(transaction, tripId, itemId);
      this.requireExpectedVersion(current.version, expectedVersion);
      if ((locked && current.locked_at) || (!locked && !current.locked_at)) {
        const response = await this.readItem(transaction, tripId, itemId);
        await remember(transaction, userId, operation, key, response);
        return response;
      }
      await transaction.updateTable("itinerary_items").set({
        locked_at: locked ? this.now() : null,
        locked_by: locked ? userId : null,
        version: sql`version + 1`,
        updated_at: this.now(),
      }).where("id", "=", itemId).execute();
      await recordEvent(transaction, {
        tripId,
        actorId: userId,
        eventType: locked ? "itinerary_item.locked" : "itinerary_item.unlocked",
        targetType: "itinerary_item",
        targetId: itemId,
        summary: locked ? "Locked an itinerary item" : "Unlocked an itinerary item",
      });
      const response = await this.readItem(transaction, tripId, itemId);
      await remember(transaction, userId, operation, key, response);
      return response;
    });
  }

  private async lockTripContent(
    transaction: Transaction<AlongTheWayDatabase>,
    tripId: string,
  ) {
    const trip = await transaction.selectFrom("trips")
      .select("id")
      .where("id", "=", tripId)
      .forUpdate()
      .executeTakeFirst();
    if (!trip) throw new AppError("trip_not_found", "Trip not found", 404);
  }

  private async requireMemberForMutation(
    transaction: Transaction<AlongTheWayDatabase>,
    userId: string,
    tripId: string,
  ) {
    await this.lockTripContent(transaction, tripId);
    const membership = await transaction.selectFrom("trip_members")
      .select("role")
      .where("trip_id", "=", tripId)
      .where("user_id", "=", userId)
      .where("removed_at", "is", null)
      .forUpdate()
      .executeTakeFirst();
    if (!membership) throw new AppError("trip_not_found", "Trip not found", 404);
    return membership.role;
  }

  private async requireMember(executor: DatabaseExecutor, userId: string, tripId: string) {
    const membership = await executor.selectFrom("trip_members")
      .select("role")
      .where("trip_id", "=", tripId)
      .where("user_id", "=", userId)
      .where("removed_at", "is", null)
      .executeTakeFirst();
    if (!membership) throw new AppError("trip_not_found", "Trip not found", 404);
    return membership.role;
  }

  private async validateItem(
    executor: DatabaseExecutor,
    tripId: string,
    input: CreateItineraryItemInput,
  ) {
    const type = itemType(input.type);
    const title = requiredText(input.title, "title", 200);
    const notes = optionalText(input.notes, "notes", 10_000);
    const sourceUrl = optionalUrl(input.sourceUrl);
    const money = validateMoney(input.money);
    const details = itemDetails(type, input.details);
    const endpoints = input.endpoints.map((endpoint) => {
      validateUuid(endpoint.countryStopId, "countryStopId");
      validateUuid(endpoint.placeId, "placeId");
      return resolveEndpoint(endpoint);
    });
    const expectedRoles = type === "flight" || type === "lodging" || type === "transport"
      ? ["start", "end"]
      : ["start"];
    const roles = endpoints.map((endpoint) => endpoint.role).sort();
    if (roles.join(",") !== [...expectedRoles].sort().join(",")) {
      throw new AppError("validation_error", `${type} has invalid endpoint roles`);
    }
    const [trip, placeRows, stopRows, assignedPlace] = await Promise.all([
      executor.selectFrom("trips").select(["start_date", "end_date"]).where("id", "=", tripId).executeTakeFirst(),
      executor.selectFrom("places").select(["id", "time_zone"]).where("trip_id", "=", tripId)
        .where("id", "in", endpoints.map((endpoint) => endpoint.placeId))
        .forUpdate()
        .execute(),
      executor.selectFrom("trip_country_stops").select(["id", "time_zone"]).where("trip_id", "=", tripId)
        .where("id", "in", endpoints.map((endpoint) => endpoint.countryStopId)).execute(),
      executor.selectFrom("trip_places as tripPlace")
        .innerJoin(
          "trip_place_day_assignments as assignment",
          "assignment.trip_place_id",
          "tripPlace.id",
        )
        .select("tripPlace.legacy_place_id")
        .where("tripPlace.trip_id", "=", tripId)
        .where("tripPlace.legacy_place_id", "in", endpoints.map((endpoint) => endpoint.placeId))
        .executeTakeFirst(),
    ]);
    if (!trip) throw new AppError("trip_not_found", "Trip not found", 404);
    if (assignedPlace) {
      throw new AppError(
        "conflict",
        "Remove the place from its unscheduled day before adding it to a timed itinerary item",
        409,
      );
    }
    const places = new Map(placeRows.map((place) => [place.id, place]));
    const stops = new Map(stopRows.map((stop) => [stop.id, stop]));
    for (const endpoint of endpoints) {
      const place = places.get(endpoint.placeId);
      if (!place) throw new AppError("validation_error", "Endpoint place must belong to this trip");
      const stop = stops.get(endpoint.countryStopId);
      if (!stop) {
        throw new AppError("validation_error", "Endpoint Country Stop must belong to this trip");
      }
      const suppliedConfirmedTimeZone = place.time_zone ?? stop.time_zone;
      const confirmedTimeZone = suppliedConfirmedTimeZone
        ? canonicalNamedTimeZone(suppliedConfirmedTimeZone)
        : null;
      if (suppliedConfirmedTimeZone && !confirmedTimeZone) {
        throw new AppError(
          "validation_error",
          "The Place or Country Stop time zone must be a named IANA time zone",
        );
      }
      if (confirmedTimeZone && confirmedTimeZone !== endpoint.timeZone) {
        throw new AppError(
          "validation_error",
          "Endpoint time zone must match its Place or Country Stop time zone",
        );
      }
      const endpointDate = endpoint.localDateTime.slice(0, 10);
      if (endpointDate < dateOnly(trip.start_date) || endpointDate > dateOnly(trip.end_date)) {
        throw new AppError("validation_error", "Endpoint date must fall within the trip date range");
      }
    }
    const start = endpoints.find((endpoint) => endpoint.role === "start")!;
    const end = endpoints.find((endpoint) => endpoint.role === "end");
    if (
      type === "lodging" &&
      end &&
      (
        end.placeId !== start.placeId ||
        end.countryStopId !== start.countryStopId ||
        end.timeZone !== start.timeZone
      )
    ) {
      throw new AppError(
        "validation_error",
        "Lodging check-in and checkout must use the same Place, Country Stop, and time zone",
      );
    }
    if (end && end.instant < start.instant) {
      throw new AppError("validation_error", "End instant must not precede start instant");
    }
    const constraints = (input.constraints ?? []).map(validateConstraint);
    return {
      type,
      title,
      notes,
      sourceUrl,
      money,
      endpoints,
      constraints,
      details,
    };
  }

  private endpointDto(endpoint: ResolvedEndpoint): ZonedEndpointDto {
    return {
      role: endpoint.role,
      countryStopId: endpoint.countryStopId,
      placeId: endpoint.placeId,
      localDateTime: endpoint.localDateTime,
      timeZone: endpoint.timeZone,
      utcOffset: endpoint.utcOffset,
      instant: endpoint.instant,
    };
  }

  private async replaceEndpoints(
    transaction: Transaction<AlongTheWayDatabase>,
    tripId: string,
    itemId: string,
    endpoints: ResolvedEndpoint[],
  ) {
    await transaction.deleteFrom("itinerary_endpoints").where("itinerary_item_id", "=", itemId).execute();
    await transaction.insertInto("itinerary_endpoints").values(endpoints.map((endpoint) => ({
      itinerary_item_id: itemId,
      trip_id: tripId,
      endpoint_role: endpoint.role,
      country_stop_id: endpoint.countryStopId,
      place_id: endpoint.placeId,
      local_date_time: endpoint.localDateTime,
      time_zone: endpoint.timeZone,
      utc_offset_minutes: endpoint.utcOffsetMinutes,
      instant: endpoint.instant,
    }))).execute();
  }

  private async readPlaces(executor: DatabaseExecutor, tripId: string) {
    const rows = await executor.selectFrom("places").selectAll().where("trip_id", "=", tripId)
      .orderBy("created_at").execute();
    return rows.map((row) => this.placeDto(row));
  }

  private async readPlace(executor: DatabaseExecutor, tripId: string, placeId: string) {
    const row = await executor.selectFrom("places").selectAll()
      .where("trip_id", "=", tripId).where("id", "=", placeId).executeTakeFirst();
    if (!row) throw new AppError("place_not_found", "Place not found", 404);
    return this.placeDto(row);
  }

  private placeDto(row: {
    id: string;
    trip_id: string;
    name: string;
    place_type: PlaceDto["type"];
    address: string | null;
    latitude: number | null;
    longitude: number | null;
    time_zone: string | null;
    source_url: string | null;
    notes: string | null;
    version: number;
  }): PlaceDto {
    return {
      id: row.id,
      tripId: row.trip_id,
      name: row.name,
      type: row.place_type,
      address: row.address,
      latitude: row.latitude,
      longitude: row.longitude,
      timeZone: row.time_zone,
      sourceUrl: row.source_url,
      notes: row.notes,
      locationStatus: placeLocationStatus({
        latitude: row.latitude,
        longitude: row.longitude,
        timeZone: row.time_zone,
      }),
      version: row.version,
    };
  }

  private async readItems(executor: DatabaseExecutor, tripId: string) {
    const rows = await executor.selectFrom("itinerary_items").selectAll()
      .where("trip_id", "=", tripId).orderBy("created_at").execute();
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const [endpointRows, constraintRows] = await Promise.all([
      executor.selectFrom("itinerary_endpoints").selectAll()
        .where("itinerary_item_id", "in", ids).orderBy("endpoint_role", "desc").execute(),
      executor.selectFrom("itinerary_constraints").selectAll()
        .where("itinerary_item_id", "in", ids).orderBy("created_at").execute(),
    ]);
    const endpoints = new Map<string, ZonedEndpointDto[]>();
    for (const endpoint of endpointRows) {
      const values = endpoints.get(endpoint.itinerary_item_id) ?? [];
      values.push({
        role: endpoint.endpoint_role,
        countryStopId: endpoint.country_stop_id,
        placeId: endpoint.place_id,
        localDateTime: endpoint.local_date_time,
        timeZone: endpoint.time_zone,
        utcOffset: this.offsetText(endpoint.utc_offset_minutes),
        instant: isoTimestamp(endpoint.instant),
      });
      endpoints.set(endpoint.itinerary_item_id, values);
    }
    const constraints = new Map<string, ConstraintDto[]>();
    for (const constraint of constraintRows) {
      const values = constraints.get(constraint.itinerary_item_id) ?? [];
      values.push({
        id: constraint.id,
        itemId: constraint.itinerary_item_id,
        type: constraint.constraint_type,
        status: constraint.status,
        minimumBufferMinutes: constraint.minimum_buffer_minutes,
        version: constraint.version,
      });
      constraints.set(constraint.itinerary_item_id, values);
    }
    return rows.map((row) => parseItineraryItemResponse({
      item: {
        id: row.id,
        tripId: row.trip_id,
        type: row.item_type,
        title: row.title,
        notes: row.notes,
        sourceUrl: row.source_url,
        money: row.amount_minor === null ? null : {
          amountMinor: Number(row.amount_minor),
          currency: row.currency,
        },
        lockedAt: row.locked_at ? isoTimestamp(row.locked_at) : null,
        lockedBy: row.locked_by,
        version: row.version,
        endpoints: endpoints.get(row.id) ?? [],
        constraints: constraints.get(row.id) ?? [],
        details: row.details,
      },
    }).item);
  }

  private async readItem(executor: DatabaseExecutor, tripId: string, itemId: string) {
    const items = await this.readItems(executor, tripId);
    const item = items.find((candidate) => candidate.id === itemId);
    if (!item) throw new AppError("item_not_found", "Itinerary item not found", 404);
    return item;
  }

  private offsetText(minutes: number) {
    const sign = minutes < 0 ? "-" : "+";
    const absolute = Math.abs(minutes);
    return `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
  }

  private async lockItemRow(
    transaction: Transaction<AlongTheWayDatabase>,
    tripId: string,
    itemId: string,
  ) {
    const item = await transaction.selectFrom("itinerary_items")
      .select(["version", "locked_at"])
      .where("trip_id", "=", tripId)
      .where("id", "=", itemId)
      .forUpdate()
      .executeTakeFirst();
    if (!item) throw new AppError("item_not_found", "Itinerary item not found", 404);
    return item;
  }

  private requireExpectedVersion(current: number, expected: number) {
    if (!Number.isSafeInteger(expected) || current !== expected) {
      throw new AppError(
        "conflict",
        `Version conflict; current version is ${current}`,
        409,
        undefined,
        current,
      );
    }
  }

  private requireUnlocked(lockedAt: Date | string | null) {
    if (lockedAt) {
      throw new AppError("item_locked", "Unlock this itinerary item before changing it", 409);
    }
  }

  private async incrementTripVersion(
    transaction: Transaction<AlongTheWayDatabase>,
    tripId: string,
    expectedVersion: number,
  ) {
    const updated = await transaction.updateTable("trips").set({
      version: sql`version + 1`,
      updated_at: this.now(),
    }).where("id", "=", tripId)
      .where("version", "=", expectedVersion)
      .returning("version")
      .executeTakeFirst();
    if (updated) return updated.version;
    const current = await transaction.selectFrom("trips")
      .select("version")
      .where("id", "=", tripId)
      .executeTakeFirst();
    if (!current) throw new AppError("trip_not_found", "Trip not found", 404);
    this.requireExpectedVersion(current.version, expectedVersion);
    throw new AppError("conflict", "Trip version conflict", 409);
  }

  private async incrementItemVersion(
    transaction: Transaction<AlongTheWayDatabase>,
    itemId: string,
  ) {
    await transaction.updateTable("itinerary_items").set({
      version: sql`version + 1`,
      updated_at: this.now(),
    }).where("id", "=", itemId).execute();
  }

  private async throwPlaceConflict(executor: DatabaseExecutor, tripId: string, placeId: string): Promise<never> {
    const current = await executor.selectFrom("places").select("version")
      .where("trip_id", "=", tripId).where("id", "=", placeId).executeTakeFirst();
    if (!current) throw new AppError("place_not_found", "Place not found", 404);
    throw new AppError(
      "conflict",
      `Version conflict; current version is ${current.version}`,
      409,
      undefined,
      current.version,
    );
  }

  private async throwConstraintConflict(
    executor: DatabaseExecutor,
    tripId: string,
    itemId: string,
    constraintId: string,
  ): Promise<never> {
    const current = await executor.selectFrom("itinerary_constraints").select("version")
      .where("trip_id", "=", tripId).where("itinerary_item_id", "=", itemId)
      .where("id", "=", constraintId).executeTakeFirst();
    if (!current) throw new AppError("constraint_not_found", "Constraint not found", 404);
    throw new AppError(
      "conflict",
      `Version conflict; current version is ${current.version}`,
      409,
      undefined,
      current.version,
    );
  }
}
