import type {
  CommonsCandidateDecisionInput,
  CommonsCandidateDecisionResponse,
  CommonsCandidateDto,
  CommonsCandidateInstanceOfDto,
  CommonsCandidateNameDto,
  CommonsPhotoReportResponse,
  PlacePhotoDto,
} from "@along-the-way/contracts/place-details";
import { parseCuratedPhoto, type CuratedPhotoInput } from "@along-the-way/contracts/place-details";
import type { PlaceType } from "@along-the-way/contracts/trip-skeleton";
import { sql, type Kysely, type Transaction } from "kysely";

import type { AlongTheWayDatabase } from "../database/database";
import { AppError } from "../private-trips/private-trip-module";
import type { CommonsCandidatePhotoSource, PreparedCommonsPhoto } from "./commons-place-photos";

const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const WIKIDATA_QUERY = "https://query.wikidata.org/sparql";
const LANGUAGES = ["ja", "zh", "zh-hant", "zh-tw", "en"] as const;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AUTO_PLACE_TYPES: Partial<Record<PlaceType, true>> = { worship: true, nature: true, museum: true };
const NAME_VARIANTS: Record<string, string> = {
  "禅": "禪", "観": "觀", "国": "國", "宝": "寶", "温": "溫", "庵": "菴",
  "駅": "站", "臺": "台", "の": "", "之": "",
};
const TYPE_IDS: Partial<Record<PlaceType, Readonly<Record<string, true>>>> = {
  worship: { Q16970: true, Q34627: true, Q32815: true, Q44539: true, Q5393308: true, Q845945: true, Q44613: true },
  museum: { Q33506: true, Q207694: true, Q16735822: true },
  nature: { Q22698: true, Q4421: true, Q23397: true, Q1107656: true, Q570116: true, Q1136435: true },
  station: { Q55488: true, Q783794: true },
  airport: { Q1248784: true },
};
const TYPE_WORDS: Partial<Record<PlaceType, readonly string[]>> = {
  worship: ["temple", "shrine", "church", "monastery", "cathedral", "mosque", "synagogue", "sanctuary", "寺", "神社", "神宮", "教會", "教会", "修道院", "廟"],
  museum: ["museum", "gallery", "博物館", "美術館"],
  nature: ["park", "garden", "lake", "mountain", "waterfall", "forest", "beach", "coast", "景勝", "公園", "庭園", "湖", "山", "瀑布", "森林", "海岸"],
  station: ["railway station", "train station", "metro station", "駅", "車站"],
  airport: ["airport", "機場", "空港"],
  cafe: ["cafe", "café", "coffeehouse", "咖啡"],
  restaurant: ["restaurant", "餐廳", "料理店"],
  lodging: ["hotel", "hostel", "ryokan", "旅館", "飯店"],
  shopping: ["shop", "store", "market", "shopping mall", "商店", "市場", "購物"],
  activity: ["theatre", "theater", "amusement", "attraction", "sports venue", "劇場", "遊樂", "體育"],
};

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type DatabaseExecutor = Kysely<AlongTheWayDatabase> | Transaction<AlongTheWayDatabase>;

export type CommonsCandidateGenerationOutcome =
  | "generated"
  | "auto_applied"
  | "refreshed"
  | "has_photo"
  | "already_generated"
  | "no_candidates";

export interface CommonsCandidateGenerationResult {
  outcome: CommonsCandidateGenerationOutcome;
  stored: number;
}

export interface CommonsCandidateGenerator {
  generate(placeIdentityId: string): Promise<CommonsCandidateGenerationResult>;
}

export interface CommonsCandidateModule extends CommonsCandidateGenerator {
  refresh(placeIdentityId: string): Promise<CommonsCandidateGenerationResult>;
  list(userId: string, tripId: string): Promise<CommonsCandidateDto[]>;
  decide(
    userId: string,
    tripId: string,
    candidateId: string,
    decision: CommonsCandidateDecisionInput["decision"],
  ): Promise<CommonsCandidateDecisionResponse>;
  report(userId: string, tripId: string, tripPlaceId: string): Promise<CommonsPhotoReportResponse>;
  getAsset(userId: string, tripId: string, candidateId: string, filename: string): Promise<{
    bytes: Uint8Array<ArrayBuffer>;
    mediaType: "image/jpeg" | "image/png" | "image/webp";
  }>;
}

interface SearchRank {
  score: number;
  geoDistanceKm: number | null;
}

interface CandidateFacts {
  wikidataId: string;
  label: string;
  names: CommonsCandidateNameDto[];
  instanceOf: CommonsCandidateInstanceOfDto[];
  description: string | null;
  distanceMeters: number | null;
  score: number;
  hasP18: boolean;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function wikidataId(value: unknown): string | null {
  return typeof value === "string" && /^Q[1-9][0-9]*$/.test(value) ? value : null;
}

function normalizedName(value: string) {
  const folded = value.normalize("NFKC").toLocaleLowerCase("und").replace(/[^\p{L}\p{N}]+/gu, "");
  return Array.from(folded, (character) => NAME_VARIANTS[character] ?? character).join("");
}

function comparableName(value: string, placeType: PlaceType) {
  const normalized = normalizedName(value);
  return placeType === "station" ? normalized.replace(/(?:station|車站|站)$/u, "") : normalized;
}

export function namesExactlyEqual(
  placeName: string,
  placeType: PlaceType,
  candidateNames: readonly CommonsCandidateNameDto[],
) {
  const expected = comparableName(placeName, placeType);
  return expected.length > 0 && candidateNames.some((name) => comparableName(name.value, placeType) === expected);
}

export function namesRelated(
  placeName: string,
  placeType: PlaceType,
  candidateNames: readonly CommonsCandidateNameDto[],
) {
  const expected = comparableName(placeName, placeType);
  if (!expected) return false;
  return candidateNames.some((name) => {
    const candidate = comparableName(name.value, placeType);
    if (!candidate) return false;
    if (candidate === expected) return true;
    if (Math.min(candidate.length, expected.length) >= 3
      && (candidate.includes(expected) || expected.includes(candidate))) return true;
    // Latin transliterations can share most letters in a different order (Funaya Biyori vs
    // Roadside station Funaya-no-sato Ine); unordered overlap is meaningful only for Han names.
    if (!/\p{Script=Han}/u.test(expected) || !/\p{Script=Han}/u.test(candidate)) return false;
    const counts = new Map<string, number>();
    for (const character of candidate) counts.set(character, (counts.get(character) ?? 0) + 1);
    let overlap = 0;
    for (const character of expected) {
      const remaining = counts.get(character) ?? 0;
      if (remaining > 0) {
        overlap++;
        counts.set(character, remaining - 1);
      }
    }
    return overlap >= 3 && overlap / Math.min(candidate.length, expected.length) >= 0.6;
  });
}

export function typeCompatible(
  placeType: PlaceType,
  instanceOf: readonly CommonsCandidateInstanceOfDto[],
) {
  const ids = TYPE_IDS[placeType];
  if (ids && instanceOf.some((entry) => ids[entry.id])) return true;
  const words = TYPE_WORDS[placeType];
  if (!words) return false;
  return instanceOf.some((entry) => {
    const label = entry.label.normalize("NFKC").toLocaleLowerCase("und");
    return words.some((word) => label.includes(word));
  });
}

function coordinate(claims: Record<string, unknown> | null): { latitude: number; longitude: number } | null {
  const statements = claims?.P625;
  if (!Array.isArray(statements)) return null;
  for (const statement of statements) {
    const value = object(object(object(object(statement)?.mainsnak)?.datavalue)?.value);
    const latitude = value?.latitude;
    const longitude = value?.longitude;
    if (typeof latitude === "number" && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90
      && typeof longitude === "number" && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180) {
      return { latitude, longitude };
    }
  }
  return null;
}

function distanceMeters(
  first: { latitude: number; longitude: number },
  second: { latitude: number; longitude: number },
) {
  const radians = Math.PI / 180;
  const latitudeDelta = (second.latitude - first.latitude) * radians;
  const longitudeDelta = (second.longitude - first.longitude) * radians;
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(first.latitude * radians) * Math.cos(second.latitude * radians)
      * Math.sin(longitudeDelta / 2) ** 2;
  const clamped = Math.min(1, Math.max(0, a));
  return Math.round(6_371_000 * 2 * Math.atan2(Math.sqrt(clamped), Math.sqrt(1 - clamped)));
}

function localizedText(entity: Record<string, unknown>, field: "labels" | "descriptions") {
  const values = object(entity[field]);
  for (const language of LANGUAGES) {
    const value = object(values?.[language])?.value;
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function candidateNames(value: unknown): CommonsCandidateNameDto[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = object(entry);
    return typeof parsed?.lang === "string" && typeof parsed.value === "string" && parsed.value.trim()
      ? [{ lang: parsed.lang, value: parsed.value.trim() }]
      : [];
  });
}

function candidateInstanceOf(value: unknown): CommonsCandidateInstanceOfDto[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = object(entry);
    const id = wikidataId(parsed?.id);
    return id && typeof parsed?.label === "string" && parsed.label.trim()
      ? [{ id, label: parsed.label.trim() }]
      : [];
  });
}

function entityNames(entity: Record<string, unknown>): CommonsCandidateNameDto[] {
  const labels = object(entity.labels);
  const aliases = object(entity.aliases);
  const names: CommonsCandidateNameDto[] = [];
  const seen = new Set<string>();
  for (const lang of LANGUAGES) {
    const values = [
      object(labels?.[lang])?.value,
      ...(Array.isArray(aliases?.[lang]) ? aliases[lang].map((alias) => object(alias)?.value) : []),
    ];
    for (const value of values) {
      if (typeof value !== "string" || !value.trim()) continue;
      const name = value.trim();
      const key = `${lang}\0${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      names.push({ lang, value: name });
    }
  }
  return names;
}

function instanceOfIds(claims: Record<string, unknown> | null) {
  const statements = claims?.P31;
  if (!Array.isArray(statements)) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const statement of statements) {
    const id = wikidataId(object(object(object(object(statement)?.mainsnak)?.datavalue)?.value)?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function photoDto(
  tripId: string,
  candidateId: string,
  photo: CuratedPhotoInput,
): PlacePhotoDto {
  const { image, thumbnail, ...metadata } = photo;
  const prefix = `/api/trips/${tripId}/commons-candidates/${candidateId}/assets/`;
  return {
    source: "commons",
    ...metadata,
    imageUrl: `${prefix}${image.filename}`,
    thumbnailUrl: `${prefix}${thumbnail.filename}`,
    width: image.width,
    height: image.height,
  };
}

export class PostgresCommonsCandidateModule implements CommonsCandidateModule {
  private readonly database: Kysely<AlongTheWayDatabase>;
  private readonly photos: CommonsCandidatePhotoSource;
  private readonly fetch: FetchLike;
  private readonly userAgent: string;
  private readonly generateBudgetMs: number;
  private readonly now: () => Date;

  constructor(options: {
    database: Kysely<AlongTheWayDatabase>;
    photos: CommonsCandidatePhotoSource;
    userAgent: string;
    fetch?: FetchLike;
    generateBudgetMs?: number;
    now?: () => Date;
  }) {
    this.database = options.database;
    this.photos = options.photos;
    this.userAgent = options.userAgent;
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.generateBudgetMs = options.generateBudgetMs ?? 15_000;
    this.now = options.now ?? (() => new Date());
  }

  async generate(placeIdentityId: string): Promise<CommonsCandidateGenerationResult> {
    if (!UUID.test(placeIdentityId)) throw new TypeError("placeIdentityId must be a UUID");
    const signal = AbortSignal.timeout(this.generateBudgetMs);
    const place = await this.placeFacts(placeIdentityId);
    if (place.hasPhoto) return { outcome: "has_photo", stored: 0 };
    const existing = await this.database.selectFrom("commons_photo_candidates")
      .select("id").where("place_id", "=", placeIdentityId).executeTakeFirst();
    if (existing) return { outcome: "already_generated", stored: 0 };
    const facts = await this.findCandidates(place.name, place.placeType, place.coordinate, signal);
    const prepared = await this.prepareCandidates(facts, place.name, place.placeType, signal);
    signal.throwIfAborted();
    if (prepared.length === 0) return { outcome: "no_candidates", stored: 0 };
    return this.storeGenerated(placeIdentityId, place.name, place.placeType, prepared);
  }

  async refresh(placeIdentityId: string): Promise<CommonsCandidateGenerationResult> {
    if (!UUID.test(placeIdentityId)) throw new TypeError("placeIdentityId must be a UUID");
    const signal = AbortSignal.timeout(this.generateBudgetMs);
    const place = await this.placeFacts(placeIdentityId);
    const existing = await this.database.selectFrom("commons_photo_candidates")
      .select(["id", "wikidata_id", "status"])
      .where("place_id", "=", placeIdentityId)
      .orderBy("created_at")
      .orderBy("id")
      .execute();
    if (existing.length === 0) return this.generate(placeIdentityId);
    const refreshed = await this.fetchCandidateFacts(
      existing.map((candidate) => candidate.wikidata_id),
      place.coordinate,
      new Map(),
      signal,
    );
    signal.throwIfAborted();
    const factsById = new Map(refreshed.map((candidate) => [candidate.wikidataId, candidate]));
    return this.database.transaction().execute(async (transaction) => {
      await transaction.selectFrom("place_identities").select("id")
        .where("id", "=", placeIdentityId).forUpdate().executeTakeFirstOrThrow();
      const locked = await transaction.selectFrom("commons_photo_candidates")
        .select(["id", "wikidata_id", "status", "metadata"])
        .where("place_id", "=", placeIdentityId)
        .orderBy("id")
        .forUpdate()
        .execute();
      for (const candidate of locked) {
        const facts = factsById.get(candidate.wikidata_id);
        if (!facts) {
          if (candidate.status === "pending") {
            await transaction.deleteFrom("commons_photo_candidates").where("id", "=", candidate.id).execute();
          }
          continue;
        }
        await transaction.updateTable("commons_photo_candidates").set({
          label: facts.label,
          names: JSON.stringify(facts.names),
          instance_of: JSON.stringify(facts.instanceOf),
          description: facts.description,
          distance_meters: facts.distanceMeters,
        }).where("id", "=", candidate.id).execute();
        if (candidate.status === "pending"
          && !namesRelated(place.name, place.placeType, facts.names)) {
          await transaction.deleteFrom("commons_photo_candidates").where("id", "=", candidate.id).execute();
        }
      }
      const photo = await transaction.selectFrom("commons_place_photos")
        .select("place_id").where("place_id", "=", placeIdentityId).executeTakeFirst();
      if (!photo && AUTO_PLACE_TYPES[place.placeType]) {
        const pending = await transaction.selectFrom("commons_photo_candidates")
          .select(["id", "wikidata_id", "names", "instance_of", "distance_meters", "metadata"])
          .where("place_id", "=", placeIdentityId)
          .where("status", "=", "pending")
          .orderBy("id")
          .execute();
        const eligible = pending.filter((candidate) =>
          namesExactlyEqual(place.name, place.placeType, candidateNames(candidate.names))
          && typeCompatible(place.placeType, candidateInstanceOf(candidate.instance_of))
          && candidate.distance_meters !== null
          && candidate.distance_meters <= 300);
        if (eligible.length === 1) {
          const chosen = eligible[0]!;
          const stored = await this.photos.storeConfirmed(
            transaction,
            placeIdentityId,
            chosen.wikidata_id,
            parseCuratedPhoto(chosen.metadata),
          );
          if (stored) {
            const decidedAt = this.now();
            await transaction.updateTable("commons_photo_candidates").set({
              status: "confirmed", auto_applied: true, decided_by_user_id: null, decided_at: decidedAt,
            }).where("id", "=", chosen.id).execute();
            await transaction.updateTable("commons_photo_candidates").set({
              status: "rejected", auto_applied: false, decided_by_user_id: null, decided_at: decidedAt,
            }).where("place_id", "=", placeIdentityId)
              .where("id", "!=", chosen.id)
              .where("status", "=", "pending")
              .execute();
            return { outcome: "auto_applied", stored: 1 };
          }
        }
      }
      const remaining = await transaction.selectFrom("commons_photo_candidates")
        .select((builder) => builder.fn.countAll().as("count"))
        .where("place_id", "=", placeIdentityId)
        .executeTakeFirstOrThrow();
      return { outcome: "refreshed", stored: Number(remaining.count) };
    });
  }

  async list(userId: string, tripId: string): Promise<CommonsCandidateDto[]> {
    await this.requireMember(this.database, userId, tripId);
    const rows = await this.database.selectFrom("commons_photo_candidates as candidate")
      .innerJoin("trip_places as tripPlace", "tripPlace.place_id", "candidate.place_id")
      .leftJoin("commons_place_photos as photo", "photo.place_id", "candidate.place_id")
      .select([
        "candidate.id",
        "candidate.wikidata_id",
        "candidate.label",
        "candidate.names",
        "candidate.instance_of",
        "candidate.description",
        "candidate.distance_meters",
        "candidate.metadata",
        "tripPlace.id as trip_place_id",
        "tripPlace.name as place_name",
        "tripPlace.place_type",
      ])
      .where("tripPlace.trip_id", "=", tripId)
      .where("tripPlace.archived_at", "is", null)
      .where("candidate.status", "=", "pending")
      .where("photo.place_id", "is", null)
      .orderBy("tripPlace.created_at")
      .orderBy(sql`candidate.distance_meters nulls last`)
      .orderBy("candidate.created_at")
      .orderBy("candidate.id")
      .execute();
    return rows.flatMap((row) => {
      const names = candidateNames(row.names);
      if (!namesRelated(row.place_name, row.place_type, names)) return [];
      return [{
        id: row.id,
        tripPlaceId: row.trip_place_id,
        placeName: row.place_name,
        placeType: row.place_type,
        wikidataId: row.wikidata_id,
        label: row.label,
        names,
        instanceOf: candidateInstanceOf(row.instance_of),
        description: row.description,
        distanceMeters: row.distance_meters,
        photo: photoDto(tripId, row.id, parseCuratedPhoto(row.metadata)),
      }];
    });
  }

  async decide(
    userId: string,
    tripId: string,
    candidateId: string,
    decision: CommonsCandidateDecisionInput["decision"],
  ): Promise<CommonsCandidateDecisionResponse> {
    if (!UUID.test(candidateId)) throw new AppError("validation_error", "candidateId must be a UUID");
    if (decision !== "confirm" && decision !== "reject") {
      throw new AppError("validation_error", "decision must be confirm or reject");
    }
    try {
      return await this.database.transaction().execute(async (transaction) => {
        await this.requireDecisionPermission(transaction, userId, tripId);
        const located = await transaction.selectFrom("commons_photo_candidates as candidate")
          .innerJoin("trip_places as tripPlace", "tripPlace.place_id", "candidate.place_id")
          .select("candidate.place_id")
          .where("candidate.id", "=", candidateId)
          .where("tripPlace.trip_id", "=", tripId)
          .where("tripPlace.archived_at", "is", null)
          .executeTakeFirst();
        if (!located) throw new AppError("candidate_not_found", "Commons photo candidate not found", 404);

        const identity = await transaction.selectFrom("place_identities").select("id")
          .where("id", "=", located.place_id).forUpdate().executeTakeFirst();
        if (!identity) throw new AppError("candidate_not_found", "Commons photo candidate not found", 404);
        const tripPlace = await transaction.selectFrom("trip_places").select("id")
          .where("place_id", "=", identity.id)
          .where("trip_id", "=", tripId)
          .where("archived_at", "is", null)
          .executeTakeFirst();
        if (!tripPlace) throw new AppError("candidate_not_found", "Commons photo candidate not found", 404);
        const lockedCandidates = await transaction.selectFrom("commons_photo_candidates")
          .select(["id", "place_id", "wikidata_id", "metadata", "status"])
          .where("place_id", "=", identity.id)
          .orderBy("id")
          .forUpdate()
          .execute();
        const candidate = lockedCandidates.find((item) => item.id === candidateId);
        if (!candidate) throw new AppError("candidate_not_found", "Commons photo candidate not found", 404);
        const existingPhoto = await transaction.selectFrom("commons_place_photos")
          .select("place_id").where("place_id", "=", candidate.place_id).executeTakeFirst();
        if (candidate.status !== "pending" || existingPhoto) {
          throw new AppError("candidate_already_decided", "Commons photo candidate was already decided", 409);
        }
        const decidedAt = this.now();
        if (decision === "confirm") {
          const photo = parseCuratedPhoto(candidate.metadata);
          const stored = await this.photos.storeConfirmed(
            transaction,
            candidate.place_id,
            candidate.wikidata_id,
            photo,
          );
          if (!stored) {
            throw new AppError("candidate_already_decided", "Commons photo candidate was already decided", 409);
          }
          await transaction.updateTable("commons_photo_candidates").set({
            status: "confirmed",
            auto_applied: false,
            decided_by_user_id: userId,
            decided_at: decidedAt,
          }).where("id", "=", candidate.id).execute();
          await transaction.updateTable("commons_photo_candidates").set({
            status: "rejected",
            auto_applied: false,
            decided_by_user_id: userId,
            decided_at: decidedAt,
          }).where("place_id", "=", candidate.place_id)
            .where("id", "!=", candidate.id)
            .where("status", "=", "pending")
            .execute();
        } else {
          await transaction.updateTable("commons_photo_candidates").set({
            status: "rejected",
            auto_applied: false,
            decided_by_user_id: userId,
            decided_at: decidedAt,
          }).where("id", "=", candidate.id).execute();
        }
        return { remaining: await this.remaining(transaction, tripId) };
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      const code = object(error)?.code;
      if (code === "40001" || code === "40P01") {
        throw new AppError("candidate_already_decided", "Commons photo candidate was already decided", 409);
      }
      throw error;
    }
  }

  async report(userId: string, tripId: string, tripPlaceId: string): Promise<CommonsPhotoReportResponse> {
    if (!UUID.test(tripPlaceId)) throw new AppError("validation_error", "tripPlaceId must be a UUID");
    return this.database.transaction().execute(async (transaction) => {
      await this.requireDecisionPermission(transaction, userId, tripId);
      const tripPlace = await transaction.selectFrom("trip_places")
        .select(["place_id", "name", "place_type"])
        .where("id", "=", tripPlaceId)
        .where("trip_id", "=", tripId)
        .where("archived_at", "is", null)
        .executeTakeFirst();
      if (!tripPlace) throw new AppError("trip_place_not_found", "Trip place not found", 404);
      await transaction.selectFrom("place_identities").select("id")
        .where("id", "=", tripPlace.place_id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const photo = await transaction.selectFrom("commons_place_photos")
        .select(["wikidata_id", "metadata"])
        .where("place_id", "=", tripPlace.place_id)
        .executeTakeFirst();
      if (!photo) throw new AppError("commons_photo_not_found", "Commons photo not found", 409);
      const decidedAt = this.now();
      const candidate = await transaction.selectFrom("commons_photo_candidates")
        .select("id")
        .where("place_id", "=", tripPlace.place_id)
        .where("wikidata_id", "=", photo.wikidata_id)
        .forUpdate()
        .executeTakeFirst();
      if (candidate) {
        await transaction.updateTable("commons_photo_candidates").set({
          status: "rejected",
          auto_applied: false,
          decided_by_user_id: userId,
          decided_at: decidedAt,
        }).where("id", "=", candidate.id).execute();
      } else {
        await transaction.insertInto("commons_photo_candidates").values({
          place_id: tripPlace.place_id,
          wikidata_id: photo.wikidata_id,
          label: `Wikidata ${photo.wikidata_id}`,
          names: JSON.stringify([]),
          instance_of: JSON.stringify([]),
          description: null,
          distance_meters: null,
          metadata: photo.metadata,
          status: "rejected",
          auto_applied: false,
          decided_by_user_id: userId,
          decided_at: decidedAt,
        }).execute();
      }
      await transaction.deleteFrom("commons_place_photos")
        .where("place_id", "=", tripPlace.place_id)
        .execute();
      const remaining = await transaction.selectFrom("commons_photo_candidates")
        .select("names")
        .where("place_id", "=", tripPlace.place_id)
        .where("status", "=", "pending")
        .execute();
      return {
        remainingCandidates: remaining.filter((entry) =>
          namesRelated(tripPlace.name, tripPlace.place_type, candidateNames(entry.names))).length,
      };
    });
  }

  async getAsset(userId: string, tripId: string, candidateId: string, filename: string) {
    if (!UUID.test(candidateId) || !/^[a-f0-9]{64}\.(jpg|png|webp)$/.test(filename)) {
      throw new AppError("candidate_asset_not_found", "Commons candidate asset not found", 404);
    }
    await this.requireMember(this.database, userId, tripId);
    const candidate = await this.database.selectFrom("commons_photo_candidates as candidate")
      .innerJoin("trip_places as tripPlace", "tripPlace.place_id", "candidate.place_id")
      .select("candidate.metadata")
      .where("candidate.id", "=", candidateId)
      .where("tripPlace.trip_id", "=", tripId)
      .executeTakeFirst();
    if (!candidate) throw new AppError("candidate_asset_not_found", "Commons candidate asset not found", 404);
    const photo = parseCuratedPhoto(candidate.metadata);
    if (filename !== photo.image.filename && filename !== photo.thumbnail.filename) {
      throw new AppError("candidate_asset_not_found", "Commons candidate asset not found", 404);
    }
    const blob = await this.database.selectFrom("place_photo_blobs")
      .select(["bytes", "media_type"])
      .where("filename", "=", filename)
      .executeTakeFirst();
    if (!blob) throw new AppError("candidate_asset_not_found", "Commons candidate asset not found", 404);
    return { bytes: blob.bytes as Uint8Array<ArrayBuffer>, mediaType: blob.media_type };
  }

  private async findCandidates(
    placeName: string,
    placeType: PlaceType,
    placeCoordinate: { latitude: number; longitude: number } | null,
    signal: AbortSignal,
  ): Promise<CandidateFacts[]> {
    const ranks = new Map<string, SearchRank>();
    for (const language of LANGUAGES) {
      const response = object(await this.json(WIKIDATA_API, {
        action: "wbsearchentities",
        search: placeName,
        language,
        uselang: language,
        type: "item",
        limit: "10",
        origin: "*",
      }, signal));
      const results = response?.search;
      if (!Array.isArray(results)) throw new Error("Invalid Wikidata search response");
      results.forEach((value, index) => {
        const id = wikidataId(object(value)?.id);
        if (!id) return;
        const rank = ranks.get(id) ?? { score: 0, geoDistanceKm: null };
        rank.score += Math.max(0, 42 - 4 * index);
        ranks.set(id, rank);
      });
    }
    if (placeCoordinate) {
      const query = `SELECT ?item ?location ?dist WHERE {
  SERVICE wikibase:around {
    ?item wdt:P625 ?location .
    bd:serviceParam wikibase:center "Point(${placeCoordinate.longitude} ${placeCoordinate.latitude})"^^geo:wktLiteral .
    bd:serviceParam wikibase:radius "1" .
    bd:serviceParam wikibase:distance ?dist .
  }
} ORDER BY ?dist LIMIT 20`;
      const response = object(await this.json(WIKIDATA_QUERY, { query }, signal));
      const bindings = object(object(response?.results))?.bindings;
      if (!Array.isArray(bindings)) throw new Error("Invalid Wikidata geo response");
      for (const value of bindings) {
        const binding = object(value);
        const itemUrl = object(binding?.item)?.value;
        const id = typeof itemUrl === "string" ? wikidataId(itemUrl.match(/Q[1-9][0-9]*$/)?.[0]) : null;
        const rawDistance = Number(object(binding?.dist)?.value);
        if (!id || !Number.isFinite(rawDistance) || rawDistance < 0) continue;
        const rank = ranks.get(id) ?? { score: 0, geoDistanceKm: null };
        rank.geoDistanceKm = rawDistance;
        rank.score += 26 - Math.min(25, 25 * rawDistance);
        ranks.set(id, rank);
      }
    }
    const rankedIds = [...ranks.entries()]
      .sort((first, second) => second[1].score - first[1].score)
      .slice(0, 50)
      .map(([id]) => id);
    const candidates = (await this.fetchCandidateFacts(
      rankedIds,
      placeCoordinate,
      ranks,
      signal,
    )).filter((candidate) => candidate.hasP18 && namesRelated(placeName, placeType, candidate.names));
    for (const candidate of candidates) {
      if (namesExactlyEqual(placeName, placeType, candidate.names)) candidate.score += 70;
    }
    candidates.sort((first, second) => second.score - first.score
      || (first.distanceMeters ?? Number.MAX_SAFE_INTEGER) - (second.distanceMeters ?? Number.MAX_SAFE_INTEGER)
      || Number(first.wikidataId.slice(1)) - Number(second.wikidataId.slice(1)));
    return candidates;
  }

  private async fetchCandidateFacts(
    ids: string[],
    placeCoordinate: { latitude: number; longitude: number } | null,
    ranks: ReadonlyMap<string, SearchRank>,
    signal: AbortSignal,
  ): Promise<CandidateFacts[]> {
    if (ids.length === 0) return [];
    const response = object(await this.json(WIKIDATA_API, {
      action: "wbgetentities",
      ids: ids.join("|"),
      props: "labels|aliases|descriptions|claims",
      languages: LANGUAGES.join("|"),
      languagefallback: "1",
    }, signal));
    const entities = object(response?.entities);
    if (!entities) throw new Error("Invalid Wikidata entity response");
    const typeIds = new Set<string>();
    for (const id of ids) {
      for (const typeId of instanceOfIds(object(object(entities[id])?.claims))) typeIds.add(typeId);
    }
    let typeEntities: Record<string, unknown> = {};
    if (typeIds.size > 0) {
      const typeResponse = object(await this.json(WIKIDATA_API, {
        action: "wbgetentities",
        ids: [...typeIds].slice(0, 50).join("|"),
        props: "labels",
        languages: LANGUAGES.join("|"),
        languagefallback: "1",
      }, signal));
      typeEntities = object(typeResponse?.entities) ?? {};
    }
    const candidates: CandidateFacts[] = [];
    for (const id of ids) {
      const entity = object(entities[id]);
      if (!entity) continue;
      const claims = object(entity.claims);
      const label = localizedText(entity, "labels");
      const names = entityNames(entity);
      if (!label || names.length === 0) continue;
      const rank = ranks.get(id) ?? { score: 0, geoDistanceKm: null };
      const candidateCoordinate = coordinate(claims);
      const distance = placeCoordinate && candidateCoordinate
        ? distanceMeters(placeCoordinate, candidateCoordinate)
        : rank.geoDistanceKm === null ? null : Math.round(rank.geoDistanceKm * 1_000);
      candidates.push({
        wikidataId: id,
        label,
        names,
        instanceOf: instanceOfIds(claims).map((typeId) => ({
          id: typeId,
          label: localizedText(object(typeEntities[typeId]) ?? {}, "labels") ?? typeId,
        })),
        description: localizedText(entity, "descriptions"),
        distanceMeters: distance,
        score: rank.score,
        hasP18: Array.isArray(claims?.P18) && claims.P18.length > 0,
      });
    }
    return candidates;
  }

  private async placeFacts(placeIdentityId: string) {
    const identity = await this.database.selectFrom("place_identities as identity")
      .leftJoin("commons_place_photos as photo", "photo.place_id", "identity.id")
      .select([
        "identity.canonical_name",
        "identity.latitude",
        "identity.longitude",
        "photo.place_id as photo_place_id",
      ])
      .where("identity.id", "=", placeIdentityId)
      .executeTakeFirst();
    if (!identity) throw new Error("Place identity not found");
    const tripPlace = await this.database.selectFrom("trip_places")
      .select(["name", "place_type"])
      .where("place_id", "=", placeIdentityId)
      .orderBy("archived_at", "desc")
      .orderBy("created_at")
      .executeTakeFirst();
    if (!tripPlace) throw new Error("Place identity has no trip place");
    return {
      name: tripPlace.name || identity.canonical_name,
      placeType: tripPlace.place_type,
      coordinate: identity.latitude === null || identity.longitude === null
        ? null
        : { latitude: identity.latitude, longitude: identity.longitude },
      hasPhoto: identity.photo_place_id !== null,
    };
  }

  private autoEligible(placeName: string, placeType: PlaceType, facts: CandidateFacts) {
    return Boolean(AUTO_PLACE_TYPES[placeType])
      && namesExactlyEqual(placeName, placeType, facts.names)
      && typeCompatible(placeType, facts.instanceOf)
      && facts.distanceMeters !== null
      && facts.distanceMeters <= 300;
  }

  private async prepareCandidates(
    facts: CandidateFacts[],
    placeName: string,
    placeType: PlaceType,
    signal: AbortSignal,
  ) {
    const prepared: Array<{ facts: CandidateFacts; photo: PreparedCommonsPhoto }> = [];
    let manualPrepared = 0;
    for (const candidate of facts) {
      const autoPotential = this.autoEligible(placeName, placeType, candidate);
      if (manualPrepared >= 3 && !autoPotential) continue;
      const photo = await this.photos.prepareWikidataCandidate(candidate.wikidataId, signal);
      if (!photo) continue;
      prepared.push({ facts: candidate, photo });
      if (manualPrepared < 3) manualPrepared++;
    }
    return prepared;
  }

  private async storeGenerated(
    placeIdentityId: string,
    placeName: string,
    placeType: PlaceType,
    prepared: Array<{ facts: CandidateFacts; photo: PreparedCommonsPhoto }>,
  ): Promise<CommonsCandidateGenerationResult> {
    const eligible = prepared.filter((candidate) => this.autoEligible(placeName, placeType, candidate.facts));
    const autoCandidate = eligible.length === 1 ? eligible[0]! : null;
    const selected = prepared.slice(0, 3);
    if (autoCandidate && !selected.some((candidate) => candidate.facts.wikidataId === autoCandidate.facts.wikidataId)) {
      selected.push(autoCandidate);
    }
    return this.database.transaction().execute(async (transaction) => {
      await transaction.selectFrom("place_identities").select("id")
        .where("id", "=", placeIdentityId).forUpdate().executeTakeFirstOrThrow();
      const photo = await transaction.selectFrom("commons_place_photos")
        .select("place_id").where("place_id", "=", placeIdentityId).executeTakeFirst();
      if (photo) return { outcome: "has_photo", stored: 0 };
      const existing = await transaction.selectFrom("commons_photo_candidates")
        .select("id").where("place_id", "=", placeIdentityId).executeTakeFirst();
      if (existing) return { outcome: "already_generated", stored: 0 };
      const decidedAt = autoCandidate ? this.now() : null;
      let stored = 0;
      for (const candidate of selected) {
        const chosen = candidate === autoCandidate;
        await this.photos.storeRenditions(transaction, candidate.photo);
        await transaction.insertInto("commons_photo_candidates").values({
          place_id: placeIdentityId,
          wikidata_id: candidate.facts.wikidataId,
          label: candidate.facts.label,
          names: JSON.stringify(candidate.facts.names),
          instance_of: JSON.stringify(candidate.facts.instanceOf),
          description: candidate.facts.description,
          distance_meters: candidate.facts.distanceMeters,
          metadata: JSON.stringify(candidate.photo.photo),
          status: autoCandidate ? (chosen ? "confirmed" : "rejected") : "pending",
          auto_applied: chosen,
          decided_by_user_id: null,
          decided_at: decidedAt,
        }).execute();
        stored++;
      }
      if (autoCandidate) {
        const photoStored = await this.photos.storeConfirmed(
          transaction,
          placeIdentityId,
          autoCandidate.facts.wikidataId,
          autoCandidate.photo.photo,
        );
        if (!photoStored) throw new Error("Commons photo changed during candidate generation");
        return { outcome: "auto_applied", stored };
      }
      return { outcome: "generated", stored };
    });
  }

  private async requireMember(executor: DatabaseExecutor, userId: string, tripId: string) {
    const membership = await executor.selectFrom("trip_members").select("user_id")
      .where("trip_id", "=", tripId)
      .where("user_id", "=", userId)
      .where("removed_at", "is", null)
      .executeTakeFirst();
    if (!membership) throw new AppError("trip_not_found", "Trip not found", 404);
  }

  private async requireDecisionPermission(executor: DatabaseExecutor, userId: string, tripId: string) {
    const membership = await executor.selectFrom("trip_members").select("role")
      .where("trip_id", "=", tripId)
      .where("user_id", "=", userId)
      .where("removed_at", "is", null)
      .executeTakeFirst();
    if (!membership) {
      throw new AppError("forbidden", "Only trip members who can edit places may change Commons photos", 403);
    }
  }

  private async remaining(executor: DatabaseExecutor, tripId: string) {
    const rows = await executor.selectFrom("commons_photo_candidates as candidate")
      .innerJoin("trip_places as tripPlace", "tripPlace.place_id", "candidate.place_id")
      .leftJoin("commons_place_photos as photo", "photo.place_id", "candidate.place_id")
      .select(["candidate.names", "tripPlace.name", "tripPlace.place_type"])
      .where("tripPlace.trip_id", "=", tripId)
      .where("tripPlace.archived_at", "is", null)
      .where("candidate.status", "=", "pending")
      .where("photo.place_id", "is", null)
      .execute();
    return rows.filter((row) => namesRelated(row.name, row.place_type, candidateNames(row.names))).length;
  }

  private async json(endpoint: string, parameters: Record<string, string>, signal: AbortSignal) {
    const url = new URL(endpoint);
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
    if (endpoint === WIKIDATA_API) {
      url.searchParams.set("format", "json");
      url.searchParams.set("formatversion", "2");
    } else {
      url.searchParams.set("format", "json");
    }
    const response = await this.fetch(url, {
      signal,
      headers: { "User-Agent": this.userAgent, Accept: "application/json" },
    });
    if (!response.ok || !response.headers.get("content-type")?.includes("json")) {
      throw new Error("Wikimedia API is unavailable");
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) throw new Error("Wikimedia response is too large");
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_JSON_BYTES) throw new Error("Wikimedia response is too large");
    const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (object(value)?.error) throw new Error("Wikimedia API rejected the request");
    return value;
  }
}
