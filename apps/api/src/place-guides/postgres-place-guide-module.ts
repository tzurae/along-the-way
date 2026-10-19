import { randomUUID } from "node:crypto";

import { sql, type Kysely, type Selectable } from "kysely";
import {
  parsePlaceGuideContent,
  parsePlaceGuideSources,
  type PlaceDetailReference,
  type PlaceGuideDto,
} from "@along-the-way/contracts/place-details";
import type { AlongTheWayDatabase, PlaceGuideTable } from "../database/database";
import { AppError } from "../private-trips/private-trip-module";
import type {
  ClaimPlaceGuideGeneration,
  PlaceGuideModule,
} from "./place-guide-module";
import { OpenAiPlaceGuideModel } from "./openai-place-guide-model";
import {
  PlaceGuideSourceFetcher,
  type PlaceGuideEvidenceSource,
} from "./place-guide-sources";

const CLAIM_STALE_MILLISECONDS = 2 * 60 * 1_000;
const FAILED_RETRY_MILLISECONDS = 60 * 60 * 1_000;
const DEFAULT_WAIT_MILLISECONDS = 8_000;

interface ResolvedGuidePlace {
  placeId: string | null;
  name: string;
}

interface GenerationClaimOptions {
  force: boolean;
  waitForClaim: boolean;
}

const STANDARD_CLAIM: GenerationClaimOptions = { force: false, waitForClaim: false };
const ADMIN_CLAIM: GenerationClaimOptions = { force: true, waitForClaim: false };
const BACKFILL_CLAIM: GenerationClaimOptions = { force: false, waitForClaim: true };

type StoredPlaceGuide = Selectable<PlaceGuideTable>;

const EMPTY_GUIDE: Pick<
  PlaceGuideDto,
  "history" | "see" | "do" | "eat" | "sources"
> = {
  history: null,
  see: [],
  do: [],
  eat: [],
  sources: [],
};

export class PostgresPlaceGuideModule implements PlaceGuideModule {
  private readonly flights = new Map<string, Promise<PlaceGuideDto>>();
  private readonly now: () => Date;
  private readonly waitMilliseconds: number;

  constructor(private readonly options: {
    database: Kysely<AlongTheWayDatabase>;
    model: OpenAiPlaceGuideModel;
    sources: PlaceGuideSourceFetcher;
    now?: () => Date;
    waitMilliseconds?: number;
  }) {
    this.now = options.now ?? (() => new Date());
    this.waitMilliseconds = options.waitMilliseconds ?? DEFAULT_WAIT_MILLISECONDS;
  }

  async getGuide(
    userId: string,
    tripId: string,
    reference: PlaceDetailReference,
    claimGeneration: ClaimPlaceGuideGeneration,
  ) {
    await this.authorize(userId, tripId);
    const place = await this.resolve(tripId, reference);
    if (!place.placeId) return this.noSources(null);
    const stored = await this.storedGuide(place.placeId);
    if (stored?.status === "ready" || stored?.status === "no_sources") return this.fromStored(stored);
    if (stored?.status === "generating"
      && stored.claimed_at
      && this.now().getTime() - stored.claimed_at.getTime() < CLAIM_STALE_MILLISECONDS) {
      return this.pending();
    }
    if (!this.options.model.available) {
      return this.noSources(stored?.generated_at ?? null);
    }
    if (stored?.status === "failed"
      && this.now().getTime() - stored.generated_at.getTime() < FAILED_RETRY_MILLISECONDS) {
      return this.noSources(stored.generated_at);
    }
    if (this.flights.has(place.placeId)) return this.pending();
    return this.startAndWait(place.placeId, place.name, claimGeneration);
  }

  async regenerate(placeId: string, claimGeneration: ClaimPlaceGuideGeneration) {
    const place = await this.identity(placeId);
    if (!this.options.model.available) return this.noSources(null);
    if (this.flights.has(placeId)) {
      return this.startAndWait(placeId, place.name, async () => undefined);
    }
    await claimGeneration();
    return this.startAndWait(placeId, place.name, async () => undefined, ADMIN_CLAIM);
  }

  /** Backfill entry point: waits for the complete serial generation and never consumes an account quota. */
  async generateForPlace(placeId: string) {
    const place = await this.identity(placeId);
    if (!this.options.model.available) return this.noSources(null);
    return this.start(placeId, place.name, async () => undefined, BACKFILL_CLAIM);
  }

  private async startAndWait(
    placeId: string,
    placeName: string,
    claimGeneration: ClaimPlaceGuideGeneration,
    claimOptions: GenerationClaimOptions = STANDARD_CLAIM,
  ) {
    const pending = this.start(placeId, placeName, claimGeneration, claimOptions);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), this.waitMilliseconds);
    });
    try {
      const result = await Promise.race([pending, timeout]);
      return result ?? this.pending();
    } finally {
      clearTimeout(timer);
    }
  }

  private start(
    placeId: string,
    placeName: string,
    claimGeneration: ClaimPlaceGuideGeneration,
    claimOptions: GenerationClaimOptions = STANDARD_CLAIM,
  ) {
    const existing = this.flights.get(placeId);
    if (existing) return existing;
    const pending = this.generateWithClaim(placeId, placeName, claimGeneration, claimOptions);
    this.flights.set(placeId, pending);
    void pending.then(
      () => this.flights.delete(placeId),
      () => this.flights.delete(placeId),
    );
    return pending;
  }

  private async generateWithClaim(
    placeId: string,
    placeName: string,
    claimGeneration: ClaimPlaceGuideGeneration,
    claimOptions: GenerationClaimOptions,
  ): Promise<PlaceGuideDto> {
    await claimGeneration();
    while (true) {
      const token = await this.reserveGeneration(placeId, claimOptions.force);
      if (token) return this.generateAndStore(placeId, placeName, token);
      const stored = await this.storedGuide(placeId);
      if (stored?.status === "ready" || stored?.status === "no_sources") {
        return this.fromStored(stored);
      }
      if (stored?.status === "failed"
        && this.now().getTime() - stored.generated_at.getTime() < FAILED_RETRY_MILLISECONDS) {
        return this.noSources(stored.generated_at);
      }
      if (!claimOptions.waitForClaim) return this.pending();
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 250);
      await promise;
    }
  }

  private async reserveGeneration(placeId: string, force: boolean) {
    const token = randomUUID();
    const claimedAt = this.now();
    const staleBefore = new Date(claimedAt.getTime() - CLAIM_STALE_MILLISECONDS);
    const retryBefore = new Date(claimedAt.getTime() - FAILED_RETRY_MILLISECONDS);
    const result = await this.options.database.transaction().execute((transaction) =>
      transaction.insertInto("place_guides").values({
        place_id: placeId,
        language: "zh-TW",
        history: null,
        see: JSON.stringify([]),
        do: JSON.stringify([]),
        eat: JSON.stringify([]),
        sources: JSON.stringify([]),
        model: null,
        status: "generating",
        claim_token: token,
        claimed_at: claimedAt,
        generated_at: claimedAt,
      }).onConflict((conflict) => {
        const reservation = conflict.column("place_id").doUpdateSet({
          language: "zh-TW",
          history: null,
          see: JSON.stringify([]),
          do: JSON.stringify([]),
          eat: JSON.stringify([]),
          sources: JSON.stringify([]),
          model: null,
          status: "generating",
          claim_token: token,
          claimed_at: claimedAt,
          generated_at: claimedAt,
        });
        const replaceable = force
          ? sql<boolean>`place_guides.status <> 'generating'
            or place_guides.claimed_at <= ${staleBefore}`
          : sql<boolean>`(
              place_guides.status = 'generating'
              and place_guides.claimed_at <= ${staleBefore}
            ) or (
              place_guides.status = 'failed'
              and place_guides.generated_at <= ${retryBefore}
            )`;
        return reservation.where(replaceable);
      }).returning("claim_token").executeTakeFirst()
    );
    return result?.claim_token === token ? token : null;
  }

  private async generateAndStore(
    placeId: string,
    placeName: string,
    claimToken: string,
  ): Promise<PlaceGuideDto> {
    const generatedAt = this.now();
    let sources: PlaceGuideEvidenceSource[] = [];
    try {
      const wikidataId = await this.wikidataId(placeId);
      sources = await this.options.sources.fetchForPlace(placeName, wikidataId);
      if (sources.length === 0) {
        const stored = await this.store(claimToken, {
          placeId,
          status: "no_sources",
          generatedAt,
          model: null,
          ...EMPTY_GUIDE,
        });
        return stored ? this.noSources(generatedAt) : this.currentGuide(placeId);
      }
      const generated = await this.options.model.generate(placeName, sources);
      const sourceDtos = sources.map(({ title, url }) => ({ title, url }));
      const stored = await this.store(claimToken, {
        placeId,
        status: "ready",
        generatedAt,
        history: generated.history,
        see: generated.see,
        do: generated.do,
        eat: generated.eat,
        sources: sourceDtos,
        model: generated.model,
      });
      if (!stored) return this.currentGuide(placeId);
      return {
        status: "ready",
        history: generated.history,
        see: generated.see,
        do: generated.do,
        eat: generated.eat,
        sources: sourceDtos,
        generatedAt: generatedAt.toISOString(),
      };
    } catch (error) {
      const sourceDtos = sources.map(({ title, url }) => ({ title, url }));
      const stored = await this.store(claimToken, {
        placeId,
        status: "failed",
        generatedAt,
        model: this.options.model.modelId,
        history: null,
        see: [],
        do: [],
        eat: [],
        sources: sourceDtos,
      });
      console.error(JSON.stringify({
        event: "place_guide_generation_failed",
        placeId,
        errorClass: error instanceof Error ? error.constructor.name : "NonErrorThrow",
      }));
      return stored ? this.noSources(generatedAt) : this.currentGuide(placeId);
    }
  }

  private store(claimToken: string, value: {
    placeId: string;
    status: "ready" | "no_sources" | "failed";
    generatedAt: Date;
    history: string | null;
    see: readonly string[];
    do: readonly string[];
    eat: readonly string[];
    sources: readonly { title: string; url: string }[];
    model: string | null;
  }) {
    return this.options.database.transaction().execute(async (transaction) => {
      const stored = await transaction.updateTable("place_guides").set({
        language: "zh-TW",
        history: value.history,
        see: JSON.stringify(value.see),
        do: JSON.stringify(value.do),
        eat: JSON.stringify(value.eat),
        sources: JSON.stringify(value.sources),
        model: value.model,
        status: value.status,
        claim_token: null,
        claimed_at: null,
        generated_at: value.generatedAt,
      }).where("place_id", "=", value.placeId)
        .where("status", "=", "generating")
        .where("claim_token", "=", claimToken)
        .returning("place_id")
        .executeTakeFirst();
      return Boolean(stored);
    });
  }

  private storedGuide(placeId: string) {
    return this.options.database.selectFrom("place_guides").selectAll()
      .where("place_id", "=", placeId).executeTakeFirst();
  }

  private async currentGuide(placeId: string) {
    const stored = await this.storedGuide(placeId);
    if (stored?.status === "ready" || stored?.status === "no_sources") return this.fromStored(stored);
    if (stored?.status === "generating") return this.pending();
    return this.noSources(stored?.generated_at ?? null);
  }

  private fromStored(stored: NonNullable<StoredPlaceGuide>): PlaceGuideDto {
    if (stored.status !== "ready") return this.noSources(stored.generated_at);
    const content = parsePlaceGuideContent({
      history: stored.history,
      see: stored.see,
      do: stored.do,
      eat: stored.eat,
    });
    return {
      status: "ready",
      ...content,
      sources: parsePlaceGuideSources(stored.sources),
      generatedAt: stored.generated_at.toISOString(),
    };
  }

  private async wikidataId(placeId: string) {
    const row = await this.options.database.selectFrom("place_identities as identity")
      .leftJoin("commons_place_photos as photo", "photo.place_id", "identity.id")
      .select(sql<string | null>`coalesce(
        photo.wikidata_id,
        (
          select candidate.wikidata_id
          from commons_photo_candidates candidate
          where candidate.place_id = identity.id and candidate.status = 'confirmed'
          order by candidate.auto_applied desc, candidate.decided_at desc nulls last, candidate.id
          limit 1
        )
      )`.as("wikidata_id"))
      .where("identity.id", "=", placeId)
      .executeTakeFirst();
    return row?.wikidata_id ?? null;
  }

  private async authorize(userId: string, tripId: string) {
    const member = await this.options.database.selectFrom("trip_members").select("user_id")
      .where("trip_id", "=", tripId)
      .where("user_id", "=", userId)
      .where("removed_at", "is", null)
      .executeTakeFirst();
    if (!member) throw new AppError("trip_not_found", "Trip not found", 404);
  }

  private async resolve(tripId: string, reference: PlaceDetailReference): Promise<ResolvedGuidePlace> {
    if (reference.kind === "trip-place") {
      const place = await this.options.database.selectFrom("trip_places")
        .select(["place_id as placeId", "name"])
        .where("trip_id", "=", tripId)
        .where("id", "=", reference.id)
        .where("archived_at", "is", null)
        .executeTakeFirst();
      if (!place) throw new AppError("place_not_found", "Place not found", 404);
      return place;
    }
    if (reference.kind === "itinerary-place") {
      const place = await this.options.database.selectFrom("places as legacy")
        .leftJoin("trip_places as tripPlace", (join) => join
          .onRef("tripPlace.legacy_place_id", "=", "legacy.id")
          .onRef("tripPlace.trip_id", "=", "legacy.trip_id"))
        .select(["tripPlace.place_id as placeId", "legacy.name"])
        .where("legacy.trip_id", "=", tripId)
        .where("legacy.id", "=", reference.id)
        .executeTakeFirst();
      if (!place) throw new AppError("place_not_found", "Place not found", 404);
      return place;
    }
    const place = await this.options.database.selectFrom("candidate_proposals as proposal")
      .leftJoin("trip_places as accepted", (join) => join
        .onRef("accepted.id", "=", "proposal.accepted_trip_place_id")
        .onRef("accepted.trip_id", "=", "proposal.trip_id"))
      .leftJoin("place_identities as identity", (join) => join
        .on("identity.provider", "=", "google")
        .onRef("identity.provider_place_id", "=", "proposal.provider_place_id"))
      .select([
        sql<string | null>`coalesce(accepted.place_id, identity.id)`.as("placeId"),
        "proposal.name",
      ])
      .where("proposal.trip_id", "=", tripId)
      .where("proposal.id", "=", reference.id)
      .executeTakeFirst();
    if (!place) throw new AppError("place_not_found", "Place not found", 404);
    return place;
  }

  private async identity(placeId: string) {
    const identity = await this.options.database.selectFrom("place_identities")
      .select(["id", "canonical_name as name"])
      .where("id", "=", placeId)
      .executeTakeFirst();
    if (!identity) throw new AppError("place_not_found", "Place not found", 404);
    return identity;
  }

  private pending(): PlaceGuideDto {
    return { status: "pending", ...EMPTY_GUIDE, generatedAt: null };
  }

  private noSources(generatedAt: Date | null): PlaceGuideDto {
    return {
      status: "no_sources",
      ...EMPTY_GUIDE,
      generatedAt: generatedAt?.toISOString() ?? null,
    };
  }
}
