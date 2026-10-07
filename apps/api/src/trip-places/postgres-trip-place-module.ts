import {
  parseTripPlaceListResponse,
  parseTripPlaceResponse,
  type CreateTripPlaceInput,
  type MergeTripPlacesInput,
  type ProviderCandidatesResponse,
  type ProviderPlaceCandidateDto,
  type RemoveTripPlaceInput,
  type TripPlaceDto,
  type UpdateMemberVoteInput,
  type UpdateTripPlaceDayAssignmentsInput,
  type UpdateTripPlacePlanningInput,
} from "@along-the-way/contracts/trip-places";
import type { PlaceType } from "@along-the-way/contracts/trip-skeleton";
import { sql, type Kysely, type Transaction } from "kysely";
import type { ApplyTripPlanInput } from "@along-the-way/contracts/day-plans";

import type { AlongTheWayDatabase } from "../database/database";
import { reopenRemovedProposals } from "../discovery/reopen-removed-proposals";
import { tripPlanBasis } from "../planning/trip-plan-basis";
import { AppError } from "../private-trips/private-trip-module";
import {
  isoTimestamp,
  lockMutation,
  recordEvent,
  remember,
  replayed,
  requireIdempotencyKey,
  requireDayVersion,
  type DatabaseExecutor,
} from "../private-trips/postgres-private-trip-store";
import {
  ProviderUnavailableError,
  type PlaceProvider,
} from "./google-places-provider";
import {
  GoogleMapsUrlError,
  defaultGoogleMapsUrlResolverDependencies,
  googleMapsPlaceId,
  googleMapsSearchText,
  resolveGoogleMapsUrl,
  type GoogleMapsUrlResolverDependencies,
} from "./safe-google-maps-url";
import type { TripPlaceModule } from "./trip-place-module";

interface ModuleOptions {
  database: Kysely<AlongTheWayDatabase>;
  provider: PlaceProvider;
  urlResolver?: GoogleMapsUrlResolverDependencies;
  now?: () => Date;
}

interface ManualPlaceFacts {
  name: string;
  type: PlaceType;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  timeZone: string | null;
  sourceUrl: string | null;
  originalNote: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PLACE_TYPES = new Set<PlaceType>([
  "airport",
  "station",
  "lodging",
  "restaurant",
  "activity",
  "other",
]);
const ISO_CURRENCIES = new Set(Intl.supportedValuesOf("currency"));

function requiredText(value: unknown, name: string, maximum: number) {
  if (typeof value !== "string") {
    throw new AppError("validation_error", `${name} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new AppError(
      "validation_error",
      `${name} is required and must be at most ${maximum} characters`,
    );
  }
  return normalized;
}

function optionalText(value: unknown, name: string, maximum: number) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") {
    throw new AppError("validation_error", `${name} must be a string or null`);
  }
  const normalized = value.trim();
  if (normalized.length > maximum) {
    throw new AppError(
      "validation_error",
      `${name} must be at most ${maximum} characters`,
    );
  }
  return normalized || null;
}

function optionalUrl(value: unknown) {
  const normalized = optionalText(value, "sourceUrl", 2_000);
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
    return url.toString();
  } catch {
    throw new AppError(
      "validation_error",
      "sourceUrl must be an HTTP or HTTPS URL",
    );
  }
}

function uuid(value: unknown, name: string) {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new AppError("validation_error", `${name} must be a UUID`);
  }
  return value;
}

function placeType(value: unknown): PlaceType {
  if (typeof value !== "string" || !PLACE_TYPES.has(value as PlaceType)) {
    throw new AppError("validation_error", "type is invalid");
  }
  return value as PlaceType;
}

function coordinates(latitudeValue: unknown, longitudeValue: unknown) {
  const latitude = latitudeValue === null || latitudeValue === undefined
    ? null
    : latitudeValue;
  const longitude = longitudeValue === null || longitudeValue === undefined
    ? null
    : longitudeValue;
  if ((latitude === null) !== (longitude === null)) {
    throw new AppError(
      "validation_error",
      "latitude and longitude must both be provided or both be unknown",
    );
  }
  if (
    latitude !== null &&
    (typeof latitude !== "number" ||
      !Number.isFinite(latitude) ||
      latitude < -90 ||
      latitude > 90)
  ) {
    throw new AppError("validation_error", "latitude must be between -90 and 90");
  }
  if (
    longitude !== null &&
    (typeof longitude !== "number" ||
      !Number.isFinite(longitude) ||
      longitude < -180 ||
      longitude > 180)
  ) {
    throw new AppError(
      "validation_error",
      "longitude must be between -180 and 180",
    );
  }
  return { latitude: latitude as number | null, longitude: longitude as number | null };
}

function timeZone(value: unknown) {
  const normalized = optionalText(value, "timeZone", 100);
  if (!normalized) return null;
  try {
    new Intl.DateTimeFormat("en", { timeZone: normalized }).format();
    return normalized;
  } catch {
    throw new AppError("validation_error", "timeZone must be an IANA time zone");
  }
}

function upgradeStoredTripPlace(value: unknown) {
  if (typeof value !== "object" || value === null) return value;
  return { voters: [], voteCount: 0, ownVote: false, votingAvailable: false, ...value };
}

function replayedTripPlace(value: unknown) {
  return parseTripPlaceResponse({ tripPlace: upgradeStoredTripPlace(value) }).tripPlace;
}

function replayedTripPlaces(value: unknown) {
  const stored = value as { tripPlaces?: unknown };
  return parseTripPlaceListResponse({
    tripPlaces: Array.isArray(stored.tripPlaces) ? stored.tripPlaces.map(upgradeStoredTripPlace) : stored.tripPlaces,
  }).tripPlaces;
}

function normalizedSimilarity(value: string | null) {
  return value?.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "") ?? "";
}

function metresBetween(
  first: { latitude: number | null; longitude: number | null },
  second: { latitude: number | null; longitude: number | null },
) {
  if (
    first.latitude === null ||
    first.longitude === null ||
    second.latitude === null ||
    second.longitude === null
  ) return null;
  const radians = (value: number) => (value * Math.PI) / 180;
  const latitudeDelta = radians(second.latitude - first.latitude);
  const longitudeDelta = radians(second.longitude - first.longitude);
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(first.latitude)) *
      Math.cos(radians(second.latitude)) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export async function suggestPossibleTripPlaceDuplicates(
  transaction: Transaction<AlongTheWayDatabase>,
  tripId: string,
  tripPlaceId: string,
  facts: {
    name: string;
    address: string | null;
    latitude: number | null;
    longitude: number | null;
  },
) {
  const others = await transaction.selectFrom("trip_places as tripPlace")
    .innerJoin("place_identities as place", "place.id", "tripPlace.place_id")
    .select([
      "tripPlace.id",
      "place.canonical_name as name",
      "place.canonical_address as address",
      "place.latitude",
      "place.longitude",
    ])
    .where("tripPlace.trip_id", "=", tripId)
    .where("tripPlace.id", "!=", tripPlaceId)
    .where("tripPlace.archived_at", "is", null).execute();
  const name = normalizedSimilarity(facts.name);
  const address = normalizedSimilarity(facts.address);
  for (const other of others) {
    const reasons: string[] = [];
    if (name && name === normalizedSimilarity(other.name)) reasons.push("same normalized name");
    if (address && address === normalizedSimilarity(other.address)) reasons.push("same normalized address");
    const distance = metresBetween(facts, other);
    if (distance !== null && distance <= 100) reasons.push("within 100 metres");
    if (reasons.length === 0) continue;
    const [first, second] = [tripPlaceId, other.id].sort();
    await transaction.insertInto("trip_place_duplicate_suggestions").values({
      trip_id: tripId,
      first_trip_place_id: first!,
      second_trip_place_id: second!,
      reason: reasons.join(", "),
      status: "pending",
      decided_by: null,
      decided_at: null,
    }).onConflict((conflict) => conflict.columns([
      "trip_id",
      "first_trip_place_id",
      "second_trip_place_id",
    ]).doNothing()).execute();
  }
}

export class PostgresTripPlaceModule implements TripPlaceModule {
  private readonly database: Kysely<AlongTheWayDatabase>;
  private readonly provider: PlaceProvider;
  private readonly urlResolver: GoogleMapsUrlResolverDependencies;
  private readonly now: () => Date;

  constructor(options: ModuleOptions) {
    this.database = options.database;
    this.provider = options.provider;
    this.urlResolver =
      options.urlResolver ?? defaultGoogleMapsUrlResolverDependencies;
    this.now = options.now ?? (() => new Date());
  }

  async list(userId: string, tripId: string) {
    return this.database.transaction().execute(async (transaction) => {
      await this.requireMember(transaction, userId, tripId);
      await this.reconcileLegacyPlaces(transaction, tripId);
      return this.readList(transaction, userId, tripId);
    });
  }

  async search(
    userId: string,
    tripId: string,
    query: string,
  ): Promise<ProviderCandidatesResponse> {
    await this.requireMember(this.database, userId, tripId);
    try {
      const candidates = await this.provider.search(query);
      await this.clearProviderUnavailable(tripId);
      return { candidates, attribution: this.provider.attribution };
    } catch (error) {
      if (error instanceof TypeError) {
        throw new AppError("validation_error", error.message);
      }
      await this.markProviderUnavailable(tripId);
      throw new AppError(
        "provider_unavailable",
        error instanceof ProviderUnavailableError
          ? error.message
          : "Google Places is temporarily unavailable; use manual entry instead",
        503,
      );
    }
  }

  async resolveUrl(
    userId: string,
    tripId: string,
    url: string,
  ): Promise<ProviderCandidatesResponse> {
    await this.requireMember(this.database, userId, tripId);
    try {
      const resolution = await resolveGoogleMapsUrl(url, this.urlResolver);
      const providerPlaceId = googleMapsPlaceId(resolution.resolvedUrl);
      const searchText = googleMapsSearchText(resolution.resolvedUrl);
      const candidates = providerPlaceId
        ? [await this.provider.getPlace(providerPlaceId)]
        : searchText
          ? await this.provider.search(searchText)
          : [];
      if (providerPlaceId || searchText) {
        await this.clearProviderUnavailable(tripId);
      }
      return {
        candidates,
        resolvedUrl: resolution.resolvedUrl,
        attribution: this.provider.attribution,
      };
    } catch (error) {
      if (error instanceof GoogleMapsUrlError || error instanceof TypeError) {
        throw new AppError("validation_error", error.message);
      }
      await this.markProviderUnavailable(tripId);
      throw new AppError(
        "provider_unavailable",
        error instanceof ProviderUnavailableError
          ? error.message
          : "Google Places is temporarily unavailable; search or enter the place manually",
        503,
      );
    }
  }

  async add(
    userId: string,
    tripId: string,
    rawKey: string,
    input: CreateTripPlaceInput,
  ) {
    const key = requireIdempotencyKey(rawKey);
    const operation = `tp:add:${tripId}`;
    await this.requireMember(this.database, userId, tripId);
    const earlyReplay = await replayed(this.database, userId, operation, key);
    if (earlyReplay) return replayedTripPlace(earlyReplay);

    let candidate: ProviderPlaceCandidateDto | null = null;
    let manual: ManualPlaceFacts | null = null;
    if (input.method === "manual") {
      const point = coordinates(input.latitude, input.longitude);
      manual = {
        name: requiredText(input.name, "name", 200),
        type: placeType(input.type),
        address: optionalText(input.address, "address", 2_000),
        ...point,
        timeZone: timeZone(input.timeZone),
        sourceUrl: optionalUrl(input.sourceUrl),
        originalNote: optionalText(input.originalNote, "originalNote", 10_000),
      };
    } else {
      try {
        candidate = await this.provider.getPlace(
          requiredText(input.providerPlaceId, "providerPlaceId", 300),
        );
      } catch (error) {
        if (error instanceof TypeError) {
          throw new AppError("validation_error", error.message);
        }
        await this.markProviderUnavailable(tripId);
        throw new AppError(
          "provider_unavailable",
          error instanceof ProviderUnavailableError
            ? error.message
            : "Google Places is temporarily unavailable; use manual entry instead",
          503,
        );
      }
    }
    const sourceUrl = optionalUrl(input.sourceUrl) ?? candidate?.sourceUrl ?? manual?.sourceUrl ?? null;
    const originalNote = optionalText(input.originalNote, "originalNote", 10_000);

    return this.persistPlace(
      userId,
      tripId,
      key,
      operation,
      input.method,
      candidate,
      manual,
      sourceUrl,
      originalNote,
      true,
    );
  }

  async addObservedCandidate(
    userId: string,
    tripId: string,
    rawKey: string,
    candidate: ProviderPlaceCandidateDto,
  ) {
    const key = requireIdempotencyKey(rawKey);
    const operation = `tp:add:${tripId}`;
    await this.requireMember(this.database, userId, tripId);
    const earlyReplay = await replayed(this.database, userId, operation, key);
    if (earlyReplay) return replayedTripPlace(earlyReplay);
    return this.persistPlace(
      userId,
      tripId,
      key,
      operation,
      "search",
      candidate,
      null,
      optionalUrl(candidate.sourceUrl),
      null,
      false,
    );
  }

  private async persistPlace(
    userId: string,
    tripId: string,
    key: string,
    operation: string,
    intakeMethod: CreateTripPlaceInput["method"],
    candidate: ProviderPlaceCandidateDto | null,
    manual: ManualPlaceFacts | null,
    sourceUrl: string | null,
    originalNote: string | null,
    refuseActiveProviderDuplicate: boolean,
  ) {
    return this.database.transaction().execute(async (transaction) => {
      await this.requireMember(transaction, userId, tripId);
      await lockMutation(transaction, userId, operation, key);
      const replay = await replayed(transaction, userId, operation, key);
      if (replay) return replayedTripPlace(replay);
      await this.reconcileLegacyPlaces(transaction, tripId);

      const identity = candidate
        ? await this.upsertProviderIdentity(transaction, candidate)
        : await transaction.insertInto("place_identities").values({
            provider: "manual",
            provider_place_id: null,
            canonical_name: manual!.name,
            canonical_type: manual!.type,
            canonical_address: manual!.address,
            latitude: manual!.latitude,
            longitude: manual!.longitude,
            time_zone: manual!.timeZone,
            provider_observed_at: null,
            provider_expires_at: null,
            provider_attribution: null,
          }).returning("id").executeTakeFirstOrThrow();
      const facts = candidate ?? manual!;
      const existing = await transaction.selectFrom("trip_places")
        .select(["id", "legacy_place_id", "legacy_place_version", "archived_at"])
        .where("trip_id", "=", tripId)
        .where("place_id", "=", identity.id)
        .forUpdate()
        .executeTakeFirst();
      if (existing) {
        const legacy = await transaction.selectFrom("places").select("travel_only")
          .where("trip_id", "=", tripId).where("id", "=", existing.legacy_place_id).executeTakeFirstOrThrow();
        if (legacy.travel_only) throw new AppError("travel_place", "Travel-only places cannot be added to the wishlist", 409);
        if (candidate && refuseActiveProviderDuplicate && existing.archived_at === null) {
          throw new AppError("already_in_wishlist", "This place is already in the wishlist", 409);
        }
      }
      const legacyPlace = existing
        ? originalNote === null
          ? { id: existing.legacy_place_id, version: existing.legacy_place_version }
          : await transaction.updateTable("places").set({
              notes: originalNote,
              version: sql`version + 1`,
              updated_at: this.now(),
            }).where("id", "=", existing.legacy_place_id)
              .returning(["id", "version"]).executeTakeFirstOrThrow()
        : await transaction.insertInto("places").values({
            trip_id: tripId,
            name: facts.name,
            place_type: facts.type,
            address: facts.address,
            latitude: facts.latitude,
            longitude: facts.longitude,
            time_zone: facts.timeZone,
            source_url: sourceUrl,
            notes: originalNote,
            created_by: userId,
          }).returning(["id", "version"]).executeTakeFirstOrThrow();
      const tripPlace = existing
        ? await transaction.updateTable("trip_places").set({
            archived_at: null,
            provider_unavailable: false,
            ...(originalNote === null ? {} : { notes: originalNote }),
            legacy_place_version: legacyPlace.version,
            updated_at: this.now(),
            version: sql`version + 1`,
          }).where("id", "=", existing.id).returning("id").executeTakeFirstOrThrow()
        : await transaction.insertInto("trip_places").values({
            trip_id: tripId,
            place_id: identity.id,
            legacy_place_id: legacyPlace.id,
            legacy_place_version: legacyPlace.version,
            facts_source: candidate ? "provider" : "member",
            name: facts.name,
            place_type: facts.type,
            address: facts.address,
            latitude: facts.latitude,
            longitude: facts.longitude,
            time_zone: facts.timeZone,
            duration_minutes: null,
            budget_amount_minor: null,
            budget_currency: null,
            notes: originalNote,
            provider_unavailable: false,
            archived_at: null,
            created_by: userId,
          }).returning("id").executeTakeFirstOrThrow();
      await transaction.insertInto("trip_place_contributions").values({
        trip_id: tripId,
        trip_place_id: tripPlace.id,
        member_user_id: userId,
        intake_method: intakeMethod,
        source_url: sourceUrl,
        original_note: originalNote,
        provider_observed_at: candidate ? candidate.observedAt : null,
        withdrawn_at: null,
      }).execute();
      if (!existing) {
        await suggestPossibleTripPlaceDuplicates(transaction, tripId, tripPlace.id, facts);
      }
      await recordEvent(transaction, {
        tripId,
        actorId: userId,
        eventType: existing ? "trip_place.contribution_added" : "trip_place.created",
        targetType: "trip_place",
        targetId: tripPlace.id,
        summary: existing
          ? "Added a member contribution to an existing place"
          : `Added a ${intakeMethod} place`,
      });
      const response = await this.readOne(transaction, userId, tripId, tripPlace.id);
      await remember(transaction, userId, operation, key, response);
      return response;
    });
  }

  async updatePlanning(
    userId: string,
    tripId: string,
    tripPlaceId: string,
    rawKey: string,
    input: UpdateTripPlacePlanningInput,
  ) {
    uuid(tripPlaceId, "tripPlaceId");
    const key = requireIdempotencyKey(rawKey);
    const operation = `tp:plan:${tripPlaceId}`;
    const durationMinutes = input.durationMinutes ?? null;
    if (
      durationMinutes !== null &&
      (!Number.isSafeInteger(durationMinutes) || durationMinutes <= 0 || durationMinutes > 10_080)
    ) {
      throw new AppError("validation_error", "durationMinutes must be a positive integer");
    }
    const budgetAmountMinor = input.budgetAmountMinor ?? null;
    const budgetCurrency = optionalText(input.budgetCurrency, "budgetCurrency", 3)?.toUpperCase() ?? null;
    if ((budgetAmountMinor === null) !== (budgetCurrency === null)) {
      throw new AppError("validation_error", "budget amount and currency must both be known or both be unknown");
    }
    if (
      budgetAmountMinor !== null &&
      (!Number.isSafeInteger(budgetAmountMinor) || budgetAmountMinor < 0)
    ) throw new AppError("validation_error", "budgetAmountMinor must be a non-negative integer");
    if (budgetCurrency && !ISO_CURRENCIES.has(budgetCurrency)) {
      throw new AppError("validation_error", "budgetCurrency must be an ISO 4217 currency");
    }
    const notes = optionalText(input.notes, "notes", 10_000);

    return this.database.transaction().execute(async (transaction) => {
      await this.requireMember(transaction, userId, tripId);
      await lockMutation(transaction, userId, operation, key);
      const replay = await replayed(transaction, userId, operation, key);
      if (replay) return replayedTripPlace(replay);
      await this.reconcileLegacyPlaces(transaction, tripId);
      const current = await this.lockTripPlace(transaction, tripId, tripPlaceId);
      this.expectedVersion(current.version, input.expectedVersion);
      const updatedAt = this.now();
      const legacy = await transaction.updateTable("places").set({
        notes,
        version: sql`version + 1`,
        updated_at: updatedAt,
      }).where("id", "=", current.legacy_place_id)
        .returning("version")
        .executeTakeFirstOrThrow();
      await transaction.updateTable("trip_places").set({
        duration_minutes: durationMinutes,
        budget_amount_minor: budgetAmountMinor,
        budget_currency: budgetCurrency,
        notes,
        legacy_place_version: legacy.version,
        version: sql`version + 1`,
        updated_at: updatedAt,
      }).where("id", "=", tripPlaceId).execute();
      await recordEvent(transaction, {
        tripId,
        actorId: userId,
        eventType: "trip_place.planning_updated",
        targetType: "trip_place",
        targetId: tripPlaceId,
        summary: "Updated place planning facts",
      });
      const response = await this.readOne(transaction, userId, tripId, tripPlaceId);
      await remember(transaction, userId, operation, key, response);
      return response;
    });
  }

  async updateDayAssignments(
    userId: string,
    tripId: string,
    rawKey: string,
    input: UpdateTripPlaceDayAssignmentsInput,
  ) {
    if (!Array.isArray(input.assignments) || input.assignments.length === 0 || input.assignments.length > 100) {
      throw new AppError("validation_error", "assignments must contain between 1 and 100 places");
    }
    // PostgreSQL returns lowercase UUIDs; normalize so request spellings compare as identities.
    const assignments = input.assignments.map((assignment) => ({
      tripPlaceId: uuid(assignment.tripPlaceId, "tripPlaceId").toLowerCase(),
      tripDayId: assignment.tripDayId === null ? null : uuid(assignment.tripDayId, "tripDayId").toLowerCase(),
      expectedVersion: assignment.expectedVersion,
    }));
    if (new Set(assignments.map((assignment) => assignment.tripPlaceId)).size !== assignments.length) {
      throw new AppError("validation_error", "assignments cannot contain the same place twice");
    }
    const key = requireIdempotencyKey(rawKey);
    const operation = `tp:day-assignments:${tripId}`;
    return this.database.transaction().execute(async (transaction) => {
      await this.requireMember(transaction, userId, tripId);
      await lockMutation(transaction, userId, operation, key);
      const replay = await replayed(transaction, userId, operation, key);
      if (replay) return replayedTripPlaces(replay);
      await this.lockTripContent(transaction, tripId);
      await this.reconcileLegacyPlaces(transaction, tripId);
      const ids = assignments.map((assignment) => assignment.tripPlaceId).sort();
      const places = await transaction.selectFrom("trip_places")
        .select(["id", "legacy_place_id", "version"])
        .where("trip_id", "=", tripId)
        .where("id", "in", ids)
        .where("archived_at", "is", null)
        .orderBy("id")
        .forUpdate()
        .execute();
      if (places.length !== ids.length) {
        throw new AppError("trip_place_not_found", "Trip place not found", 404);
      }
      const placeById = new Map(places.map((place) => [place.id, place]));
      for (const assignment of assignments) {
        this.expectedVersion(
          placeById.get(assignment.tripPlaceId)!.version,
          assignment.expectedVersion,
        );
      }
      const dayIds = [...new Set(assignments.flatMap((assignment) =>
        assignment.tripDayId === null ? [] : [assignment.tripDayId]
      ))];
      if (dayIds.length > 0) {
        const validDays = await transaction.selectFrom("trip_days").select("id")
          .where("trip_id", "=", tripId)
          .where("id", "in", dayIds)
          .execute();
        if (validDays.length !== dayIds.length) {
          throw new AppError("validation_error", "Assignments must use days from this trip");
        }
      }
      const assigningLegacyIds = assignments.flatMap((assignment) =>
        assignment.tripDayId === null
          ? []
          : [placeById.get(assignment.tripPlaceId)!.legacy_place_id]
      );
      if (assigningLegacyIds.length > 0) {
        const scheduled = await transaction.selectFrom("itinerary_endpoints")
          .select("place_id")
          .where("trip_id", "=", tripId)
          .where("place_id", "in", assigningLegacyIds)
          .executeTakeFirst();
        if (scheduled) {
          throw new AppError(
            "conflict",
            "A place already scheduled as a timed itinerary item cannot also be assigned as an unscheduled day place",
            409,
          );
        }
      }
      // A place planned for one day must be removed there before another day can take it.
      const requestedDay = new Map(assignments.flatMap((assignment) =>
        assignment.tripDayId === null ? [] : [[assignment.tripPlaceId, assignment.tripDayId] as const]
      ));
      if (requestedDay.size > 0) {
        const current = await transaction.selectFrom("trip_place_day_assignments")
          .select(["trip_place_id", "trip_day_id"])
          .where("trip_place_id", "in", [...requestedDay.keys()])
          .execute();
        if (current.some((row) => requestedDay.get(row.trip_place_id) !== row.trip_day_id)) {
          throw new AppError(
            "conflict",
            "Remove the place from its current day before adding it to another day",
            409,
          );
        }
      }
      const updatedAt = this.now();
      for (const assignment of assignments) {
        await this.writeDayAssignment(transaction, userId, tripId, assignment.tripPlaceId, assignment.tripDayId, updatedAt);
      }
      const response = await this.readList(transaction, userId, tripId);
      await remember(transaction, userId, operation, key, { tripPlaces: response });
      return response;
    });
  }

  async addPlacesToDays(
    userId: string,
    tripId: string,
    rawKey: string,
    input: ApplyTripPlanInput,
  ) {
    if (typeof input.basis !== "string" || !/^[0-9a-f]{64}$/.test(input.basis)) {
      throw new AppError("validation_error", "basis is invalid");
    }
    if (!Array.isArray(input.days) || input.days.length === 0 || input.days.length > 366) {
      throw new AppError("validation_error", "days must contain between 1 and 366 days");
    }
    const days = input.days.map((day) => {
      const ids = Array.isArray(day?.orderedTripPlaceIds) ? day.orderedTripPlaceIds : null;
      if (!ids || ids.length === 0 || ids.length > 100) {
        throw new AppError("validation_error", "orderedTripPlaceIds must contain 1 to 100 places");
      }
      return {
        tripDayId: uuid(day.tripDayId, "tripDayId").toLowerCase(),
        orderedTripPlaceIds: ids.map((id) => uuid(id, "orderedTripPlaceIds").toLowerCase()),
        expectedVersion: day.expectedVersion,
      };
    });
    const dayIds = days.map((day) => day.tripDayId);
    const placeIds = days.flatMap((day) => day.orderedTripPlaceIds);
    if (new Set(dayIds).size !== dayIds.length || new Set(placeIds).size !== placeIds.length) {
      throw new AppError("validation_error", "A day or place can appear only once");
    }
    const key = requireIdempotencyKey(rawKey);
    const operation = `tp:trip-plan:${tripId}`;
    return this.database.transaction().execute(async (transaction) => {
      await this.requireMember(transaction, userId, tripId);
      await lockMutation(transaction, userId, operation, key);
      const replay = await replayed(transaction, userId, operation, key);
      if (replay) return replayedTripPlaces(replay);
      await this.lockTripContent(transaction, tripId);
      await this.reconcileLegacyPlaces(transaction, tripId);
      const validDays = await transaction.selectFrom("trip_days").select("id")
        .where("trip_id", "=", tripId).where("id", "in", dayIds).orderBy("id").forUpdate().execute();
      if (validDays.length !== dayIds.length) {
        throw new AppError("validation_error", "The plan must use days from this trip");
      }
      for (const day of days) await requireDayVersion(transaction, tripId, day.tripDayId, day.expectedVersion);
      const current = await transaction.selectFrom("trip_place_day_assignments")
        .select(["trip_place_id", "trip_day_id"])
        .where("trip_id", "=", tripId)
        .where((where) => where.or([where("trip_day_id", "in", dayIds), where("trip_place_id", "in", placeIds)]))
        .orderBy("trip_place_id").forUpdate().execute();
      if (await tripPlanBasis(transaction, tripId) !== input.basis) {
        throw new AppError("conflict", "The trip changed since this plan was made; plan again", 409);
      }
      const places = await transaction.selectFrom("trip_places").select(["id", "legacy_place_id"])
        .where("trip_id", "=", tripId).where("id", "in", placeIds).where("archived_at", "is", null)
        .orderBy("id").forUpdate().execute();
      if (places.length !== placeIds.length) {
        throw new AppError("trip_place_not_found", "Trip place not found", 404);
      }
      const assignedDay = new Map(current.map((row) => [row.trip_place_id, row.trip_day_id]));
      const added: Array<{ tripPlaceId: string; tripDayId: string }> = [];
      for (const day of days) {
        const listed = new Set(day.orderedTripPlaceIds);
        const conflicting = current.some((row) => row.trip_day_id === day.tripDayId && !listed.has(row.trip_place_id))
          || day.orderedTripPlaceIds.some((id) => assignedDay.has(id) && assignedDay.get(id) !== day.tripDayId);
        if (conflicting) {
          throw new AppError("conflict", "The plan's days no longer match; plan again", 409);
        }
        for (const id of day.orderedTripPlaceIds) {
          if (!assignedDay.has(id)) added.push({ tripPlaceId: id, tripDayId: day.tripDayId });
        }
      }
      const legacyById = new Map(places.map((place) => [place.id, place.legacy_place_id]));
      if (added.length > 0) {
        const scheduled = await transaction.selectFrom("itinerary_endpoints").select("place_id")
          .where("trip_id", "=", tripId)
          .where("place_id", "in", added.map((entry) => legacyById.get(entry.tripPlaceId)!))
          .executeTakeFirst();
        if (scheduled) {
          throw new AppError("conflict", "A place in the plan is already on the timed itinerary", 409);
        }
      }
      const updatedAt = this.now();
      for (const entry of added) {
        await this.writeDayAssignment(transaction, userId, tripId, entry.tripPlaceId, entry.tripDayId, updatedAt);
      }
      // Write every position so existing places keep their order ahead of the new ones.
      for (const day of days) {
        await transaction.updateTable("trip_place_day_assignments").set({ day_position: null })
          .where("trip_id", "=", tripId).where("trip_day_id", "=", day.tripDayId).execute();
        for (const [position, id] of day.orderedTripPlaceIds.entries()) {
          await transaction.updateTable("trip_place_day_assignments").set({ day_position: position })
            .where("trip_place_id", "=", id).execute();
        }
      }
      const response = await this.readList(transaction, userId, tripId);
      await remember(transaction, userId, operation, key, { tripPlaces: response });
      return response;
    });
  }

  /** Puts one place on a day, or takes it off its day when `tripDayId` is null. */
  private async writeDayAssignment(
    transaction: Transaction<AlongTheWayDatabase>,
    userId: string,
    tripId: string,
    tripPlaceId: string,
    tripDayId: string | null,
    updatedAt: Date,
  ) {
    // The 007 synchronization trigger turns the desired-day row into the day assignment.
    await transaction.deleteFrom("trip_place_desired_days")
      .where("trip_place_id", "=", tripPlaceId)
      .execute();
    if (tripDayId !== null) {
      await transaction.insertInto("trip_place_desired_days").values({
        trip_id: tripId,
        trip_place_id: tripPlaceId,
        trip_day_id: tripDayId,
      }).execute();
      await transaction.updateTable("trip_place_day_assignments").set({
        assigned_by: userId,
        assigned_at: updatedAt,
      }).where("trip_place_id", "=", tripPlaceId).execute();
    }
    await transaction.updateTable("trip_places").set({
      version: sql`version + 1`,
      updated_at: updatedAt,
    }).where("id", "=", tripPlaceId).execute();
    await recordEvent(transaction, {
      tripId,
      actorId: userId,
      eventType: tripDayId === null ? "trip_place.day_unassigned" : "trip_place.day_assigned",
      targetType: "trip_place",
      targetId: tripPlaceId,
      summary: tripDayId === null ? "Removed a place from its planned day" : "Assigned a place to a planned day",
    });
  }

  async setOwnVote(
    userId: string,
    tripId: string,
    tripPlaceId: string,
    rawKey: string,
    input: UpdateMemberVoteInput,
  ) {
    uuid(tripPlaceId, "tripPlaceId");
    if (typeof input.voted !== "boolean") {
      throw new AppError("validation_error", "voted must be a boolean");
    }
    const key = requireIdempotencyKey(rawKey);
    const operation = `tp:vote:${tripPlaceId}`;
    return this.database.transaction().execute(async (transaction) => {
      await this.requireMember(transaction, userId, tripId);
      await lockMutation(transaction, userId, operation, key);
      await this.lockTripContent(transaction, tripId);
      await this.requireMember(transaction, userId, tripId);
      const replay = await replayed(transaction, userId, operation, key);
      if (replay) return replayedTripPlace(replay);
      const members = await transaction.selectFrom("trip_members")
        .select((builder) => builder.fn.countAll().as("count"))
        .where("trip_id", "=", tripId).where("removed_at", "is", null)
        .executeTakeFirstOrThrow();
      if (Number(members.count) < 2) {
        throw new AppError("voting_unavailable", "Voting needs at least two active trip members", 409);
      }
      await this.lockTripPlace(transaction, tripId, tripPlaceId);
      if (input.voted) {
        await transaction.insertInto("trip_place_votes").values({
          trip_id: tripId,
          trip_place_id: tripPlaceId,
          member_user_id: userId,
        }).onConflict((conflict) => conflict.columns(["trip_place_id", "member_user_id"]).doNothing()).execute();
      } else {
        await transaction.deleteFrom("trip_place_votes")
          .where("trip_place_id", "=", tripPlaceId).where("member_user_id", "=", userId).execute();
      }
      await transaction.updateTable("trip_places").set({
        version: sql`version + 1`,
        updated_at: this.now(),
      }).where("id", "=", tripPlaceId).execute();
      await recordEvent(transaction, {
        tripId,
        actorId: userId,
        eventType: "trip_place.vote_changed",
        targetType: "trip_place",
        targetId: tripPlaceId,
        summary: input.voted ? "Voted for a wishlist place" : "Removed own vote from a wishlist place",
      });
      const response = await this.readOne(transaction, userId, tripId, tripPlaceId);
      await remember(transaction, userId, operation, key, response);
      return response;
    });
  }

  async merge(
    userId: string,
    tripId: string,
    sourceTripPlaceId: string,
    rawKey: string,
    input: MergeTripPlacesInput,
  ) {
    uuid(sourceTripPlaceId, "sourceTripPlaceId");
    const targetTripPlaceId = uuid(input.targetTripPlaceId, "targetTripPlaceId");
    if (sourceTripPlaceId === targetTripPlaceId) {
      throw new AppError("validation_error", "A place cannot be merged into itself");
    }
    const key = requireIdempotencyKey(rawKey);
    const operation = `tp:merge:${sourceTripPlaceId}`;
    return this.database.transaction().execute(async (transaction) => {
      await this.requireMember(transaction, userId, tripId);
      await lockMutation(transaction, userId, operation, key);
      const replay = await replayed(transaction, userId, operation, key);
      if (replay) return replayedTripPlace(replay);
      await this.reconcileLegacyPlaces(transaction, tripId);
      const locked = await transaction.selectFrom("trip_places")
        .selectAll().where("trip_id", "=", tripId)
        .where("id", "in", [sourceTripPlaceId, targetTripPlaceId].sort())
        .where("archived_at", "is", null).orderBy("id").forUpdate().execute();
      const source = locked.find((row) => row.id === sourceTripPlaceId);
      const target = locked.find((row) => row.id === targetTripPlaceId);
      if (!source || !target) throw new AppError("trip_place_not_found", "Trip place not found", 404);
      this.expectedVersion(source.version, input.expectedSourceVersion);
      this.expectedVersion(target.version, input.expectedTargetVersion);
      const combinedNotes = [target.notes, source.notes]
        .filter((value, index, all) => value && all.indexOf(value) === index)
        .join("\n\n") || null;
      if (combinedNotes && combinedNotes.length > 10_000) {
        throw new AppError(
          "conflict",
          "Combined planning notes exceed 10,000 characters; shorten one note before merging",
          409,
        );
      }
      const dayAssignments = await transaction.selectFrom("trip_place_day_assignments")
        .selectAll()
        .where("trip_place_id", "in", [source.id, target.id])
        .execute();
      const sourceAssignment = dayAssignments.find((assignment) =>
        assignment.trip_place_id === source.id
      );
      const targetAssignment = dayAssignments.find((assignment) =>
        assignment.trip_place_id === target.id
      );
      if (
        sourceAssignment &&
        targetAssignment &&
        sourceAssignment.trip_day_id !== targetAssignment.trip_day_id
      ) {
        throw new AppError(
          "conflict",
          "Move both places to the same day before merging them",
          409,
        );
      }
      const [scheduled, desiredDays, excludedDays] = await Promise.all([
        transaction.selectFrom("itinerary_endpoints")
          .select("place_id")
          .where("trip_id", "=", tripId)
          .where("place_id", "in", [source.legacy_place_id, target.legacy_place_id])
          .executeTakeFirst(),
        transaction.selectFrom("trip_place_desired_days")
          .select("trip_day_id")
          .where("trip_place_id", "in", [source.id, target.id])
          .execute(),
        transaction.selectFrom("trip_place_excluded_days")
          .select("trip_day_id")
          .where("trip_place_id", "in", [source.id, target.id])
          .execute(),
      ]);
      if (scheduled && (sourceAssignment || targetAssignment)) {
        throw new AppError(
          "conflict",
          "A scheduled place cannot be merged with an unscheduled day assignment",
          409,
        );
      }
      const desiredDayIds = new Set(desiredDays.map((row) => row.trip_day_id));
      if (excludedDays.some((row) => desiredDayIds.has(row.trip_day_id))) {
        throw new AppError(
          "conflict",
          "Resolve legacy preferred and excluded day conflicts before merging these places",
          409,
        );
      }

      await transaction.updateTable("trip_place_contributions")
        .set({ trip_place_id: target.id })
        .where("trip_place_id", "=", source.id).execute();
      await transaction.insertInto("trip_place_votes")
        .columns(["trip_id", "trip_place_id", "member_user_id", "created_at"])
        .expression(transaction.selectFrom("trip_place_votes")
          .select(["trip_id", sql<string>`${target.id}`.as("trip_place_id"), "member_user_id", "created_at"])
          .where("trip_place_id", "=", source.id))
        .onConflict((conflict) => conflict.columns(["trip_place_id", "member_user_id"]).doNothing())
        .execute();
      await transaction.deleteFrom("trip_place_votes").where("trip_place_id", "=", source.id).execute();
      await transaction.updateTable("candidate_proposals")
        .set({ accepted_trip_place_id: target.id })
        .where("trip_id", "=", tripId).where("accepted_trip_place_id", "=", source.id).execute();
      await this.mergeDayPreferences(
        transaction,
        "trip_place_desired_days",
        source.id,
        target.id,
        tripId,
      );
      await this.mergeDayPreferences(
        transaction,
        "trip_place_excluded_days",
        source.id,
        target.id,
        tripId,
      );
      await transaction.updateTable("itinerary_endpoints")
        .set({ place_id: target.legacy_place_id })
        .where("trip_id", "=", tripId)
        .where("place_id", "=", source.legacy_place_id).execute();
      await transaction.deleteFrom("trip_place_duplicate_suggestions")
        .where((builder) => builder.or([
          builder("first_trip_place_id", "=", source.id),
          builder("second_trip_place_id", "=", source.id),
        ])).execute();
      const updatedAt = this.now();
      const legacy = await transaction.updateTable("places").set({
        notes: combinedNotes,
        version: sql`version + 1`,
        updated_at: updatedAt,
      }).where("id", "=", target.legacy_place_id)
        .returning("version")
        .executeTakeFirstOrThrow();
      await transaction.updateTable("trip_places").set({
        duration_minutes: target.duration_minutes ?? source.duration_minutes,
        budget_amount_minor: target.budget_amount_minor === null
          ? source.budget_amount_minor === null
            ? null
            : Number(source.budget_amount_minor)
          : Number(target.budget_amount_minor),
        budget_currency: target.budget_currency ?? source.budget_currency,
        notes: combinedNotes,
        legacy_place_version: legacy.version,
        version: sql`version + 1`,
        updated_at: updatedAt,
      }).where("id", "=", target.id).execute();
      await transaction.deleteFrom("trip_places").where("id", "=", source.id).execute();
      await transaction.deleteFrom("places")
        .where("trip_id", "=", tripId)
        .where("id", "=", source.legacy_place_id)
        .execute();
      await recordEvent(transaction, {
        tripId,
        actorId: userId,
        eventType: "trip_place.merged",
        targetType: "trip_place",
        targetId: target.id,
        summary: `Merged candidate ${source.id} into ${target.id}`,
      });
      const response = await this.readOne(transaction, userId, tripId, target.id);
      await remember(transaction, userId, operation, key, response);
      return response;
    });
  }

  async keepSeparate(
    userId: string,
    tripId: string,
    suggestionId: string,
    rawKey: string,
  ) {
    uuid(suggestionId, "suggestionId");
    const key = requireIdempotencyKey(rawKey);
    const operation = `tp:separate:${suggestionId}`;
    await this.database.transaction().execute(async (transaction) => {
      await this.requireMember(transaction, userId, tripId);
      await lockMutation(transaction, userId, operation, key);
      if (await replayed(transaction, userId, operation, key)) return;
      await this.lockTripContent(transaction, tripId);
      const updated = await transaction.updateTable("trip_place_duplicate_suggestions")
        .set({ status: "kept-separate", decided_by: userId, decided_at: this.now() })
        .where("id", "=", suggestionId).where("trip_id", "=", tripId)
        .where("status", "=", "pending").returning("id").executeTakeFirst();
      if (!updated) throw new AppError("duplicate_suggestion_not_found", "Duplicate suggestion not found", 404);
      await recordEvent(transaction, {
        tripId,
        actorId: userId,
        eventType: "trip_place.kept_separate",
        targetType: "duplicate_suggestion",
        targetId: suggestionId,
        summary: "Kept similar places as separate candidates",
      });
      await remember(transaction, userId, operation, key, { keptSeparate: true });
    });
  }

  async remove(
    userId: string,
    tripId: string,
    tripPlaceId: string,
    rawKey: string,
    input: RemoveTripPlaceInput,
  ) {
    uuid(tripPlaceId, "tripPlaceId");
    const key = requireIdempotencyKey(rawKey);
    const operation = `tp:remove:${tripPlaceId}`;
    await this.database.transaction().execute(async (transaction) => {
      await this.requireMember(transaction, userId, tripId);
      await lockMutation(transaction, userId, operation, key);
      if (await replayed(transaction, userId, operation, key)) return;
      await this.reconcileLegacyPlaces(transaction, tripId);
      await this.requireMember(transaction, userId, tripId);
      const current = await this.lockTripPlace(transaction, tripId, tripPlaceId);
      this.expectedVersion(current.version, input.expectedVersion);
      // Migration 007 derives assignments from legacy day rows: delete sources first.
      for (const table of ["trip_place_desired_days", "trip_place_excluded_days", "trip_place_day_assignments", "trip_place_votes"] as const) {
        await transaction.deleteFrom(table).where("trip_place_id", "=", tripPlaceId).execute();
      }
      const removedAt = this.now();
      await transaction.updateTable("trip_places").set({
        archived_at: removedAt,
        version: sql`version + 1`,
        updated_at: removedAt,
      }).where("id", "=", tripPlaceId).execute();
      await reopenRemovedProposals(transaction, tripId, removedAt, userId);
      await recordEvent(transaction, {
        tripId,
        actorId: userId,
        eventType: "trip_place.removed",
        targetType: "trip_place",
        targetId: tripPlaceId,
        summary: "Removed a place from the wishlist",
      });
      await remember(transaction, userId, operation, key, { removed: true });
    });
  }

  private async upsertProviderIdentity(
    transaction: Transaction<AlongTheWayDatabase>,
    candidate: ProviderPlaceCandidateDto,
  ) {
    const result = await sql<{ id: string }>`
      insert into place_identities (
        provider, provider_place_id, canonical_name, canonical_type,
        canonical_address, latitude, longitude, time_zone,
        provider_observed_at, provider_expires_at, provider_attribution,
        updated_at
      ) values (
        'google', ${candidate.providerPlaceId}, ${candidate.name}, ${candidate.type},
        ${candidate.address}, ${candidate.latitude}, ${candidate.longitude}, ${candidate.timeZone},
        ${candidate.observedAt}, ${candidate.expiresAt}, ${candidate.attribution}, ${this.now()}
      )
      on conflict (provider, provider_place_id) where provider_place_id is not null
      do update set
        canonical_name = excluded.canonical_name,
        canonical_type = excluded.canonical_type,
        canonical_address = excluded.canonical_address,
        latitude = excluded.latitude,
        longitude = excluded.longitude,
        time_zone = excluded.time_zone,
        provider_observed_at = excluded.provider_observed_at,
        provider_expires_at = excluded.provider_expires_at,
        provider_attribution = excluded.provider_attribution,
        updated_at = excluded.updated_at
      returning id
    `.execute(transaction);
    return result.rows[0]!;
  }

  private async reconcileLegacyPlaces(
    transaction: Transaction<AlongTheWayDatabase>,
    tripId: string,
  ) {
    await this.lockTripContent(transaction, tripId);
    await sql`
      select pg_advisory_xact_lock(
        hashtextextended(${"trip-place-legacy:" + tripId}, 0)
      )
    `.execute(transaction);

    // A retained release can mirror travel places while 016 remains applied.
    // Normalize those active mirrors on redeploy, preserving their contributions.
    const travelMirrors = await transaction.selectFrom("trip_places as wishlist")
      .innerJoin("places as place", (join) => join.onRef("place.id", "=", "wishlist.legacy_place_id")
        .onRef("place.trip_id", "=", "wishlist.trip_id"))
      .select("wishlist.id").where("wishlist.trip_id", "=", tripId)
      .where("wishlist.archived_at", "is", null).where("place.travel_only", "=", true).execute();
    if (travelMirrors.length > 0) {
      const ids = travelMirrors.map((place) => place.id);
      // Delete legacy sources before assignments because their triggers derive assignments.
      for (const table of ["trip_place_desired_days", "trip_place_excluded_days", "trip_place_day_assignments", "trip_place_votes"] as const) {
        await transaction.deleteFrom(table).where("trip_place_id", "in", ids).execute();
      }
      const archivedAt = this.now();
      await transaction.updateTable("trip_places").set({
        archived_at: archivedAt, version: sql`version + 1`, updated_at: archivedAt,
      }).where("trip_id", "=", tripId).where("id", "in", ids).execute();
    }

    await sql`
      update trip_places as trip_place
      set
        name = legacy.name,
        place_type = legacy.place_type,
        address = legacy.address,
        latitude = legacy.latitude,
        longitude = legacy.longitude,
        time_zone = legacy.time_zone,
        notes = legacy.notes,
        legacy_place_version = legacy.version,
        facts_source = 'member',
        version = trip_place.version + 1,
        updated_at = legacy.updated_at
      from places as legacy
      where trip_place.trip_id = ${tripId}
        and not legacy.travel_only
        and legacy.version > trip_place.legacy_place_version
        and legacy.trip_id = trip_place.trip_id
        and legacy.id = trip_place.legacy_place_id
        and (
          trip_place.name,
          trip_place.place_type,
          trip_place.address,
          trip_place.latitude,
          trip_place.longitude,
          trip_place.time_zone,
          trip_place.notes
        ) is distinct from (
          legacy.name,
          legacy.place_type,
          legacy.address,
          legacy.latitude,
          legacy.longitude,
          legacy.time_zone,
          legacy.notes
        )
    `.execute(transaction);

    await sql`
      update trip_places as trip_place
      set legacy_place_version = legacy.version
      from places as legacy
      where trip_place.trip_id = ${tripId}
        and not legacy.travel_only
        and legacy.version > trip_place.legacy_place_version
        and legacy.trip_id = trip_place.trip_id
        and legacy.id = trip_place.legacy_place_id
    `.execute(transaction);

    await sql`
      update place_identities as identity
      set
        canonical_name = legacy.name,
        canonical_type = legacy.place_type,
        canonical_address = legacy.address,
        latitude = legacy.latitude,
        longitude = legacy.longitude,
        time_zone = legacy.time_zone,
        updated_at = legacy.updated_at
      from trip_places as trip_place
      inner join places as legacy
        on legacy.trip_id = trip_place.trip_id
        and legacy.id = trip_place.legacy_place_id
      where trip_place.trip_id = ${tripId}
        and not legacy.travel_only
        and identity.id = trip_place.place_id
        and identity.provider = 'manual'
        and legacy.updated_at > identity.updated_at
        and (
          identity.canonical_name,
          identity.canonical_type,
          identity.canonical_address,
          identity.latitude,
          identity.longitude,
          identity.time_zone
        ) is distinct from (
          legacy.name,
          legacy.place_type,
          legacy.address,
          legacy.latitude,
          legacy.longitude,
          legacy.time_zone
        )
    `.execute(transaction);

    const missing = await transaction.selectFrom("places as legacy")
      .innerJoin("legacy_place_origins as origin", (join) =>
        join.onRef("origin.trip_id", "=", "legacy.trip_id")
          .onRef("origin.place_id", "=", "legacy.id"))
      .leftJoin("trip_places as tripPlace", (join) =>
        join.onRef("tripPlace.trip_id", "=", "legacy.trip_id")
          .onRef("tripPlace.legacy_place_id", "=", "legacy.id"))
      .select([
        "legacy.id",
        "legacy.trip_id",
        "legacy.name",
        "legacy.place_type",
        "legacy.address",
        "legacy.latitude",
        "legacy.longitude",
        "legacy.time_zone",
        "legacy.notes",
        "legacy.version",
        "legacy.updated_at",
        "origin.created_by",
        "origin.source_url as original_source_url",
        "origin.original_note",
        "origin.created_at",
      ])
      .where("legacy.trip_id", "=", tripId)
      .where("legacy.travel_only", "=", false)
      .where("tripPlace.id", "is", null)
      .execute();
    for (const legacy of missing) {
      await transaction.insertInto("place_identities").values({
        id: legacy.id,
        provider: "manual",
        provider_place_id: null,
        canonical_name: legacy.name,
        canonical_type: legacy.place_type,
        canonical_address: legacy.address,
        latitude: legacy.latitude,
        longitude: legacy.longitude,
        time_zone: legacy.time_zone,
        provider_observed_at: null,
        provider_expires_at: null,
        provider_attribution: null,
        created_at: legacy.created_at,
        updated_at: legacy.updated_at,
      }).execute();
      await transaction.insertInto("trip_places").values({
        id: legacy.id,
        trip_id: legacy.trip_id,
        place_id: legacy.id,
        legacy_place_id: legacy.id,
        legacy_place_version: legacy.version,
        name: legacy.name,
        place_type: legacy.place_type,
        address: legacy.address,
        facts_source: "member",
        latitude: legacy.latitude,
        longitude: legacy.longitude,
        time_zone: legacy.time_zone,
        duration_minutes: null,
        budget_amount_minor: null,
        budget_currency: null,
        notes: legacy.notes,
        provider_unavailable: false,
        archived_at: null,
        version: legacy.version,
        created_by: legacy.created_by,
        created_at: legacy.created_at,
        updated_at: legacy.updated_at,
      }).execute();
      await transaction.insertInto("trip_place_contributions").values({
        trip_id: legacy.trip_id,
        trip_place_id: legacy.id,
        member_user_id: legacy.created_by,
        intake_method: "manual",
        source_url: legacy.original_source_url,
        original_note: legacy.original_note,
        provider_observed_at: null,
        withdrawn_at: null,
        created_at: legacy.created_at,
      }).execute();
      await suggestPossibleTripPlaceDuplicates(
        transaction,
        tripId,
        legacy.id,
        legacy,
      );
    }
    await reopenRemovedProposals(transaction, tripId, this.now());
  }

  private async readList(executor: DatabaseExecutor, userId: string, tripId: string) {
    const placeRows = await executor.selectFrom("trip_places as tripPlace")
      .innerJoin("place_identities as place", "place.id", "tripPlace.place_id")
      .innerJoin("places as legacy", "legacy.id", "tripPlace.legacy_place_id")
      .select([
        "tripPlace.id",
        "tripPlace.trip_id",
        "tripPlace.place_id",
        "tripPlace.legacy_place_id",
        "tripPlace.facts_source",
        "tripPlace.name",
        "tripPlace.place_type",
        "tripPlace.address",
        "tripPlace.latitude",
        "tripPlace.longitude",
        "tripPlace.time_zone",
        "tripPlace.duration_minutes",
        "tripPlace.budget_amount_minor",
        "tripPlace.budget_currency",
        "tripPlace.notes",
        "legacy.source_url",
        "tripPlace.provider_unavailable",
        "tripPlace.version",
        "tripPlace.created_at",
        "place.provider",
        "place.provider_place_id",
        "place.provider_observed_at",
        "place.provider_expires_at",
        "place.provider_attribution",
        "place.canonical_name",
        "place.canonical_type",
        "place.canonical_address",
        "place.latitude as canonical_latitude",
        "place.longitude as canonical_longitude",
        "place.time_zone as canonical_time_zone",
      ]).where("tripPlace.trip_id", "=", tripId)
      .where("tripPlace.archived_at", "is", null)
      .orderBy("tripPlace.created_at").execute();
    if (placeRows.length === 0) return [];
    const ids = placeRows.map((row) => row.id);
    const legacyPlaceIds = placeRows.map((row) => row.legacy_place_id);
    const [contributions, members, voteRows, assignmentRows, duplicateRows, scheduledRows, aiProposalRows] = await Promise.all([
      executor.selectFrom("trip_place_contributions")
        .distinctOn("trip_place_id")
        .select(["trip_place_id", "source_url"])
        .where("trip_place_id", "in", ids)
        .orderBy("trip_place_id").orderBy("created_at").orderBy("id").execute(),
      executor.selectFrom("trip_members").innerJoin("users", "users.id", "trip_members.user_id")
        .select(["trip_members.user_id", "trip_members.joined_at", "users.email", "users.display_name"])
        .where("trip_members.trip_id", "=", tripId).where("trip_members.removed_at", "is", null)
        .orderBy("trip_members.joined_at").execute(),
      executor.selectFrom("trip_place_votes").selectAll()
        .where("trip_place_id", "in", ids).execute(),
      executor.selectFrom("trip_place_day_assignments").selectAll()
        .where("trip_place_id", "in", ids).execute(),
      executor.selectFrom("trip_place_duplicate_suggestions").selectAll()
        .where("trip_id", "=", tripId).where("status", "=", "pending")
        .where("first_trip_place_id", "in", ids)
        .where("second_trip_place_id", "in", ids).execute(),
      executor.selectFrom("itinerary_endpoints").select("place_id")
        .where("trip_id", "=", tripId).where("place_id", "in", legacyPlaceIds).execute(),
      executor.selectFrom("candidate_proposals")
        .select(["id", "accepted_trip_place_id"])
        .where("trip_id", "=", tripId)
        .where("accepted_trip_place_id", "in", ids)
        .execute(),
    ]);
    const scheduled = new Set(scheduledRows.map((row) => row.place_id));
    const aiProposalByTripPlaceId = new Map(
      aiProposalRows.flatMap((proposal) => proposal.accepted_trip_place_id
        ? [[proposal.accepted_trip_place_id, proposal.id] as const]
        : []),
    );
    const votesByKey = new Set(voteRows.map((row) => `${row.trip_place_id}:${row.member_user_id}`));
    const assignmentByPlaceId = new Map(
      assignmentRows.map((assignment) => [assignment.trip_place_id, assignment]),
    );
    const originalSources = new Map(contributions.map((entry) => [entry.trip_place_id, entry.source_url]));
    const places = placeRows.map((row): TripPlaceDto => {
      const voters = members.filter((member) => votesByKey.has(`${row.id}:${member.user_id}`)).map((member) => ({
        memberUserId: member.user_id,
        memberEmail: member.email,
        memberDisplayName: member.display_name,
      }));
      const suggestions = duplicateRows.filter((suggestion) =>
        suggestion.first_trip_place_id === row.id || suggestion.second_trip_place_id === row.id,
      ).map((suggestion) => ({
        id: suggestion.id,
        otherTripPlaceId: suggestion.first_trip_place_id === row.id
          ? suggestion.second_trip_place_id
          : suggestion.first_trip_place_id,
        reason: suggestion.reason,
        status: suggestion.status,
      }));
      const providerFacts = row.facts_source === "provider";
      const name = providerFacts ? row.canonical_name : row.name;
      const type = providerFacts ? row.canonical_type : row.place_type;
      const address = providerFacts ? row.canonical_address : row.address;
      const latitude = providerFacts ? row.canonical_latitude : row.latitude;
      const longitude = providerFacts ? row.canonical_longitude : row.longitude;
      const resolvedTimeZone = providerFacts ? row.canonical_time_zone : row.time_zone;
      const isScheduled = scheduled.has(row.legacy_place_id);
      const status = isScheduled
        ? "scheduled"
        : suggestions.length > 0
          ? "possible-duplicate"
          : row.provider_unavailable
            ? "provider-unavailable"
            : latitude === null || longitude === null
              ? "needs-location"
              : "ready";
      const providerExpiresAt = providerFacts && row.provider_expires_at
        ? isoTimestamp(row.provider_expires_at)
        : null;
      return {
        id: row.id,
        tripId: row.trip_id,
        placeId: row.place_id,
        aiProposalId: aiProposalByTripPlaceId.get(row.id) ?? null,
        provider: row.provider,
        providerPlaceId: row.provider_place_id,
        providerObservedAt: providerFacts && row.provider_observed_at
          ? isoTimestamp(row.provider_observed_at)
          : null,
        providerExpiresAt,
        providerAttribution: row.provider_attribution,
        factsSource: row.facts_source,
        providerFactsExpired: providerExpiresAt !== null && providerExpiresAt <= this.now().toISOString(),
        name,
        type,
        address,
        latitude,
        longitude,
        timeZone: resolvedTimeZone,
        status,
        scheduled: isScheduled,
        durationMinutes: row.duration_minutes,
        assignedDayId: assignmentByPlaceId.get(row.id)?.trip_day_id ?? null,
        dayPosition: assignmentByPlaceId.get(row.id)?.day_position ?? null,
        budgetAmountMinor: row.budget_amount_minor === null ? null : Number(row.budget_amount_minor),
        budgetCurrency: row.budget_currency,
        notes: row.notes,
        sourceUrl: originalSources.get(row.id) ?? row.source_url,
        voters,
        voteCount: voters.length,
        ownVote: voters.some((member) => member.memberUserId === userId),
        votingAvailable: members.length >= 2,
        duplicateSuggestions: suggestions,
        version: row.version,
      };
    });
    return members.length >= 2 ? places.sort((left, right) => right.voteCount - left.voteCount) : places;
  }

  private async readOne(
    executor: DatabaseExecutor,
    userId: string,
    tripId: string,
    tripPlaceId: string,
  ) {
    const place = (await this.readList(executor, userId, tripId)).find(
      (candidate) => candidate.id === tripPlaceId,
    );
    if (!place) throw new AppError("trip_place_not_found", "Trip place not found", 404);
    return place;
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

  private async lockTripPlace(
    transaction: Transaction<AlongTheWayDatabase>,
    tripId: string,
    tripPlaceId: string,
  ) {
    const row = await transaction.selectFrom("trip_places").selectAll()
      .where("id", "=", tripPlaceId).where("trip_id", "=", tripId)
      .where("archived_at", "is", null).forUpdate().executeTakeFirst();
    if (!row) throw new AppError("trip_place_not_found", "Trip place not found", 404);
    return row;
  }

  private async requireMember(
    executor: DatabaseExecutor,
    userId: string,
    tripId: string,
  ) {
    const membership = await executor.selectFrom("trip_members").select("role")
      .where("trip_id", "=", tripId).where("user_id", "=", userId)
      .where("removed_at", "is", null).executeTakeFirst();
    if (!membership) throw new AppError("trip_not_found", "Trip not found", 404);
    return membership;
  }

  private expectedVersion(current: number, expected: number) {
    if (!Number.isSafeInteger(expected) || expected !== current) {
      throw new AppError(
        "conflict",
        `Version conflict; current version is ${current}`,
        409,
        undefined,
        current,
      );
    }
  }

  private async mergeDayPreferences(
    transaction: Transaction<AlongTheWayDatabase>,
    table: "trip_place_desired_days" | "trip_place_excluded_days",
    sourceTripPlaceId: string,
    targetTripPlaceId: string,
    tripId: string,
  ) {
    const rows = await transaction.selectFrom(table).select("trip_day_id")
      .where("trip_place_id", "=", sourceTripPlaceId).execute();
    if (rows.length > 0) {
      await transaction.insertInto(table).values(rows.map((row) => ({
        trip_id: tripId,
        trip_place_id: targetTripPlaceId,
        trip_day_id: row.trip_day_id,
      }))).onConflict((conflict) =>
        conflict.columns(["trip_place_id", "trip_day_id"]).doNothing()
      ).execute();
    }
    await transaction.deleteFrom(table)
      .where("trip_place_id", "=", sourceTripPlaceId)
      .execute();
  }


  private async markProviderUnavailable(tripId: string) {
    await this.setProviderUnavailable(tripId, true);
  }

  private async clearProviderUnavailable(tripId: string) {
    await this.setProviderUnavailable(tripId, false);
  }

  private async setProviderUnavailable(tripId: string, unavailable: boolean) {
    await this.database.transaction().execute(async (transaction) => {
      await this.lockTripContent(transaction, tripId);
      await transaction.updateTable("trip_places")
        .set({ provider_unavailable: unavailable })
        .where("trip_id", "=", tripId)
        .where(
          "place_id",
          "in",
          transaction.selectFrom("place_identities")
            .select("id")
            .where("provider", "=", "google"),
        )
        .execute();
    });
  }
}
