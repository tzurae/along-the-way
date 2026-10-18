import type { PlaceType } from "@along-the-way/contracts/trip-skeleton";
import type { Kysely, Transaction } from "kysely";

import type { AlongTheWayDatabase } from "../database/database";
import { AppError } from "../private-trips/private-trip-module";
import type { CommonsCandidatePhotoSource, PreparedCommonsPhoto } from "./commons-place-photos";

const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const WIKIDATA_QUERY = "https://query.wikidata.org/sparql";
const LANGUAGES = ["ja", "zh", "zh-hant", "zh-tw", "en"] as const;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NAME_VARIANTS: Record<string, string> = {
  "禅": "禪", "観": "觀", "国": "國", "宝": "寶", "温": "溫", "庵": "菴",
  "駅": "站", "臺": "台", "の": "", "之": "",
};

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface CandidateName {
  lang: string;
  value: string;
}

interface CandidateInstanceOf {
  id: string;
  label: string;
}

export type CommonsCandidateGenerationOutcome =
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
}

interface SearchRank {
  score: number;
  geoDistanceKm: number | null;
}

interface CandidateFacts {
  wikidataId: string;
  label: string;
  names: CandidateName[];
  instanceOf: CandidateInstanceOf[];
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

export function namesRelated(
  placeName: string,
  placeType: PlaceType,
  candidateNames: readonly CandidateName[],
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


function entityNames(entity: Record<string, unknown>): CandidateName[] {
  const labels = object(entity.labels);
  const aliases = object(entity.aliases);
  const names: CandidateName[] = [];
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

export async function removeCommonsPhoto(
  transaction: Transaction<AlongTheWayDatabase>,
  placeIdentityId: string,
  decidedByUserId: string,
  decidedAt: Date,
  expectedWikidataId?: string,
) {
  const identity = await transaction.selectFrom("place_identities").select("id")
    .where("id", "=", placeIdentityId)
    .forUpdate()
    .executeTakeFirst();
  if (!identity) throw new AppError("trip_place_not_found", "Trip place not found", 404);
  const photo = await transaction.selectFrom("commons_place_photos")
    .select(["wikidata_id", "metadata"])
    .where("place_id", "=", placeIdentityId)
    .executeTakeFirst();
  if (!photo) throw new AppError("commons_photo_not_found", "Commons photo not found", 409);
  if (expectedWikidataId !== undefined && photo.wikidata_id !== expectedWikidataId) {
    throw new AppError("commons_photo_not_found", "Reported Commons photo is no longer shown", 409);
  }
  const candidate = await transaction.selectFrom("commons_photo_candidates")
    .select("id")
    .where("place_id", "=", placeIdentityId)
    .where("wikidata_id", "=", photo.wikidata_id)
    .forUpdate()
    .executeTakeFirst();
  if (candidate) {
    await transaction.updateTable("commons_photo_candidates").set({
      status: "rejected",
      auto_applied: false,
      decided_by_user_id: decidedByUserId,
      decided_at: decidedAt,
    }).where("id", "=", candidate.id).execute();
  } else {
    await transaction.insertInto("commons_photo_candidates").values({
      place_id: placeIdentityId,
      wikidata_id: photo.wikidata_id,
      label: `Wikidata ${photo.wikidata_id}`,
      names: JSON.stringify([]),
      instance_of: JSON.stringify([]),
      description: null,
      distance_meters: null,
      metadata: photo.metadata,
      status: "rejected",
      auto_applied: false,
      decided_by_user_id: decidedByUserId,
      decided_at: decidedAt,
    }).execute();
  }
  await transaction.deleteFrom("commons_place_photos")
    .where("place_id", "=", placeIdentityId)
    .execute();
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
    return this.generateAutomatic(placeIdentityId, false);
  }

  async refresh(placeIdentityId: string): Promise<CommonsCandidateGenerationResult> {
    return this.generateAutomatic(placeIdentityId, true);
  }

  private async generateAutomatic(
    placeIdentityId: string,
    refreshing: boolean,
  ): Promise<CommonsCandidateGenerationResult> {
    if (!UUID.test(placeIdentityId)) throw new TypeError("placeIdentityId must be a UUID");
    const signal = AbortSignal.timeout(this.generateBudgetMs);
    const place = await this.placeFacts(placeIdentityId);
    if (place.hasPhoto) return { outcome: "has_photo", stored: 0 };
    const existing = await this.database.selectFrom("commons_photo_candidates")
      .select(["wikidata_id", "status"])
      .where("place_id", "=", placeIdentityId)
      .orderBy("created_at")
      .orderBy("id")
      .execute();
    const existingStatusById = new Map(
      existing.map((candidate) => [candidate.wikidata_id, candidate.status]),
    );
    const discovered = await this.findCandidates(
      place.name,
      place.placeType,
      place.coordinate,
      signal,
    );
    const discoveredById = new Map(
      discovered.map((candidate) => [candidate.wikidataId, candidate]),
    );
    const pendingIds = existing
      .filter((candidate) =>
        candidate.status === "pending" && !discoveredById.has(candidate.wikidata_id))
      .map((candidate) => candidate.wikidata_id);
    const refreshedPending = await this.fetchCandidateFacts(
      pendingIds,
      place.coordinate,
      new Map(),
      signal,
    );
    const factsById = new Map(
      [...discovered, ...refreshedPending].map((candidate) => [candidate.wikidataId, candidate]),
    );
    const prepared = await this.prepareCandidates(
      [...factsById.values()],
      place.name,
      place.placeType,
      existingStatusById,
      Math.max(0, 3 - existing.length),
      signal,
    );
    signal.throwIfAborted();
    if (prepared.length === 0) {
      if (refreshing) return { outcome: "refreshed", stored: existing.length };
      return existing.length > 0
        ? { outcome: "already_generated", stored: 0 }
        : { outcome: "no_candidates", stored: 0 };
    }
    return this.storeGenerated(placeIdentityId, prepared, refreshing);
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
      .map(([id]) => id);
    return (await this.fetchCandidateFacts(
      rankedIds,
      placeCoordinate,
      ranks,
      signal,
    )).filter((candidate) => candidate.hasP18);
  }

  private async fetchCandidateFacts(
    ids: string[],
    placeCoordinate: { latitude: number; longitude: number } | null,
    ranks: ReadonlyMap<string, SearchRank>,
    signal: AbortSignal,
  ): Promise<CandidateFacts[]> {
    if (ids.length === 0) return [];
    if (ids.length > 50) {
      const candidates: CandidateFacts[] = [];
      for (let offset = 0; offset < ids.length; offset += 50) {
        candidates.push(...await this.fetchCandidateFacts(
          ids.slice(offset, offset + 50),
          placeCoordinate,
          ranks,
          signal,
        ));
      }
      return candidates;
    }
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

  private async prepareCandidates(
    facts: CandidateFacts[],
    placeName: string,
    placeType: PlaceType,
    existingStatusById: ReadonlyMap<string, "pending" | "confirmed" | "rejected">,
    remainingSlots: number,
    signal: AbortSignal,
  ) {
    const candidates = facts.flatMap((candidate) => {
      const existingStatus = existingStatusById.get(candidate.wikidataId);
      if ((existingStatus !== undefined && existingStatus !== "pending") || !candidate.hasP18) {
        return [];
      }
      const nameRelated = namesRelated(placeName, placeType, candidate.names);
      return nameRelated || (candidate.distanceMeters !== null && candidate.distanceMeters <= 1_000)
        ? [{ candidate, existing: existingStatus === "pending", nameRelated }]
        : [];
    });
    candidates.sort((first, second) => {
      if (first.nameRelated !== second.nameRelated) return first.nameRelated ? -1 : 1;
      return (first.candidate.distanceMeters ?? Number.MAX_SAFE_INTEGER)
        - (second.candidate.distanceMeters ?? Number.MAX_SAFE_INTEGER)
        || second.candidate.score - first.candidate.score
        || Number(first.candidate.wikidataId.slice(1))
          - Number(second.candidate.wikidataId.slice(1));
    });
    const prepared: Array<{ facts: CandidateFacts; photo: PreparedCommonsPhoto }> = [];
    let preparedNewCandidates = 0;
    for (const { candidate, existing } of candidates) {
      if (!existing && preparedNewCandidates >= remainingSlots) continue;
      const photo = await this.photos.prepareWikidataCandidate(candidate.wikidataId, signal);
      if (!photo) continue;
      prepared.push({ facts: candidate, photo });
      if (!existing) preparedNewCandidates++;
    }
    return prepared;
  }

  private async storeGenerated(
    placeIdentityId: string,
    prepared: Array<{ facts: CandidateFacts; photo: PreparedCommonsPhoto }>,
    refreshing: boolean,
  ): Promise<CommonsCandidateGenerationResult> {
    return this.database.transaction().execute(async (transaction) => {
      await transaction.selectFrom("place_identities").select("id")
        .where("id", "=", placeIdentityId).forUpdate().executeTakeFirstOrThrow();
      const photo = await transaction.selectFrom("commons_place_photos")
        .select("place_id").where("place_id", "=", placeIdentityId).executeTakeFirst();
      if (photo) return { outcome: "has_photo", stored: 0 };
      const existing = await transaction.selectFrom("commons_photo_candidates")
        .select(["id", "wikidata_id", "status"])
        .where("place_id", "=", placeIdentityId)
        .orderBy("created_at")
        .orderBy("id")
        .forUpdate()
        .execute();
      const existingByWikidataId = new Map(existing.map((candidate) => [
        candidate.wikidata_id,
        candidate,
      ]));
      const available: Array<{
        id: string;
        facts: CandidateFacts;
        photo: PreparedCommonsPhoto;
      }> = [];
      let inserted = 0;
      for (const candidate of prepared) {
        const current = existingByWikidataId.get(candidate.facts.wikidataId);
        if (current && current.status !== "pending") continue;
        if (!current && existing.length + inserted >= 3) continue;
        if (current) {
          await transaction.updateTable("commons_photo_candidates").set({
            label: candidate.facts.label,
            names: JSON.stringify(candidate.facts.names),
            instance_of: JSON.stringify(candidate.facts.instanceOf),
            description: candidate.facts.description,
            distance_meters: candidate.facts.distanceMeters,
            metadata: JSON.stringify(candidate.photo.photo),
          }).where("id", "=", current.id).execute();
          available.push({ id: current.id, ...candidate });
          continue;
        }
        const created = await transaction.insertInto("commons_photo_candidates").values({
          place_id: placeIdentityId,
          wikidata_id: candidate.facts.wikidataId,
          label: candidate.facts.label,
          names: JSON.stringify(candidate.facts.names),
          instance_of: JSON.stringify(candidate.facts.instanceOf),
          description: candidate.facts.description,
          distance_meters: candidate.facts.distanceMeters,
          metadata: JSON.stringify(candidate.photo.photo),
          status: "pending",
          auto_applied: false,
          decided_by_user_id: null,
          decided_at: null,
        }).returning("id").executeTakeFirstOrThrow();
        inserted++;
        available.push({ id: created.id, ...candidate });
      }
      const chosen = available[0];
      if (!chosen) {
        if (refreshing) return { outcome: "refreshed", stored: existing.length };
        return existing.length > 0
          ? { outcome: "already_generated", stored: 0 }
          : { outcome: "no_candidates", stored: 0 };
      }
      await this.photos.storeRenditions(transaction, chosen.photo);
      const photoStored = await this.photos.storeConfirmed(
        transaction,
        placeIdentityId,
        chosen.facts.wikidataId,
        chosen.photo.photo,
      );
      if (!photoStored) throw new Error("Commons photo changed during candidate generation");
      const decidedAt = this.now();
      await transaction.updateTable("commons_photo_candidates").set({
        status: "confirmed",
        auto_applied: true,
        decided_by_user_id: null,
        decided_at: decidedAt,
      }).where("id", "=", chosen.id).execute();
      await transaction.updateTable("commons_photo_candidates").set({
        status: "rejected",
        auto_applied: false,
        decided_by_user_id: null,
        decided_at: decidedAt,
      }).where("place_id", "=", placeIdentityId)
        .where("id", "!=", chosen.id)
        .where("status", "=", "pending")
        .execute();
      return { outcome: "auto_applied", stored: inserted };
    });
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
