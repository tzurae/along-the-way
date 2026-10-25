import {
  isTripPlaceMealRole,
  parseTripPlaceListResponse,
  parseTripPlaceResponse,
  parseTripPlaceMustItemResponse,
  type CreateTripPlaceInput,
  type MergeTripPlacesInput,
  type MustItemKind,
  type NearbyAlternativeDto,
  type NearbyAlternativesResponse,
  type ProviderCandidatesResponse,
  type ProviderPlaceCandidateDto,
  type ProviderPlaceSearchResultDto,
  type RemoveTripPlaceInput,
  type TripPlaceDto,
  type TripPlaceMustItemDto,
  type UpdateMemberVoteInput,
  type UpdateTripPlaceDayAssignmentsInput,
  type UpdateTripPlacePlanningInput,
} from "@along-the-way/contracts/trip-places";
import { parsePlaceKeepResponse, type KeepTripPlaceInput } from "@along-the-way/contracts/place-keeps";
import { isPlaceType, type PlaceType } from "@along-the-way/contracts/trip-skeleton";
import { sql, type Kysely, type Transaction } from "kysely";

import type { AlongTheWayDatabase } from "../database/database";
import { reopenRemovedProposals } from "../discovery/reopen-removed-proposals";
import { straightLineMeters } from "../planning/day-route-order";
import { AppError } from "../private-trips/private-trip-module";
import {
  dateOnly,
  isoTimestamp,
  lockMutation,
  recordEvent,
  remember,
  replayed,
  requireIdempotencyKey,
  requireDayVersion,
  requireScheduler,
  type DatabaseExecutor,
} from "../private-trips/postgres-private-trip-store";
import {
  googlePlacePhotoDto,
  ProviderQuotaError,
  ProviderUnavailableError,
  type PlaceProvider,
  type ProviderPlaceCandidate,
} from "./google-places-provider";
import { GooglePhotoCapability } from "./google-photo-capability";
import {
  GoogleMapsUrlError,
  defaultGoogleMapsUrlResolverDependencies,
  googleMapsPlaceId,
  googleMapsSearchText,
  resolveGoogleMapsUrl,
  type GoogleMapsUrlResolverDependencies,
} from "./safe-google-maps-url";
import type { TripPlaceModule } from "./trip-place-module";
import type { PreparedCommonsPhoto, RepresentativePhotoSource } from "../place-details/commons-place-photos";
import type { CommonsCandidateGenerator } from "../place-details/commons-photo-candidates";
import { upsertGooglePlaceIdentity } from "./google-place-identity";
import { placeKeepNote, readPlaceKeeps } from "./place-keeps";

interface ModuleOptions {
  database: Kysely<AlongTheWayDatabase>;
  provider: PlaceProvider;
  urlResolver?: GoogleMapsUrlResolverDependencies;
  now?: () => Date;
  photoCapabilitySecret?: string;
  /** Looks up a freely licensed representative photo once, when a Google place is added. */
  commonsPhotos?: RepresentativePhotoSource;
  /** Finds and auto-applies a licensed Commons candidate after strict CID matching misses. */
  commonsCandidates?: CommonsCandidateGenerator;
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
const ISO_CURRENCIES = new Set(Intl.supportedValuesOf("currency"));


// Google Places Table A, checked against the official place-types documentation.
const NEARBY_TYPES: Partial<Record<PlaceType, readonly string[]>> = {
  restaurant: ["restaurant"],
  cafe: ["cafe", "coffee_shop", "bakery", "dessert_shop", "tea_house", "confectionery", "ice_cream_shop"],
  worship: ["buddhist_temple", "shinto_shrine", "church", "hindu_temple", "mosque", "synagogue"],
  museum: ["museum", "art_gallery"],
  nature: ["park", "garden", "botanical_garden", "national_park", "hiking_area"],
  shopping: ["market", "shopping_mall", "department_store", "gift_shop"],
  activity: ["tourist_attraction", "historical_landmark", "cultural_landmark", "amusement_park", "observation_deck"],
};

function located<T extends { latitude: number | null; longitude: number | null }>(
  place: T,
): place is T & { latitude: number; longitude: number } {
  return place.latitude !== null && Number.isFinite(place.latitude) && Math.abs(place.latitude) <= 90
    && place.longitude !== null && Number.isFinite(place.longitude) && Math.abs(place.longitude) <= 180;
}
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
  if (!isPlaceType(value)) throw new AppError("validation_error", "type is invalid");
  return value;
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

const TRIP_PLACES_READBACK = "trip_places_readback";

function isTripPlacesReadback(value: unknown) {
  return typeof value === "object"
    && value !== null
    && Reflect.get(value, "type") === TRIP_PLACES_READBACK;
}

function normalizedSimilarity(value: string | null) {
  return value?.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "") ?? "";
}

function exactNameFirst(query: string, candidates: ProviderPlaceCandidate[]) {
  const normalizedQuery = normalizedSimilarity(query);
  const exact: ProviderPlaceCandidate[] = [];
  const other: ProviderPlaceCandidate[] = [];
  for (const candidate of candidates) {
    (normalizedSimilarity(candidate.name) === normalizedQuery ? exact : other).push(candidate);
  }
  exact.push(...other);
  return exact;
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

function mustItemInput(input: { kind: unknown; label: unknown }) {
  if (input.kind !== "buy" && input.kind !== "eat" && input.kind !== "drink") {
    throw new AppError("validation_error", "kind must be buy, eat, or drink");
  }
  const label = requiredText(input.label, "label", 80);
  return {
    kind: input.kind as MustItemKind,
    label,
    normalizedLabel: label.normalize("NFKC").toLocaleLowerCase("und").replace(/\s+/gu, " "),
  };
}

function mustItemDto(row: {
  id: string;
  trip_place_id: string;
  kind: MustItemKind;
  label: string;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}): TripPlaceMustItemDto {
  return {
    id: row.id,
    tripPlaceId: row.trip_place_id,
    kind: row.kind,
    label: row.label,
    version: row.version,
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at),
  };
}

export class PostgresTripPlaceModule implements TripPlaceModule {
  private readonly database: Kysely<AlongTheWayDatabase>;
  private readonly provider: PlaceProvider;
  private readonly urlResolver: GoogleMapsUrlResolverDependencies;
  private readonly now: () => Date;
  private readonly photoCapability: GooglePhotoCapability | undefined;
  private readonly commonsPhotos: RepresentativePhotoSource | undefined;
  private readonly commonsCandidates: CommonsCandidateGenerator | undefined;
  private readonly pendingAdds = new Map<string, Promise<TripPlaceDto>>();

  constructor(options: ModuleOptions) {
    this.database = options.database;
    this.provider = options.provider;
    this.urlResolver =
      options.urlResolver ?? defaultGoogleMapsUrlResolverDependencies;
    this.now = options.now ?? (() => new Date());
    this.photoCapability = options.photoCapabilitySecret
      ? new GooglePhotoCapability(options.photoCapabilitySecret, this.now)
      : undefined;
    this.commonsPhotos = options.commonsPhotos;
    this.commonsCandidates = options.commonsCandidates;
  }

  async list(userId: string, tripId: string) {
    return this.database.transaction().execute(async (transaction) => {
      await this.requireMember(transaction, userId, tripId);
      await this.reconcileLegacyPlaces(transaction, tripId);
      return this.readList(transaction, userId, tripId);
    });
  }

  async listMustItems(userId: string, tripId: string, tripPlaceId: string) {
    tripPlaceId = uuid(tripPlaceId, "tripPlaceId").toLowerCase();
    return this.database.transaction().execute(async (transaction) => {
      await this.requireMember(transaction, userId, tripId);
      const place = await transaction.selectFrom("trip_places")
        .select("id")
        .where("id", "=", tripPlaceId)
        .where("trip_id", "=", tripId)
        .where("archived_at", "is", null)
        .executeTakeFirst();
      if (!place) throw new AppError("trip_place_not_found", "Trip place not found", 404);
      const rows = await transaction.selectFrom("trip_place_must_items")
        .selectAll()
        .where("trip_id", "=", tripId)
        .where("trip_place_id", "=", tripPlaceId)
        .orderBy(sql<number>`case kind when 'buy' then 1 when 'eat' then 2 else 3 end`)
        .orderBy("created_at")
        .orderBy("id")
        .execute();
      return rows.map(mustItemDto);
    });
  }

  async createMustItem(
    userId: string,
    tripId: string,
    tripPlaceId: string,
    rawKey: string,
    input: { kind: MustItemKind; label: string },
  ) {
    tripPlaceId = uuid(tripPlaceId, "tripPlaceId").toLowerCase();
    const key = requireIdempotencyKey(rawKey);
    const operation = `tmc:${tripId.toLowerCase()}:${tripPlaceId}`;
    const parsed = mustItemInput(input);
    return this.database.transaction().execute(async (transaction) => {
      await this.requireMember(transaction, userId, tripId);
      await lockMutation(transaction, userId, operation, key);
      const replay = await replayed(transaction, userId, operation, key);
      if (replay) {
        return parseTripPlaceMustItemResponse({ item: replay }).item;
      }
      await this.lockTripPlace(transaction, tripId, tripPlaceId);
      const duplicate = await transaction.selectFrom("trip_place_must_items")
        .select("id")
        .where("trip_place_id", "=", tripPlaceId)
        .where("kind", "=", parsed.kind)
        .where("normalized_label", "=", parsed.normalizedLabel)
        .executeTakeFirst();
      if (duplicate) {
        throw new AppError("must_item_duplicate", "This must-item is already in the list", 409);
      }
      const count = await transaction.selectFrom("trip_place_must_items")
        .select((builder) => builder.fn.countAll().as("count"))
        .where("trip_place_id", "=", tripPlaceId)
        .executeTakeFirstOrThrow();
      if (Number(count.count) >= 24) {
        throw new AppError("must_item_limit", "Each place can have at most 24 must-items", 409);
      }
      const createdAt = this.now();
      const row = await transaction.insertInto("trip_place_must_items").values({
        trip_id: tripId,
        trip_place_id: tripPlaceId,
        kind: parsed.kind,
        label: parsed.label,
        normalized_label: parsed.normalizedLabel,
        created_by: userId,
        created_at: createdAt,
        updated_at: createdAt,
      }).returningAll().executeTakeFirstOrThrow();
      const response = mustItemDto(row);
      await recordEvent(transaction, {
        tripId,
        actorId: userId,
        eventType: "trip_place.must_item_created",
        targetType: "trip_place_must_item",
        targetId: row.id,
        summary: "Added a must-item to a wishlist place",
        relatedTargetIds: [tripPlaceId],
      });
      await remember(transaction, userId, operation, key, response);
      return response;
    });
  }

  async updateMustItem(
    userId: string,
    tripId: string,
    tripPlaceId: string,
    itemId: string,
    rawKey: string,
    input: { kind: MustItemKind; label: string; expectedVersion: number },
  ) {
    tripPlaceId = uuid(tripPlaceId, "tripPlaceId").toLowerCase();
    itemId = uuid(itemId, "itemId").toLowerCase();
    const key = requireIdempotencyKey(rawKey);
    const operation = `tmu:${tripId.toLowerCase()}:${itemId}`;
    const parsed = mustItemInput(input);
    return this.database.transaction().execute(async (transaction) => {
      await this.requireMember(transaction, userId, tripId);
      await lockMutation(transaction, userId, operation, key);
      const replay = await replayed(transaction, userId, operation, key);
      if (replay) {
        return parseTripPlaceMustItemResponse({ item: replay }).item;
      }
      await this.lockTripPlace(transaction, tripId, tripPlaceId);
      const current = await transaction.selectFrom("trip_place_must_items")
        .selectAll()
        .where("id", "=", itemId)
        .where("trip_id", "=", tripId)
        .where("trip_place_id", "=", tripPlaceId)
        .executeTakeFirst();
      if (!current) throw new AppError("item_not_found", "Must-item not found", 404);
      this.expectedVersion(current.version, input.expectedVersion, itemId);
      const duplicate = await transaction.selectFrom("trip_place_must_items")
        .select("id")
        .where("trip_place_id", "=", tripPlaceId)
        .where("kind", "=", parsed.kind)
        .where("normalized_label", "=", parsed.normalizedLabel)
        .where("id", "!=", itemId)
        .executeTakeFirst();
      if (duplicate) {
        throw new AppError("must_item_duplicate", "This must-item is already in the list", 409);
      }
      const row = await transaction.updateTable("trip_place_must_items").set({
        kind: parsed.kind,
        label: parsed.label,
        normalized_label: parsed.normalizedLabel,
        version: sql`version + 1`,
        updated_at: this.now(),
      }).where("id", "=", itemId).returningAll().executeTakeFirstOrThrow();
      const response = mustItemDto(row);
      await recordEvent(transaction, {
        tripId,
        actorId: userId,
        eventType: "trip_place.must_item_updated",
        targetType: "trip_place_must_item",
        targetId: itemId,
        summary: "Updated a wishlist place must-item",
        relatedTargetIds: [tripPlaceId],
      });
      await remember(transaction, userId, operation, key, response);
      return response;
    });
  }

  async removeMustItem(
    userId: string,
    tripId: string,
    tripPlaceId: string,
    itemId: string,
    rawKey: string,
    expectedVersion: number,
  ) {
    tripPlaceId = uuid(tripPlaceId, "tripPlaceId").toLowerCase();
    itemId = uuid(itemId, "itemId").toLowerCase();
    const key = requireIdempotencyKey(rawKey);
    const operation = `tmr:${tripId.toLowerCase()}:${itemId}`;
    await this.database.transaction().execute(async (transaction) => {
      await this.requireMember(transaction, userId, tripId);
      await lockMutation(transaction, userId, operation, key);
      if (await replayed(transaction, userId, operation, key)) return;
      await this.lockTripPlace(transaction, tripId, tripPlaceId);
      const current = await transaction.selectFrom("trip_place_must_items")
        .select(["id", "version"])
        .where("id", "=", itemId)
        .where("trip_id", "=", tripId)
        .where("trip_place_id", "=", tripPlaceId)
        .executeTakeFirst();
      if (!current) throw new AppError("item_not_found", "Must-item not found", 404);
      this.expectedVersion(current.version, expectedVersion, itemId);
      await transaction.deleteFrom("trip_place_must_items")
        .where("id", "=", itemId)
        .execute();
      await recordEvent(transaction, {
        tripId,
        actorId: userId,
        eventType: "trip_place.must_item_removed",
        targetType: "trip_place_must_item",
        targetId: itemId,
        summary: "Removed a must-item from a wishlist place",
        relatedTargetIds: [tripPlaceId],
      });
      await remember(transaction, userId, operation, key, { removed: true });
    });
  }

  async search(
    userId: string,
    tripId: string,
    query: string,
  ): Promise<ProviderCandidatesResponse> {
    await this.requireMember(this.database, userId, tripId);
    const options = await this.googleRequestOptions(tripId);
    try {
      const providerCandidates = await this.provider.search(query, { ...options, pageSize: 3 });
      const candidates = await this.searchResults(userId, tripId, exactNameFirst(query, providerCandidates).slice(0, 3));
      await this.clearProviderUnavailable(tripId);
      return { candidates, attribution: this.provider.attribution };
    } catch (error) {
      if (error instanceof TypeError) {
        throw new AppError("validation_error", error.message);
      }
      if (error instanceof ProviderQuotaError) {
        throw new AppError("provider_quota", error.message, 503);
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

  async nearbyAlternatives(
    userId: string, tripId: string, rawDayId: string, rawTripPlaceId: string,
  ): Promise<NearbyAlternativesResponse> {
    const dayId = uuid(rawDayId, "dayId").toLowerCase();
    const tripPlaceId = uuid(rawTripPlaceId, "tripPlaceId").toLowerCase();
    await requireScheduler(this.database, userId, tripId);
    const day = await this.database.selectFrom("trip_days").select("version")
      .where("trip_id", "=", tripId).where("id", "=", dayId).executeTakeFirst();
    if (!day) throw new AppError("trip_day_not_found", "Trip day not found", 404);
    const places = await this.readList(this.database, userId, tripId);
    const stop = this.requireAlternativeStop(places, tripPlaceId, dayId, day.version);
    const includedTypes = NEARBY_TYPES[stop.type]!;
    const options = await this.googleRequestOptions(tripId);
    let candidates;
    try {
      if (!this.provider.searchNearby) throw new ProviderUnavailableError();
      candidates = await this.provider.searchNearby({
        ...options, latitude: stop.latitude, longitude: stop.longitude, includedTypes,
      });
    } catch (error) {
      this.throwAlternativeProviderError(error);
    }
    const occupied = new Set(places.filter((place) => place.assignedDayId !== null || place.scheduled)
      .map((place) => place.providerPlaceId));
    const archived = await this.database.selectFrom("trip_places as place")
      .innerJoin("place_identities as identity", "identity.id", "place.place_id")
      .select("identity.provider_place_id")
      .where("place.trip_id", "=", tripId).where("place.archived_at", "is not", null)
      .where("identity.provider", "=", "google").execute();
    for (const place of archived) occupied.add(place.provider_place_id);
    const seen = new Set<string>();
    const filtered = candidates.filter(({ candidate }) => {
      if (candidate.type !== stop.type || !located(candidate)
        || candidate.providerPlaceId === stop.providerPlaceId
        || occupied.has(candidate.providerPlaceId) || seen.has(candidate.providerPlaceId)) return false;
      seen.add(candidate.providerPlaceId);
      return true;
    }).sort((left, right) => {
      if (left.rating === null && right.rating !== null) return 1;
      if (left.rating !== null && right.rating === null) return -1;
      return (right.rating ?? 0) - (left.rating ?? 0)
        || (right.userRatingCount ?? 0) - (left.userRatingCount ?? 0);
    }).slice(0, 8);
    const photos = await this.searchResults(userId, tripId, filtered.map((entry) => entry.candidate));
    const alternatives = filtered.map(({ candidate, rating, userRatingCount }, index): NearbyAlternativeDto => ({
      providerPlaceId: candidate.providerPlaceId,
      name: candidate.name,
      type: candidate.type,
      address: candidate.address,
      latitude: candidate.latitude!,
      longitude: candidate.longitude!,
      sourceUrl: candidate.sourceUrl,
      attribution: candidate.attribution,
      photo: photos[index]!.photo,
      rating,
      userRatingCount,
      straightLineMeters: Math.round(straightLineMeters(stop, {
        id: candidate.providerPlaceId, latitude: candidate.latitude!, longitude: candidate.longitude!,
      })),
    }));
    return { dayId, stopTripPlaceId: tripPlaceId, dayVersion: day.version, alternatives };
  }

  private throwAlternativeProviderError(error: unknown): never {
    if (error instanceof ProviderQuotaError) throw new AppError("provider_quota", error.message, 503);
    throw new AppError("provider_unavailable",
      error instanceof ProviderUnavailableError ? error.message : "Google Places is temporarily unavailable", 503);
  }

  private requireAlternativeStop(places: TripPlaceDto[], tripPlaceId: string, dayId: string, dayVersion: number) {
    const stop = places.find((place) => place.id === tripPlaceId);
    if (!stop) throw new AppError("trip_place_not_found", "Trip place not found", 404);
    if (stop.assignedDayId !== dayId || stop.scheduled) {
      throw new AppError("conflict", "The stop is no longer an untimed place on this day", 409, undefined, dayVersion, dayId);
    }
    if (!NEARBY_TYPES[stop.type] || !located(stop)) {
      throw new AppError("alternatives_unsupported", "Nearby alternatives require a supported place type and coordinates", 422);
    }
    return stop;
  }

  async replaceStop(
    userId: string, tripId: string, rawDayId: string, rawTripPlaceId: string, rawKey: string,
    input: { expectedDayVersion: number; providerPlaceId: string },
  ): Promise<TripPlaceDto[]> {
    const dayId = uuid(rawDayId, "dayId").toLowerCase();
    const tripPlaceId = uuid(rawTripPlaceId, "tripPlaceId").toLowerCase();
    const providerPlaceId = requiredText(input.providerPlaceId, "providerPlaceId", 300);
    if (!/^[A-Za-z0-9_-]{8,300}$/.test(providerPlaceId)) throw new AppError("validation_error", "Invalid Google place identity");
    const key = requireIdempotencyKey(rawKey);
    // mutation_requests.operation is varchar(80): the day already scopes the trip (4 + 36 + 1 + 36 = 77).
    const operation = `tsr:${dayId.toLowerCase()}:${tripPlaceId.toLowerCase()}`;
    // Authorize and replay before spending quota; never keep a transaction open for Google.
    const earlyReplay = await this.database.transaction().execute(async (transaction) => {
      await requireScheduler(transaction, userId, tripId);
      await lockMutation(transaction, userId, operation, key);
      await this.lockTripContent(transaction, tripId);
      await requireScheduler(transaction, userId, tripId);
      if (await replayed(transaction, userId, operation, key)) return this.readList(transaction, userId, tripId);
      await requireDayVersion(transaction, tripId, dayId, input.expectedDayVersion);
      const places = await this.readList(transaction, userId, tripId);
      const stop = this.requireAlternativeStop(places, tripPlaceId, dayId, input.expectedDayVersion);
      const existing = places.find((place) => place.provider === "google" && place.providerPlaceId === providerPlaceId);
      if (providerPlaceId === stop.providerPlaceId || (existing && (existing.assignedDayId !== null || existing.scheduled))) {
        throw new AppError("conflict", "The candidate is already arranged", 409, undefined, input.expectedDayVersion, dayId);
      }
      return null;
    });
    if (earlyReplay) return earlyReplay;
    let candidate: ProviderPlaceCandidate;
    try {
      candidate = await this.provider.getPlace(providerPlaceId, await this.googleRequestOptions(tripId));
    } catch (error) {
      this.throwAlternativeProviderError(error);
    }
    return this.database.transaction().execute(async (transaction) => {
      await requireScheduler(transaction, userId, tripId);
      await lockMutation(transaction, userId, operation, key);
      await this.lockTripContent(transaction, tripId);
      await requireScheduler(transaction, userId, tripId);
      if (await replayed(transaction, userId, operation, key)) return this.readList(transaction, userId, tripId);
      await this.reconcileLegacyPlaces(transaction, tripId);
      await requireDayVersion(transaction, tripId, dayId, input.expectedDayVersion);
      const places = await this.readList(transaction, userId, tripId);
      const stop = this.requireAlternativeStop(places, tripPlaceId, dayId, input.expectedDayVersion);
      const conflict = (message: string): never => {
        throw new AppError("conflict", message, 409, undefined, input.expectedDayVersion, dayId);
      };
      if (candidate.providerPlaceId !== providerPlaceId || candidate.type !== stop.type || !located(candidate)
        || straightLineMeters(stop, { ...candidate, id: providerPlaceId }) > 1000) {
        return conflict("The candidate is no longer a nearby place of the same type");
      }
      const existing = await transaction.selectFrom("trip_places as place")
        .innerJoin("place_identities as identity", "identity.id", "place.place_id")
        .select(["place.id", "place.archived_at"])
        .where("place.trip_id", "=", tripId).where("identity.provider", "=", "google")
        .where("identity.provider_place_id", "=", providerPlaceId).forUpdate("place").executeTakeFirst();
      const reusable = existing ? places.find((place) => place.id === existing.id) : undefined;
      if (existing && (!reusable || existing.archived_at !== null
        || reusable.assignedDayId !== null || reusable.scheduled || reusable.id === stop.id)) {
        return conflict("The candidate is archived or already arranged");
      }
      if (reusable && reusable.type !== stop.type) return conflict("The candidate's trip category no longer matches the stop");
      await this.lockTripPlace(transaction, tripId, stop.id);
      const previous = await transaction.selectFrom("trip_stop_replacements").selectAll()
        .where("trip_id", "=", tripId).where("replacement_trip_place_id", "=", stop.id)
        .where("trip_day_id", "=", dayId).where("status", "=", "active").forUpdate().executeTakeFirst();
      const originalId = previous?.original_trip_place_id ?? stop.id;
      const replacementId = reusable?.id
        ?? await this.addObservedCandidateInTransaction(transaction, userId, tripId, candidate);
      const updatedAt = this.now();
      // A formerly moved replacement may still have historical state; it must not attach to this new slot.
      await transaction.updateTable("trip_stop_replacements").set({ status: "superseded", updated_at: updatedAt })
        .where("trip_id", "=", tripId).where("replacement_trip_place_id", "=", replacementId)
        .where("status", "=", "active").execute();
      if (previous) {
        await transaction.updateTable("trip_stop_replacements")
          .set({ status: replacementId === originalId ? "undone" : "superseded", updated_at: updatedAt })
          .where("id", "=", previous.id).execute();
      }
      const position = await this.replacementSlot(transaction, tripId, dayId, stop, places);
      await this.swapStopAssignment(transaction, userId, tripId, dayId, stop.id, replacementId, position, updatedAt);
      // Selecting the root from nearby results is also a restoration; never create a self-relation.
      if (replacementId !== originalId) {
        await transaction.insertInto("trip_stop_replacements").values({
          trip_id: tripId, trip_day_id: dayId, original_trip_place_id: originalId,
          replacement_trip_place_id: replacementId, status: "active", created_by: userId,
          created_at: updatedAt, updated_at: updatedAt,
        }).execute();
      }
      await recordEvent(transaction, {
        tripId, actorId: userId, eventType: "trip_place.stop_replaced", targetType: "trip_place",
        targetId: replacementId, relatedTargetIds: [dayId, stop.id, originalId], summary: "Replaced a planned stop",
      });
      await remember(transaction, userId, operation, key, { type: TRIP_PLACES_READBACK });
      return this.readList(transaction, userId, tripId);
    });
  }

  async undoStopReplacement(
    userId: string, tripId: string, rawReplacementId: string, rawKey: string,
  ): Promise<TripPlaceDto[]> {
    const replacementId = uuid(rawReplacementId, "replacementId").toLowerCase();
    const key = requireIdempotencyKey(rawKey);
    const operation = `tsu:${tripId}:${replacementId}`;
    return this.database.transaction().execute(async (transaction) => {
      await requireScheduler(transaction, userId, tripId);
      await lockMutation(transaction, userId, operation, key);
      await this.lockTripContent(transaction, tripId);
      await requireScheduler(transaction, userId, tripId);
      if (await replayed(transaction, userId, operation, key)) return this.readList(transaction, userId, tripId);
      await this.reconcileLegacyPlaces(transaction, tripId);
      const relation = await transaction.selectFrom("trip_stop_replacements").selectAll()
        .where("trip_id", "=", tripId).where("id", "=", replacementId).forUpdate().executeTakeFirst();
      if (!relation) throw new AppError("trip_place_not_found", "Stop replacement not found", 404);
      const day = await transaction.selectFrom("trip_days").select("version")
        .where("trip_id", "=", tripId).where("id", "=", relation.trip_day_id).forUpdate().executeTakeFirstOrThrow();
      const places = await this.readList(transaction, userId, tripId);
      const current = places.find((place) => place.id === relation.replacement_trip_place_id);
      const original = places.find((place) => place.id === relation.original_trip_place_id);
      if (relation.status !== "active" || !current || current.assignedDayId !== relation.trip_day_id
        || current.scheduled || !original || original.assignedDayId !== null || original.scheduled) {
        throw new AppError("conflict", "This replacement can no longer be undone", 409, undefined, day.version, relation.trip_day_id);
      }
      for (const id of [current.id, original.id].sort()) await this.lockTripPlace(transaction, tripId, id);
      const updatedAt = this.now();
      const position = await this.replacementSlot(transaction, tripId, relation.trip_day_id, current, places);
      await this.swapStopAssignment(transaction, userId, tripId, relation.trip_day_id, current.id, original.id, position, updatedAt);
      await transaction.updateTable("trip_stop_replacements").set({ status: "undone", updated_at: updatedAt })
        .where("id", "=", replacementId).execute();
      await recordEvent(transaction, {
        tripId, actorId: userId, eventType: "trip_place.stop_replacement_undone", targetType: "trip_place",
        targetId: original.id, relatedTargetIds: [relation.trip_day_id, current.id], summary: "Restored the original planned stop",
      });
      await remember(transaction, userId, operation, key, { type: TRIP_PLACES_READBACK });
      return this.readList(transaction, userId, tripId);
    });
  }

  private async replacementSlot(
    transaction: Transaction<AlongTheWayDatabase>, tripId: string, dayId: string,
    stop: TripPlaceDto, places: TripPlaceDto[],
  ) {
    if (stop.dayPosition !== null) return stop.dayPosition;
    // readList is newest-first; stable sorting matches the visible day's null-position order.
    const ordered = places.filter((place) => place.assignedDayId === dayId && !place.scheduled)
      .sort((left, right) => (left.dayPosition ?? Infinity) - (right.dayPosition ?? Infinity));
    for (const [position, place] of ordered.entries()) {
      await transaction.updateTable("trip_place_day_assignments").set({ day_position: position })
        .where("trip_id", "=", tripId).where("trip_place_id", "=", place.id).execute();
    }
    return ordered.findIndex((place) => place.id === stop.id);
  }

  private async swapStopAssignment(
    transaction: Transaction<AlongTheWayDatabase>, userId: string, tripId: string, dayId: string,
    outgoingId: string, incomingId: string, position: number, updatedAt: Date,
  ) {
    await this.writeDayAssignment(transaction, userId, tripId, outgoingId, null, updatedAt);
    await transaction.updateTable("trip_places").set({ selected_for_itinerary: false, unplaced_from_date: null })
      .where("trip_id", "=", tripId).where("id", "=", outgoingId).execute();
    await this.writeDayAssignment(transaction, userId, tripId, incomingId, dayId, updatedAt);
    await transaction.updateTable("trip_place_day_assignments").set({ day_position: position })
      .where("trip_id", "=", tripId).where("trip_place_id", "=", incomingId).execute();
  }

  async resolveUrl(
    userId: string,
    tripId: string,
    url: string,
  ): Promise<ProviderCandidatesResponse> {
    await this.requireMember(this.database, userId, tripId);
    const options = await this.googleRequestOptions(tripId);
    try {
      const resolution = await resolveGoogleMapsUrl(url, this.urlResolver);
      const providerPlaceId = googleMapsPlaceId(resolution.resolvedUrl);
      const searchText = googleMapsSearchText(resolution.resolvedUrl);
      const providerCandidates = providerPlaceId
        ? [await this.provider.getPlace(providerPlaceId, options)]
        : searchText
          ? await this.provider.search(searchText, { ...options, pageSize: 3 })
          : [];
      const orderedCandidates = searchText ? exactNameFirst(searchText, providerCandidates) : providerCandidates;
      if (providerPlaceId || searchText) {
        await this.clearProviderUnavailable(tripId);
      }
      return {
        candidates: await this.searchResults(userId, tripId, orderedCandidates.slice(0, 3)),
        resolvedUrl: resolution.resolvedUrl,
        attribution: this.provider.attribution,
      };
    } catch (error) {
      if (error instanceof GoogleMapsUrlError || error instanceof TypeError) {
        throw new AppError("validation_error", error.message);
      }
      if (error instanceof ProviderQuotaError) {
        throw new AppError("provider_quota", error.message, 503);
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
    const pendingKey = `${userId}:${operation}:${key}`;
    const pending = this.pendingAdds.get(pendingKey);
    if (pending) return pending;
    const execution = this.addFresh(userId, tripId, key, operation, input);
    this.pendingAdds.set(pendingKey, execution);
    try {
      return await execution;
    } finally {
      if (this.pendingAdds.get(pendingKey) === execution) this.pendingAdds.delete(pendingKey);
    }
  }

  private async addFresh(
    userId: string,
    tripId: string,
    key: string,
    operation: string,
    input: CreateTripPlaceInput,
  ) {
    let loadCandidate: (() => Promise<ProviderPlaceCandidateDto>) | null = null;
    let manual: ManualPlaceFacts | null = null;
    // A holder, not a `let`: values are assigned inside a callback, which flow analysis does not follow.
    const intake: { candidate: ProviderPlaceCandidateDto | null; photo: PreparedCommonsPhoto | null } = { candidate: null, photo: null };
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
      let providerPlaceId: string;
      try {
        providerPlaceId = requiredText(input.providerPlaceId, "providerPlaceId", 300);
      } catch (error) {
        if (error instanceof TypeError) {
          throw new AppError("validation_error", error.message);
        }
        throw error;
      }
      const options = await this.googleRequestOptions(tripId);
      loadCandidate = async () => {
        try {
          intake.candidate = await this.provider.getPlace(providerPlaceId, options);
        } catch (error) {
          if (error instanceof TypeError || error instanceof ProviderUnavailableError) throw error;
          throw new ProviderUnavailableError();
        }
        // Only a fresh Google intake reaches here; replays and manual places skip the lookup.
        // Wikimedia failures resolve to null and leave the place on the Google photo fallback.
        if (this.commonsPhotos && !(await this.hasCommonsPhoto(intake.candidate.providerPlaceId))) {
          intake.photo = await this.commonsPhotos.prepare(intake.candidate.sourceUrl, intake.candidate.providerPlaceId);
        }
        return intake.candidate;
      };
    }
    const requestedSourceUrl = optionalUrl(input.sourceUrl);
    const originalNote = optionalText(input.originalNote, "originalNote", 10_000);

    try {
      // Provider and Commons intake can take seconds; finish it before reserving a pooled
      // connection for the atomic idempotency and persistence transaction.
      const candidate = loadCandidate ? await loadCandidate() : null;
      const response = await this.persistPlace(
        userId,
        tripId,
        key,
        operation,
        input.method,
        candidate,
        manual,
        requestedSourceUrl,
        originalNote,
        true,
        // Same transaction as the place: no reader sees it before its photo exists.
        async (transaction, placeIdentityId) => {
          if (intake.photo && this.commonsPhotos) await this.commonsPhotos.store(transaction, placeIdentityId, intake.photo);
        },
      );
      if (candidate && !intake.photo && this.commonsCandidates) {
        const placeIdentityId = response.placeId;
        void this.commonsCandidates.generate(placeIdentityId).catch((error: unknown) => {
          console.error(JSON.stringify({
            event: "commons_candidate_generation_failed",
            placeIdentityId,
            errorClass: error instanceof Error ? error.constructor.name : "NonErrorThrow",
          }));
        });
      }
      return response;
    } catch (error) {
      if (input.method !== "manual" && error instanceof TypeError) {
        throw new AppError("validation_error", error.message);
      }
      if (input.method !== "manual" && error instanceof ProviderQuotaError) {
        throw new AppError("provider_quota", error.message, 503);
      }
      if (input.method !== "manual" && error instanceof ProviderUnavailableError) {
        await this.markProviderUnavailable(tripId);
        throw new AppError("provider_unavailable", error.message, 503);
      }
      throw error;
    }
  }

  private async hasCommonsPhoto(providerPlaceId: string) {
    return Boolean(await this.database.selectFrom("place_identities as identity")
      .innerJoin("commons_place_photos as photo", "photo.place_id", "identity.id")
      .select("identity.id")
      .where("identity.provider", "=", "google")
      .where("identity.provider_place_id", "=", providerPlaceId)
      .executeTakeFirst());
  }

  private async googleRequestOptions(tripId: string) {
    const rows = await this.database.selectFrom("trip_country_stops")
      .select("country_code")
      .distinct()
      .where("trip_id", "=", tripId)
      .execute();
    return {
      languageCode: "zh-TW",
      ...(rows.length === 1 ? { regionCode: rows[0]!.country_code.trim().toUpperCase() } : {}),
    };
  }

  private async searchResults(
    userId: string,
    tripId: string,
    candidates: ProviderPlaceCandidate[],
  ): Promise<ProviderPlaceSearchResultDto[]> {
    const providerPlaceIds = [...new Set(candidates.map((candidate) => candidate.providerPlaceId))];
    const existing = providerPlaceIds.length === 0
      ? []
      : await this.database.selectFrom("trip_places as tripPlace")
          .innerJoin("place_identities as identity", "identity.id", "tripPlace.place_id")
          .select("identity.provider_place_id")
          .where("tripPlace.trip_id", "=", tripId)
          .where("tripPlace.archived_at", "is", null)
          .where("identity.provider", "=", "google")
          .where("identity.provider_place_id", "in", providerPlaceIds)
          .execute();
    const alreadyInWishlist = new Set(existing.flatMap((row) =>
      row.provider_place_id === null ? [] : [row.provider_place_id]));
    return candidates.map((candidate) => {
      const { providerPhoto, ...dto } = candidate;
      if (!providerPhoto) return {
        ...dto,
        photo: null,
        alreadyInWishlist: alreadyInWishlist.has(candidate.providerPlaceId),
      };
      const index = 0;
      return {
        ...dto,
        photo: googlePlacePhotoDto(
          tripId,
          candidate.providerPlaceId,
          index,
          providerPhoto,
          (fingerprint) => this.photoCapability?.issue(
            tripId, userId, candidate.providerPlaceId, index, fingerprint, providerPhoto.name,
          ),
        ),
        alreadyInWishlist: alreadyInWishlist.has(candidate.providerPlaceId),
      };
    });
  }

  /** Caller owns the transaction, trip content lock, reconciliation and command replay. */
  async addObservedCandidateInTransaction(
    transaction: Transaction<AlongTheWayDatabase>,
    userId: string,
    tripId: string,
    candidate: ProviderPlaceCandidateDto,
  ) {
    return this.persistPlaceInTransaction(
      transaction, userId, tripId, "search", candidate, null,
      optionalUrl(candidate.sourceUrl), null, false,
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
    requestedSourceUrl: string | null,
    originalNote: string | null,
    refuseActiveProviderDuplicate: boolean,
    beforeCommit?: (transaction: Transaction<AlongTheWayDatabase>, placeIdentityId: string) => Promise<void>,
  ) {
    return this.database.transaction().execute(async (transaction) => {
      await this.requireMember(transaction, userId, tripId);
      await lockMutation(transaction, userId, operation, key);
      const replay = await replayed(transaction, userId, operation, key);
      if (replay) return replayedTripPlace(replay);
      const sourceUrl = requestedSourceUrl ?? candidate?.sourceUrl ?? manual?.sourceUrl ?? null;
      await this.reconcileLegacyPlaces(transaction, tripId);

      const tripPlaceId = await this.persistPlaceInTransaction(
        transaction, userId, tripId, intakeMethod, candidate, manual,
        sourceUrl, originalNote, refuseActiveProviderDuplicate,
      );
      const response = await this.readOne(transaction, userId, tripId, tripPlaceId);
      await beforeCommit?.(transaction, response.placeId);
      await remember(transaction, userId, operation, key, response);
      return response;
    });
  }

  private async persistPlaceInTransaction(
    transaction: Transaction<AlongTheWayDatabase>,
    userId: string,
    tripId: string,
    intakeMethod: CreateTripPlaceInput["method"],
    candidate: ProviderPlaceCandidateDto | null,
    manual: ManualPlaceFacts | null,
    sourceUrl: string | null,
    originalNote: string | null,
    refuseActiveProviderDuplicate: boolean,
  ) {
    const identity = candidate
      ? await upsertGooglePlaceIdentity(transaction, candidate, this.now())
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
          selected_for_itinerary: false,
          unplaced_from_date: null,
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
          selected_for_itinerary: false,
          unplaced_from_date: null,
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
    return tripPlace.id;
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
    const operation = `tpp:${tripId.toLowerCase()}:${tripPlaceId.toLowerCase()}`;
    const durationMinutes = input.durationMinutes ?? null;
    if (
      durationMinutes !== null &&
      (!Number.isSafeInteger(durationMinutes) || durationMinutes <= 0 || durationMinutes > 10_080)
    ) {
      throw new AppError("validation_error", "durationMinutes must be a positive integer");
    }
    const effortLevel = input.effortLevel;
    if (effortLevel !== undefined && effortLevel !== null
      && (!Number.isSafeInteger(effortLevel) || effortLevel < 1 || effortLevel > 5)) {
      throw new AppError("validation_error", "effortLevel must be an integer from 1 to 5 or null");
    }
    const mealRole = input.mealRole;
    if (mealRole !== undefined && mealRole !== null && !isTripPlaceMealRole(mealRole)) {
      throw new AppError("validation_error", "mealRole must be breakfast, lunch, dinner, none or null");
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
        ...(effortLevel === undefined ? {} : { effort_level: effortLevel }),
        ...(mealRole === undefined ? {} : { meal_role: mealRole }),
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
      await requireScheduler(transaction, userId, tripId);
      await lockMutation(transaction, userId, operation, key);
      const replay = await replayed(transaction, userId, operation, key);
      if (replay) {
        return isTripPlacesReadback(replay)
          ? this.readList(transaction, userId, tripId)
          : replayedTripPlaces(replay);
      }
      await this.lockTripContent(transaction, tripId);
      await this.reconcileLegacyPlaces(transaction, tripId);
      await this.writeDayAssignmentsInTransaction(transaction, userId, tripId, assignments);
      const response = await this.readList(transaction, userId, tripId);
      await remember(transaction, userId, operation, key, { type: TRIP_PLACES_READBACK });
      return response;
    });
  }

  /** Caller holds the trip content lock and has reconciled places; never opens a transaction. */
  async writeDayAssignmentsInTransaction(
    transaction: Transaction<AlongTheWayDatabase>,
    userId: string,
    tripId: string,
    assignments: UpdateTripPlaceDayAssignmentsInput["assignments"],
  ) {
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
  }


  /**
   * Saves one day's complete candidate list in one transaction: omitted places move to 待安排,
   * listed unassigned places join the day, and the listed order becomes the day's order.
   */
  async arrangeDay(
    userId: string,
    tripId: string,
    rawDayId: string,
    rawKey: string,
    input: { expectedVersion: number; orderedTripPlaceIds: string[] },
  ) {
    const dayId = uuid(rawDayId, "dayId").toLowerCase();
    const ids = Array.isArray(input.orderedTripPlaceIds) ? input.orderedTripPlaceIds : null;
    if (!ids || ids.length > 100) throw new AppError("validation_error", "orderedTripPlaceIds must contain at most 100 places");
    const ordered = ids.map((id) => uuid(id, "orderedTripPlaceIds").toLowerCase());
    if (new Set(ordered).size !== ordered.length) throw new AppError("validation_error", "A place can appear only once");
    const key = requireIdempotencyKey(rawKey);
    const operation = `tpa:${tripId.toLowerCase()}:${dayId.toLowerCase()}`;
    return this.database.transaction().execute(async (transaction) => {
      await requireScheduler(transaction, userId, tripId);
      await lockMutation(transaction, userId, operation, key);
      const replay = await replayed(transaction, userId, operation, key);
      if (replay) {
        return isTripPlacesReadback(replay)
          ? this.readList(transaction, userId, tripId)
          : replayedTripPlaces(replay);
      }
      await this.lockTripContent(transaction, tripId);
      await this.reconcileLegacyPlaces(transaction, tripId);
      const validDay = await transaction.selectFrom("trip_days").select("id")
        .where("trip_id", "=", tripId).where("id", "=", dayId).forUpdate().executeTakeFirst();
      if (!validDay) throw new AppError("trip_day_not_found", "Trip day not found", 404);
      await requireDayVersion(transaction, tripId, dayId, input.expectedVersion);
      const onDay = await transaction.selectFrom("trip_place_day_assignments")
        .select("trip_place_id")
        .where("trip_id", "=", tripId).where("trip_day_id", "=", dayId)
        .orderBy("trip_place_id").forUpdate().execute();
      const listed = new Set(ordered);
      const onDayIds = new Set(onDay.map((row) => row.trip_place_id));
      const removed = onDay.filter((row) => !listed.has(row.trip_place_id)).map((row) => row.trip_place_id);
      const addedIds = ordered.filter((id) => !onDayIds.has(id));
      if (addedIds.length > 0) {
        const places = await transaction.selectFrom("trip_places").select(["id", "legacy_place_id"])
          .where("trip_id", "=", tripId).where("id", "in", addedIds).where("archived_at", "is", null)
          .orderBy("id").forUpdate().execute();
        if (places.length !== addedIds.length) throw new AppError("trip_place_not_found", "Trip place not found", 404);
        const elsewhere = await transaction.selectFrom("trip_place_day_assignments").select("trip_place_id")
          .where("trip_place_id", "in", addedIds).executeTakeFirst();
        const scheduled = await transaction.selectFrom("itinerary_endpoints").select("place_id")
          .where("trip_id", "=", tripId).where("place_id", "in", places.map((place) => place.legacy_place_id))
          .executeTakeFirst();
        if (elsewhere || scheduled) throw new AppError("conflict", "A place was arranged elsewhere meanwhile; plan the day again", 409);
      }
      const updatedAt = this.now();
      for (const id of removed) await this.writeDayAssignment(transaction, userId, tripId, id, null, updatedAt);
      for (const id of addedIds) await this.writeDayAssignment(transaction, userId, tripId, id, dayId, updatedAt);
      await transaction.updateTable("trip_place_day_assignments").set({ day_position: null })
        .where("trip_id", "=", tripId).where("trip_day_id", "=", dayId).execute();
      for (const [position, id] of ordered.entries()) {
        await transaction.updateTable("trip_place_day_assignments").set({ day_position: position })
          .where("trip_place_id", "=", id).execute();
      }
      // Order can change with no place added or removed; members still need to hear about it,
      // and history needs to show it.
      await recordEvent(transaction, {
        tripId,
        actorId: userId,
        eventType: "trip_day.places_ordered",
        targetType: "trip_day",
        targetId: dayId,
        summary: `Arranged ${ordered.length} planned places for a day`,
      });
      const response = await this.readList(transaction, userId, tripId);
      await remember(transaction, userId, operation, key, { type: TRIP_PLACES_READBACK });
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
    // 007 deletes the assignment as soon as its desired-day source is deleted.
    const previousAssignment = tripDayId === null
      ? await transaction.selectFrom("trip_place_day_assignments as assignment")
        .innerJoin("trip_days as day", "day.id", "assignment.trip_day_id")
        .innerJoin("trip_places as place", "place.id", "assignment.trip_place_id")
        .select(["day.date", sql<boolean>`exists (
          select 1 from itinerary_endpoints as endpoint
          where endpoint.trip_id = place.trip_id and endpoint.place_id = place.legacy_place_id
        )`.as("scheduled")])
        .where("assignment.trip_id", "=", tripId)
        .where("assignment.trip_place_id", "=", tripPlaceId)
        .executeTakeFirst()
      : undefined;
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
      ...(tripDayId !== null
        ? { selected_for_itinerary: true, unplaced_from_date: null }
        : previousAssignment
          ? {
              selected_for_itinerary: true,
              unplaced_from_date: previousAssignment.scheduled ? null : dateOnly(previousAssignment.date),
            }
          : {}),
      version: sql`version + 1`,
      updated_at: updatedAt,
    }).where("id", "=", tripPlaceId).execute();
    await PostgresTripPlaceModule.supersedeInvalidStopReplacements(
      transaction, tripId, [tripPlaceId], updatedAt,
    );
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
    const operation = `tpv:${tripId.toLowerCase()}:${tripPlaceId.toLowerCase()}`;
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
      // Owner decision (2026-10-14): a solo traveller can mark places too; any active member may vote.
      if (Number(members.count) < 1) {
        throw new AppError("voting_unavailable", "Voting needs an active trip member", 409);
      }
      // Retained writers can place a row without synchronizing selection/history.
      await this.reconcileLegacyPlaces(transaction, tripId);
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
    sourceTripPlaceId = uuid(sourceTripPlaceId, "sourceTripPlaceId").toLowerCase();
    const targetTripPlaceId = uuid(input.targetTripPlaceId, "targetTripPlaceId").toLowerCase();
    if (sourceTripPlaceId === targetTripPlaceId) {
      throw new AppError("validation_error", "A place cannot be merged into itself");
    }
    const key = requireIdempotencyKey(rawKey);
    const operation = `tpm:${tripId.toLowerCase()}:${sourceTripPlaceId}`;
    return this.database.transaction().execute(async (transaction) => {
      await this.requireMember(transaction, userId, tripId);
      await this.lockTripContent(transaction, tripId);
      const authorization = await transaction.selectFrom("trip_places as trip_place")
        .select([
          "trip_place.id",
          "trip_place.legacy_place_id",
          "trip_place.selected_for_itinerary",
        ])
        .where("trip_place.trip_id", "=", tripId)
        .where("trip_place.id", "in", [sourceTripPlaceId, targetTripPlaceId])
        .where("trip_place.archived_at", "is", null)
        .execute();
      const authorizationIds = authorization.map((place) => place.id);
      const authorizationLegacyIds = authorization.map((place) => place.legacy_place_id);
      const [hasDayAssignment, hasTimedEndpoint] = await Promise.all([
        authorizationIds.length === 0
          ? undefined
          : transaction.selectFrom("trip_place_day_assignments")
            .select("trip_place_id")
            .where("trip_id", "=", tripId)
            .where("trip_place_id", "in", authorizationIds)
            .executeTakeFirst(),
        authorizationLegacyIds.length === 0
          ? undefined
          : transaction.selectFrom("itinerary_endpoints")
            .select("place_id")
            .where("trip_id", "=", tripId)
            .where("place_id", "in", authorizationLegacyIds)
            .executeTakeFirst(),
      ]);
      if (
        authorization.some((place) => place.selected_for_itinerary)
        || hasDayAssignment !== undefined
        || hasTimedEndpoint !== undefined
      ) {
        await requireScheduler(transaction, userId, tripId);
      }
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
      const sourcePriorDate = source.unplaced_from_date === null ? null : dateOnly(source.unplaced_from_date);
      const targetPriorDate = target.unplaced_from_date === null ? null : dateOnly(target.unplaced_from_date);
      // A candidate contributes no placement history. Two selected histories must
      // agree, including unknown dates; choosing either differing date would invent history.
      const unplacedFromDate = scheduled || desiredDayIds.size === 1
        ? null
        : source.selected_for_itinerary && target.selected_for_itinerary
          ? sourcePriorDate === targetPriorDate ? sourcePriorDate : null
          : source.selected_for_itinerary ? sourcePriorDate : targetPriorDate;

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
        .set({
          accepted_trip_place_id: target.id,
          version: sql`version + 1`,
          updated_at: this.now(),
        })
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
        selected_for_itinerary: source.selected_for_itinerary || target.selected_for_itinerary
          || scheduled !== undefined || sourceAssignment !== undefined || targetAssignment !== undefined,
        unplaced_from_date: unplacedFromDate,
        duration_minutes: target.duration_minutes ?? source.duration_minutes,
        effort_level: target.effort_level ?? source.effort_level,
        meal_role: target.meal_role ?? source.meal_role,
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
      await PostgresTripPlaceModule.supersedeInvalidStopReplacements(
        transaction, tripId, [target.id], updatedAt,
      );
      await sql`
        delete from trip_place_must_items as source_item
        where source_item.trip_place_id = ${source.id}
          and exists (
            select 1
            from trip_place_must_items as target_item
            where target_item.trip_place_id = ${target.id}
              and target_item.kind = source_item.kind
              and target_item.normalized_label = source_item.normalized_label
          )
      `.execute(transaction);
      await transaction.updateTable("trip_place_must_items")
        .set({ trip_place_id: target.id })
        .where("trip_place_id", "=", source.id)
        .execute();
      if (source.place_id === target.place_id) {
        await transaction.updateTable("feedback")
          .set({ trip_place_id: target.id })
          .where("trip_place_id", "=", source.id)
          .execute();
      }
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
    const operation = `tps:${tripId.toLowerCase()}:${suggestionId.toLowerCase()}`;
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

  /** 下次還要來 visible from this trip: the viewer's own and their current fellow travellers'. */
  async listKeeps(userId: string, tripId: string) {
    await this.requireMember(this.database, userId, tripId);
    return readPlaceKeeps(this.database, userId, tripId);
  }

  /** Marks (or re-notes) this trip place's canonical place as the user's 下次還要來. */
  async keep(
    userId: string,
    tripId: string,
    rawTripPlaceId: string,
    rawKey: string,
    input: KeepTripPlaceInput,
  ) {
    const tripPlaceId = uuid(rawTripPlaceId, "tripPlaceId").toLowerCase();
    const note = placeKeepNote(input.note);
    const key = requireIdempotencyKey(rawKey);
    // 76 characters; mutation_requests.operation is varchar(80).
    const operation = `pk:${tripId.toLowerCase()}:${tripPlaceId}`;
    return this.database.transaction().execute(async (transaction) => {
      await this.requireMember(transaction, userId, tripId);
      await lockMutation(transaction, userId, operation, key);
      const replay = await replayed(transaction, userId, operation, key);
      if (replay) return parsePlaceKeepResponse({ keep: replay }).keep;
      const tripPlace = await transaction.selectFrom("trip_places").select("place_id")
        .where("trip_id", "=", tripId).where("id", "=", tripPlaceId).executeTakeFirst();
      if (!tripPlace) throw new AppError("trip_place_not_found", "Trip place not found", 404);
      const now = this.now();
      const kept = await transaction.insertInto("place_keeps").values({
        user_id: userId,
        place_identity_id: tripPlace.place_id,
        from_trip_id: tripId,
        note,
        created_at: now,
        updated_at: now,
      }).onConflict((conflict) => conflict.columns(["user_id", "place_identity_id"]).doUpdateSet({
        note,
        updated_at: now,
        // The first trip it was kept from stays the source; a re-note from another trip does not move it.
        from_trip_id: sql<string | null>`coalesce(place_keeps.from_trip_id, excluded.from_trip_id)`,
      })).returning("id").executeTakeFirstOrThrow();
      const [response] = await readPlaceKeeps(transaction, userId, tripId, kept.id);
      if (!response) throw new Error("A just-written place keep must be visible to its keeper");
      await remember(transaction, userId, operation, key, response);
      return response;
    });
  }

  /** Removes the user's 下次還要來 for this trip place's canonical place; absent is already done. */
  async unkeep(userId: string, tripId: string, rawTripPlaceId: string, rawKey: string) {
    const tripPlaceId = uuid(rawTripPlaceId, "tripPlaceId").toLowerCase();
    const key = requireIdempotencyKey(rawKey);
    // 77 characters; mutation_requests.operation is varchar(80).
    const operation = `pku:${tripId.toLowerCase()}:${tripPlaceId}`;
    await this.database.transaction().execute(async (transaction) => {
      await this.requireMember(transaction, userId, tripId);
      await lockMutation(transaction, userId, operation, key);
      if (await replayed(transaction, userId, operation, key)) return;
      const tripPlace = await transaction.selectFrom("trip_places").select("place_id")
        .where("trip_id", "=", tripId).where("id", "=", tripPlaceId).executeTakeFirst();
      if (!tripPlace) throw new AppError("trip_place_not_found", "Trip place not found", 404);
      await transaction.deleteFrom("place_keeps")
        .where("user_id", "=", userId).where("place_identity_id", "=", tripPlace.place_id).execute();
      await remember(transaction, userId, operation, key, { unkept: true });
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
    const operation = `tpr:${tripId.toLowerCase()}:${tripPlaceId.toLowerCase()}`;
    await this.database.transaction().execute(async (transaction) => {
      await this.requireMember(transaction, userId, tripId);
      await this.lockTripContent(transaction, tripId);
      const authorization = await transaction.selectFrom("trip_places as trip_place")
        .select([
          "trip_place.selected_for_itinerary",
          sql<boolean>`exists (
            select 1 from trip_place_day_assignments as assignment
            where assignment.trip_id = ${tripId}
              and assignment.trip_place_id = ${tripPlaceId}
          )`.as("has_day_assignment"),
          sql<boolean>`exists (
            select 1 from itinerary_endpoints as endpoint
            where endpoint.trip_id = ${tripId}
              and endpoint.place_id = trip_place.legacy_place_id
          )`.as("has_timed_endpoint"),
        ])
        .where("trip_place.id", "=", tripPlaceId)
        .where("trip_place.trip_id", "=", tripId)
        .executeTakeFirst();
      if (!authorization) throw new AppError("trip_place_not_found", "Trip place not found", 404);
      if (
        authorization.selected_for_itinerary
        || authorization.has_day_assignment
        || authorization.has_timed_endpoint
      ) {
        await requireScheduler(transaction, userId, tripId);
      } else {
        // Re-check membership under the trip lock before replaying a prior success.
        await this.requireMember(transaction, userId, tripId);
      }
      await lockMutation(transaction, userId, operation, key);
      if (await replayed(transaction, userId, operation, key)) return;
      await this.reconcileLegacyPlaces(transaction, tripId);
      const current = await this.lockTripPlace(transaction, tripId, tripPlaceId);
      this.expectedVersion(current.version, input.expectedVersion);
      const previousAssignment = await transaction.selectFrom("trip_place_day_assignments as assignment")
        .innerJoin("trip_days as day", "day.id", "assignment.trip_day_id")
        .select(["day.date", sql<boolean>`exists (
          select 1 from itinerary_endpoints as endpoint
          where endpoint.trip_id = ${tripId} and endpoint.place_id = ${current.legacy_place_id}
        )`.as("scheduled")])
        .where("assignment.trip_id", "=", tripId)
        .where("assignment.trip_place_id", "=", tripPlaceId)
        .executeTakeFirst();
      // Migration 007 derives assignments from legacy day rows: delete sources first.
      for (const table of ["trip_place_desired_days", "trip_place_excluded_days", "trip_place_day_assignments", "trip_place_votes"] as const) {
        await transaction.deleteFrom(table).where("trip_place_id", "=", tripPlaceId).execute();
      }
      await transaction.deleteFrom("trip_place_must_items")
        .where("trip_place_id", "=", tripPlaceId)
        .execute();
      const removedAt = this.now();
      await transaction.updateTable("trip_places").set({
        ...(previousAssignment ? {
          selected_for_itinerary: true,
          unplaced_from_date: previousAssignment.scheduled ? null : dateOnly(previousAssignment.date),
        } : {}),
        archived_at: removedAt,
        version: sql`version + 1`,
        updated_at: removedAt,
      }).where("id", "=", tripPlaceId).execute();
      await PostgresTripPlaceModule.supersedeInvalidStopReplacements(
        transaction, tripId, [tripPlaceId], removedAt,
      );
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

  private async reconcileLegacyPlaces(
    transaction: Transaction<AlongTheWayDatabase>,
    tripId: string,
  ) {
    await this.lockTripContent(transaction, tripId);
    await PostgresTripPlaceModule.reconcileLegacyPlacesInTransaction(transaction, tripId, this.now);
  }

  /** Run after placement writes in the caller's transaction; an ended relation never revives. */
  static async supersedeInvalidStopReplacements(
    transaction: Transaction<AlongTheWayDatabase>,
    tripId: string,
    tripPlaceIds: string[],
    updatedAt: Date,
  ) {
    if (tripPlaceIds.length === 0) return;
    await transaction.updateTable("trip_stop_replacements as replacement")
      .set({ status: "superseded", updated_at: updatedAt })
      .where("replacement.trip_id", "=", tripId)
      .where("replacement.replacement_trip_place_id", "in", tripPlaceIds)
      .where("replacement.status", "=", "active")
      .where(sql<boolean>`not exists (
        select 1 from trip_place_day_assignments as assignment
        join trip_places as place on place.trip_id = assignment.trip_id and place.id = assignment.trip_place_id
        where assignment.trip_id = replacement.trip_id
          and assignment.trip_place_id = replacement.replacement_trip_place_id
          and assignment.trip_day_id = replacement.trip_day_id
          and place.archived_at is null
          and not exists (
            select 1 from itinerary_endpoints as endpoint
            where endpoint.trip_id = place.trip_id and endpoint.place_id = place.legacy_place_id
          )
      )`).execute();
  }

  /** Caller holds the trip content lock; timed writers need the same canonical identity before removal. */
  static async reconcileLegacyPlacesInTransaction(
    transaction: Transaction<AlongTheWayDatabase>,
    tripId: string,
    now: () => Date,
  ) {
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
      const archivedAt = now();
      await transaction.updateTable("trip_places").set({
        archived_at: archivedAt, version: sql`version + 1`, updated_at: archivedAt,
      }).where("trip_id", "=", tripId).where("id", "in", ids).execute();
      await PostgresTripPlaceModule.supersedeInvalidStopReplacements(transaction, tripId, ids, archivedAt);
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
      .select((builder) => builder.exists(
        builder.selectFrom("itinerary_endpoints as endpoint")
          .select("endpoint.place_id")
          .whereRef("endpoint.trip_id", "=", "legacy.trip_id")
          .whereRef("endpoint.place_id", "=", "legacy.id"),
      ).as("scheduled"))
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
        selected_for_itinerary: Boolean(legacy.scheduled),
        unplaced_from_date: null,
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
    // Reconcile only observable current placements from retained writers, not lost history.
    await sql`
      update trip_places as place
      set selected_for_itinerary = true, unplaced_from_date = null,
        version = place.version + 1, updated_at = ${now()}
      where place.trip_id = ${tripId}
        and (not place.selected_for_itinerary or place.unplaced_from_date is not null)
        and (
          exists (
            select 1 from trip_place_day_assignments as assignment
            where assignment.trip_id = place.trip_id and assignment.trip_place_id = place.id
          ) or exists (
            select 1 from itinerary_endpoints as endpoint
            where endpoint.trip_id = place.trip_id and endpoint.place_id = place.legacy_place_id
          )
        )
    `.execute(transaction);
    await reopenRemovedProposals(transaction, tripId, now());
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
        "tripPlace.effort_level",
        "tripPlace.meal_role",
        "tripPlace.selected_for_itinerary",
        "tripPlace.unplaced_from_date",
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
      // Newest first; votes are shown but never reorder the list (owner decision 2026-10-19).
      .orderBy("tripPlace.created_at", "desc").orderBy("tripPlace.id", "desc").execute();
    if (placeRows.length === 0) return [];
    const ids = placeRows.map((row) => row.id);
    const legacyPlaceIds = placeRows.map((row) => row.legacy_place_id);
    const [contributions, members, voteRows, assignmentRows, duplicateRows, scheduledRows, aiProposalRows, replacementRows] = await Promise.all([
      executor.selectFrom("trip_place_contributions")
        .distinctOn("trip_place_id")
        .select(["trip_place_id", "source_url"])
        .where("trip_place_id", "in", ids)
        .orderBy("trip_place_id").orderBy("created_at").orderBy("id").execute(),
      executor.selectFrom("trip_members").innerJoin("users", "users.id", "trip_members.user_id")
        .select(["trip_members.user_id", "trip_members.role", "trip_members.joined_at", "users.email", "users.display_name"])
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
      executor.selectFrom("trip_stop_replacements as replacement")
        .innerJoin("trip_place_day_assignments as assignment", (join) => join
          .onRef("assignment.trip_id", "=", "replacement.trip_id")
          .onRef("assignment.trip_place_id", "=", "replacement.replacement_trip_place_id")
          .onRef("assignment.trip_day_id", "=", "replacement.trip_day_id"))
        .innerJoin("trip_places as original", "original.id", "replacement.original_trip_place_id")
        .innerJoin("place_identities as identity", "identity.id", "original.place_id")
        .select(["replacement.id", "replacement.replacement_trip_place_id", "replacement.original_trip_place_id",
          "original.name", "original.facts_source", "identity.canonical_name"])
        .where("replacement.trip_id", "=", tripId).where("replacement.status", "=", "active").execute(),
    ]);
    const scheduled = new Set(scheduledRows.map((row) => row.place_id));
    const aiProposalByTripPlaceId = new Map(
      aiProposalRows.flatMap((proposal) => proposal.accepted_trip_place_id
        ? [[proposal.accepted_trip_place_id, proposal.id] as const]
        : []),
    );
    const replacementByPlaceId = new Map(replacementRows.map((row) => [row.replacement_trip_place_id, {
      replacementId: row.id,
      originalTripPlaceId: row.original_trip_place_id,
      originalName: row.facts_source === "provider" ? row.canonical_name : row.name,
    }]));
    const votesByKey = new Set(voteRows.map((row) => `${row.trip_place_id}:${row.member_user_id}`));
    const assignmentByPlaceId = new Map(
      assignmentRows.map((assignment) => [assignment.trip_place_id, assignment]),
    );
    const originalSources = new Map(contributions.map((entry) => [entry.trip_place_id, entry.source_url]));
    const requesterIsOwner = members.some((member) => member.user_id === userId && member.role === "owner");
    const places = placeRows.map((row): TripPlaceDto => {
      const voters = members.filter((member) => votesByKey.has(`${row.id}:${member.user_id}`)).map((member) => ({
        memberUserId: member.user_id,
        memberEmail: requesterIsOwner || member.user_id === userId ? member.email : null,
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
        legacyPlaceId: row.legacy_place_id,
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
        selectedForItinerary: row.selected_for_itinerary,
        unplacedFromDate: row.unplaced_from_date === null ? null : dateOnly(row.unplaced_from_date),
        durationMinutes: row.duration_minutes,
        effortLevel: row.effort_level,
        mealRole: row.meal_role,
        assignedDayId: assignmentByPlaceId.get(row.id)?.trip_day_id ?? null,
        dayPosition: assignmentByPlaceId.get(row.id)?.day_position ?? null,
        replacedStop: isScheduled ? null : replacementByPlaceId.get(row.id) ?? null,
        budgetAmountMinor: row.budget_amount_minor === null ? null : Number(row.budget_amount_minor),
        budgetCurrency: row.budget_currency,
        notes: row.notes,
        sourceUrl: originalSources.get(row.id) ?? row.source_url,
        voters,
        voteCount: voters.length,
        ownVote: voters.some((member) => member.memberUserId === userId),
        votingAvailable: members.length >= 1,
        duplicateSuggestions: suggestions,
        version: row.version,
      };
    });
    return places;
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

  private expectedVersion(current: number, expected: number, conflictTargetId?: string) {
    if (!Number.isSafeInteger(expected) || expected !== current) {
      throw new AppError(
        "conflict",
        `Version conflict; current version is ${current}`,
        409,
        undefined,
        current,
        conflictTargetId,
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
