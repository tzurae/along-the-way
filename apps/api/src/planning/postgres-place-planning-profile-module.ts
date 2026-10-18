import { createHash, randomUUID } from "node:crypto";

import { sql, type Kysely } from "kysely";
import type { PlaceType } from "@along-the-way/contracts/trip-skeleton";
import type { AlongTheWayDatabase } from "../database/database";
import type { DatabaseExecutor } from "../private-trips/postgres-private-trip-store";
import type { PlaceGuideEvidenceSource } from "../place-guides/place-guide-sources";
import { PlaceGuideSourceFetcher } from "../place-guides/place-guide-sources";
import {
  PLACE_ESTIMATE_POLICY_VERSION,
  PLACE_PLANNING_PROFILE_LANGUAGE,
  PLACE_PLANNING_PROFILE_PROMPT_VERSION,
  type PlacePlanningProfileConfidence,
  OpenAiPlacePlanningProfileModel,
} from "./openai-place-planning-profile-model";

const CLAIM_STALE_MILLISECONDS = 5 * 60 * 1_000;
export const PLACE_PLANNING_PROFILE_EVIDENCE_MAX_AGE_MILLISECONDS = 24 * 60 * 60 * 1_000;
const QUEUE_REFRESH_MILLISECONDS = 60 * 1_000;
const FAILED_RETRY_MILLISECONDS = [60 * 60 * 1_000, 6 * 60 * 60 * 1_000, 24 * 60 * 60 * 1_000] as const;
export const PLACE_PLANNING_PROFILE_DAILY_TRIP_LIMIT = 50;
const DAILY_RATE_SCOPE = "place_planning_profile_generation:trip";

export interface ValidPlacePlanningProfile {
  identityId: string;
  visitMinutes: number | null;
  effortLevel: number | null;
  confidence: PlacePlanningProfileConfidence;
  rationaleZhTw: string;
  evidenceIndexes: number[];
  sources: Array<{ title: string; url: string }>;
  generatedAt: Date;
}

export interface ReadValidProfilesOptions {
  model: string;
  language?: string;
  promptVersion?: string;
  policyVersion?: string;
  generationAvailable?: boolean;
}

interface ClaimedProfile {
  identityId: string;
  tripId: string;
  canonicalName: string;
  placeType: PlaceType;
  previousOutcome: "ready" | "no_evidence" | null;
  previousModel: string | null;
  previousPromptVersion: string | null;
  previousPolicyVersion: string | null;
  previousLanguage: string;
  previousEvidenceHash: string | null;
  previousInputHash: string | null;
  token: string;
}

interface ProfileRow {
  place_id: string;
  identity_name: string;
  identity_type: PlaceType;
  canonical_name: string | null;
  place_type: PlaceType | null;
  language: string;
  visit_minutes: number | null;
  effort_level: number | null;
  confidence: PlacePlanningProfileConfidence | null;
  rationale_zh_tw: string | null;
  evidence_indexes: unknown;
  sources: unknown;
  model: string | null;
  prompt_version: string | null;
  policy_version: string | null;
  evidence_hash: string | null;
  input_hash: string | null;
  status: "pending" | "generating" | "ready" | "no_evidence" | "failed";
  evidence_checked_at: Date | null;
  generated_at: Date | null;
}

/** Reads only cache rows that match the current identity and the requested model/policy. */
export async function readValidProfiles(
  executor: DatabaseExecutor,
  identityIds: readonly string[],
  options: ReadValidProfilesOptions = {
    model: process.env.OPENAI_MODEL?.trim() || "unconfigured",
  },
): Promise<Map<string, ValidPlacePlanningProfile>> {
  const uniqueIdentityIds = [...new Set(identityIds)].sort();
  if (uniqueIdentityIds.length === 0 || !options.model.trim()) return new Map();
  const language = options.language ?? PLACE_PLANNING_PROFILE_LANGUAGE;
  const promptVersion = options.promptVersion ?? PLACE_PLANNING_PROFILE_PROMPT_VERSION;
  const policyVersion = options.policyVersion ?? PLACE_ESTIMATE_POLICY_VERSION;
  const rows = await executor.selectFrom("place_planning_profiles as profile")
    .innerJoin("place_identities as identity", "identity.id", "profile.place_id")
    .select([
      "profile.place_id",
      "identity.canonical_name as identity_name",
      "identity.canonical_type as identity_type",
      "profile.canonical_name",
      "profile.place_type",
      "profile.language",
      "profile.visit_minutes",
      "profile.effort_level",
      "profile.confidence",
      "profile.rationale_zh_tw",
      "profile.evidence_indexes",
      "profile.sources",
      "profile.model",
      "profile.prompt_version",
      "profile.policy_version",
      "profile.evidence_hash",
      "profile.evidence_checked_at",
      "profile.input_hash",
      "profile.status",
      "profile.generated_at",
    ])
    .where("profile.place_id", "in", uniqueIdentityIds)
    .where("profile.status", "=", "ready")
    .execute() as ProfileRow[];

  const profiles = new Map<string, ValidPlacePlanningProfile>();
  for (const row of rows) {
    if (
      row.canonical_name !== row.identity_name
      || row.place_type !== row.identity_type
      || row.language !== language
      || row.model !== options.model
      || row.prompt_version !== promptVersion
      || row.policy_version !== policyVersion
      || row.evidence_hash === null
      || row.input_hash !== profileInputHash(row.identity_name, row.identity_type, row.evidence_hash)
      || row.confidence === null
      || row.evidence_checked_at === null
      || row.rationale_zh_tw === null
      || row.generated_at === null
    ) continue;
    const evidenceIndexes = parseEvidenceIndexes(row.evidence_indexes);
    const sources = parseSources(row.sources);
    if (!evidenceIndexes || !sources || evidenceIndexes.some((index) => index >= sources.length)) continue;
    profiles.set(row.place_id, {
      identityId: row.place_id,
      visitMinutes: row.visit_minutes,
      effortLevel: row.effort_level,
      confidence: row.confidence,
      rationaleZhTw: row.rationale_zh_tw,
      evidenceIndexes,
      sources,
      generatedAt: row.generated_at,
    });
  }
  return profiles;
}

/** Returns only identities with durable work queued or actively claimed by the worker. */
export async function readPendingProfileIdentityIds(
  executor: DatabaseExecutor,
  identityIds: readonly string[],
  options: ReadValidProfilesOptions = {
    model: process.env.OPENAI_MODEL?.trim() || "unconfigured",
  },
): Promise<Set<string>> {
  const uniqueIdentityIds = [...new Set(identityIds)].sort();
  const generationAvailable = options.generationAvailable
    ?? Boolean(process.env.OPENAI_API_KEY?.trim());
  if (
    uniqueIdentityIds.length === 0
    || !generationAvailable
    || !options.model.trim()
    || options.model === "unconfigured"
  ) return new Set();
  const rows = await executor.selectFrom("place_planning_profiles")
    .select("place_id")
    .where("place_id", "in", uniqueIdentityIds)
    .where("status", "in", ["pending", "generating"])
    .execute();
  return new Set(rows.map((row) => row.place_id));
}

/** Durable producer used by backfill; the selection trigger handles ordinary transitions. */
export async function enqueueSelectedPlacePlanningProfiles(
  executor: DatabaseExecutor,
  model: string,
) {
  if (!model.trim()) return 0;
  const result = await sql<{ place_id: string }>`
    insert into place_planning_profiles (
      place_id,
      requested_trip_id,
      canonical_name,
      place_type,
      language,
      model,
      prompt_version,
      policy_version,
      status,
      next_attempt_at,
      updated_at
    )
    select distinct on (identity.id)
      identity.id,
      trip_place.trip_id,
      identity.canonical_name,
      identity.canonical_type,
      ${PLACE_PLANNING_PROFILE_LANGUAGE},
      ${model},
      ${PLACE_PLANNING_PROFILE_PROMPT_VERSION},
      ${PLACE_ESTIMATE_POLICY_VERSION},
      'pending',
      now(),
      now()
    from trip_places trip_place
    inner join place_identities identity on identity.id = trip_place.place_id
    where trip_place.selected_for_itinerary
      and trip_place.archived_at is null
      and trip_place.place_type not in ('lodging', 'airport')
    order by identity.id, trip_place.trip_id
    on conflict (place_id) do update
    set requested_trip_id = coalesce(place_planning_profiles.requested_trip_id, excluded.requested_trip_id),
        status = 'pending',
        claim_token = null,
        claimed_at = null,
        attempts = 0,
        next_attempt_at = now(),
        updated_at = now()
    where place_planning_profiles.canonical_name is distinct from excluded.canonical_name
       or place_planning_profiles.place_type is distinct from excluded.place_type
       or place_planning_profiles.language is distinct from excluded.language
       or place_planning_profiles.model is distinct from excluded.model
       or place_planning_profiles.prompt_version is distinct from excluded.prompt_version
       or place_planning_profiles.policy_version is distinct from excluded.policy_version
       or (
         place_planning_profiles.status in ('ready', 'no_evidence')
         and (
           place_planning_profiles.evidence_checked_at is null
           or place_planning_profiles.evidence_checked_at
             <= now() - (${PLACE_PLANNING_PROFILE_EVIDENCE_MAX_AGE_MILLISECONDS} * interval '1 millisecond')
         )
       )
    returning place_id
  `.execute(executor);
  return result.rows.length;
}

/** Worker-side durable claim consumer. Calls Wikimedia and OpenAI only after owning a DB claim. */
export class PostgresPlacePlanningProfileWorker {
  private readonly now: () => Date;
  private refreshDueAt = 0;

  constructor(private readonly options: {
    database: Kysely<AlongTheWayDatabase>;
    model: OpenAiPlacePlanningProfileModel;
    sources: PlaceGuideSourceFetcher;
    now?: () => Date;
  }) {
    this.now = options.now ?? (() => new Date());
  }

  /** Claims and processes at most two identities, so provider concurrency is always bounded at 2. */
  async runBatch() {
    if (!this.options.model.available) return 0;
    const now = this.now();
    if (now.valueOf() >= this.refreshDueAt) {
      await enqueueSelectedPlacePlanningProfiles(this.options.database, this.options.model.modelId);
      this.refreshDueAt = now.valueOf() + QUEUE_REFRESH_MILLISECONDS;
    }
    const claims = await Promise.all([this.claimNext(), this.claimNext()]);
    const claimed = claims.filter((claim): claim is ClaimedProfile => claim !== null);
    await Promise.all(claimed.map((claim) => this.process(claim)));
    return claimed.length;
  }

  private claimNext() {
    const now = this.now();
    const staleBefore = new Date(now.valueOf() - CLAIM_STALE_MILLISECONDS);
    return this.options.database.transaction().execute(async (transaction) => {
      const candidate = await transaction.selectFrom("place_planning_profiles as profile")
        .innerJoin("place_identities as identity", "identity.id", "profile.place_id")
        .innerJoin("trip_places as tripPlace", (join) => join
          .onRef("tripPlace.place_id", "=", "profile.place_id")
          .on("tripPlace.selected_for_itinerary", "=", true)
          .on("tripPlace.archived_at", "is", null))
        .select([
          "profile.place_id as identityId",
          "tripPlace.trip_id as tripId",
          "identity.canonical_name as canonicalName",
          "identity.canonical_type as placeType",
          "profile.status as previousStatus",
          "profile.canonical_name as previousCanonicalName",
          "profile.place_type as previousPlaceType",
          "profile.model as previousModel",
          "profile.prompt_version as previousPromptVersion",
          "profile.policy_version as previousPolicyVersion",
          "profile.language as previousLanguage",
          "profile.evidence_hash as previousEvidenceHash",
          "profile.input_hash as previousInputHash",
        ])
        .where("tripPlace.place_type", "not in", ["lodging", "airport"])
        .where((expression) => expression.or([
          expression.and([
            expression("profile.status", "in", ["pending", "failed"]),
            expression("profile.next_attempt_at", "<=", now),
          ]),
          expression.and([
            expression("profile.status", "=", "generating"),
            expression("profile.claimed_at", "<=", staleBefore),
          ]),
        ]))
        .orderBy("profile.next_attempt_at")
        .orderBy("profile.updated_at")
        .orderBy("profile.place_id")
        .orderBy("tripPlace.trip_id")
        .forUpdate("profile")
        .skipLocked()
        .executeTakeFirst();
      if (!candidate) return null;
      const token = randomUUID();
      const claimed = await transaction.updateTable("place_planning_profiles").set({
        requested_trip_id: candidate.tripId,
        canonical_name: candidate.canonicalName,
        place_type: candidate.placeType,
        language: PLACE_PLANNING_PROFILE_LANGUAGE,
        model: this.options.model.modelId,
        prompt_version: PLACE_PLANNING_PROFILE_PROMPT_VERSION,
        policy_version: PLACE_ESTIMATE_POLICY_VERSION,
        status: "generating",
        claim_token: token,
        claimed_at: now,
        updated_at: now,
      }).where("place_id", "=", candidate.identityId)
        .returning("place_id")
        .executeTakeFirst();
      if (!claimed) return null;
      // A pending row whose stored outcome still carries a complete ready/no_evidence result is an
      // evidence refresh: if the re-fetched extracts hash the same, the old outcome is restored
      // without a model call (see process()).
      const previousOutcome = candidate.previousStatus === "pending"
        && candidate.previousEvidenceHash !== null
        && candidate.previousInputHash !== null
        && candidate.previousCanonicalName === candidate.canonicalName
        && candidate.previousPlaceType === candidate.placeType
        ? await this.previousOutcome(transaction, candidate.identityId)
        : null;
      return {
        identityId: candidate.identityId,
        tripId: candidate.tripId,
        canonicalName: candidate.canonicalName,
        placeType: candidate.placeType,
        previousOutcome,
        previousModel: candidate.previousModel,
        previousPromptVersion: candidate.previousPromptVersion,
        previousPolicyVersion: candidate.previousPolicyVersion,
        previousLanguage: candidate.previousLanguage,
        previousEvidenceHash: candidate.previousEvidenceHash,
        previousInputHash: candidate.previousInputHash,
        token,
      } satisfies ClaimedProfile;
    });
  }

  private async process(claim: ClaimedProfile) {
    let sources: PlaceGuideEvidenceSource[] = [];
    try {
      const wikidataId = await this.wikidataId(claim.identityId);
      sources = await this.options.sources.fetchForPlace(claim.canonicalName, wikidataId);
      const evidenceHash = hashJson(sources.map((source) => ({
        title: source.title,
        url: source.url,
        text: source.text,
      })));
      const inputHash = profileInputHash(claim.canonicalName, claim.placeType, evidenceHash);
      if (
        claim.previousOutcome !== null
        && claim.previousEvidenceHash === evidenceHash
        && claim.previousInputHash === inputHash
        && claim.previousModel === this.options.model.modelId
        && claim.previousPromptVersion === PLACE_PLANNING_PROFILE_PROMPT_VERSION
        && claim.previousPolicyVersion === PLACE_ESTIMATE_POLICY_VERSION
        && claim.previousLanguage === PLACE_PLANNING_PROFILE_LANGUAGE
      ) {
        await this.restorePreviousOutcome(claim, claim.previousOutcome);
        return;
      }
      if (sources.length === 0) {
        await this.storeNoEvidence(claim, evidenceHash, inputHash);
        return;
      }
      if (!await this.reserveDailyTripGeneration(claim)) return;
      const generated = await this.options.model.generate(claim.canonicalName, claim.placeType, sources);
      if (generated.visitMinutes === null && generated.effortLevel === null) {
        // Both estimates null means the extracts did not support any value: same as no evidence.
        await this.storeNoEvidence(claim, evidenceHash, inputHash);
        return;
      }
      const sourceDtos = sources.map(({ title, url }) => ({ title, url }));
      await this.options.database.updateTable("place_planning_profiles").set({
        visit_minutes: generated.visitMinutes,
        effort_level: generated.effortLevel,
        confidence: generated.confidence,
        rationale_zh_tw: generated.rationaleZhTw,
        evidence_indexes: JSON.stringify(generated.evidenceIndexes),
        sources: JSON.stringify(sourceDtos),
        model: generated.model,
        prompt_version: PLACE_PLANNING_PROFILE_PROMPT_VERSION,
        policy_version: PLACE_ESTIMATE_POLICY_VERSION,
        evidence_hash: evidenceHash,
        input_hash: inputHash,
        status: "ready",
        claim_token: null,
        claimed_at: null,
        attempts: 0,
        next_attempt_at: this.now(),
        generated_at: this.now(),
        evidence_checked_at: this.now(),
        updated_at: this.now(),
      }).where("place_id", "=", claim.identityId)
        .where("status", "=", "generating")
        .where("claim_token", "=", claim.token)
        .execute();
    } catch (error) {
      await this.recordFailure(claim);
      console.error(JSON.stringify({
        event: "place_planning_profile_generation_failed",
        placeIdentityId: claim.identityId,
        errorClass: error instanceof Error ? error.constructor.name : "NonErrorThrow",
        // Our own validation messages and provider/DB errors; never contains source text or keys.
        errorMessage: error instanceof Error ? error.message.slice(0, 300) : null,
      }));
    }
  }

  private async storeNoEvidence(claim: ClaimedProfile, evidenceHash: string, inputHash: string) {
    const now = this.now();
    await this.options.database.updateTable("place_planning_profiles").set({
      visit_minutes: null,
      effort_level: null,
      confidence: null,
      rationale_zh_tw: null,
      evidence_indexes: JSON.stringify([]),
      sources: JSON.stringify([]),
      model: this.options.model.modelId,
      prompt_version: PLACE_PLANNING_PROFILE_PROMPT_VERSION,
      policy_version: PLACE_ESTIMATE_POLICY_VERSION,
      evidence_hash: evidenceHash,
      input_hash: inputHash,
      status: "no_evidence",
      claim_token: null,
      claimed_at: null,
      attempts: 0,
      next_attempt_at: now,
      generated_at: now,
      evidence_checked_at: now,
      updated_at: now,
    }).where("place_id", "=", claim.identityId)
      .where("status", "=", "generating")
      .where("claim_token", "=", claim.token)
      .execute();
  }

  /** Evidence unchanged since the stored outcome: put the row back without a model call. */
  private async restorePreviousOutcome(claim: ClaimedProfile, outcome: "ready" | "no_evidence") {
    const now = this.now();
    await this.options.database.updateTable("place_planning_profiles").set({
      status: outcome,
      claim_token: null,
      claimed_at: null,
      attempts: 0,
      next_attempt_at: now,
      evidence_checked_at: now,
      updated_at: now,
    }).where("place_id", "=", claim.identityId)
      .where("status", "=", "generating")
      .where("claim_token", "=", claim.token)
      .execute();
  }

  /** A stored outcome is restorable only if the row's data still satisfies that outcome's check constraint. */
  private async previousOutcome(executor: DatabaseExecutor, identityId: string): Promise<"ready" | "no_evidence" | null> {
    const row = await executor.selectFrom("place_planning_profiles")
      .select(["visit_minutes", "effort_level", "confidence", "rationale_zh_tw", "sources", "generated_at"])
      .where("place_id", "=", identityId)
      .executeTakeFirst();
    if (!row || row.generated_at === null) return null;
    const sources = parseSources(row.sources);
    if (!sources) return null;
    if (sources.length === 0 && row.confidence === null && row.visit_minutes === null && row.effort_level === null) {
      return "no_evidence";
    }
    if (sources.length > 0 && row.confidence !== null && row.rationale_zh_tw !== null) return "ready";
    return null;
  }

  private reserveDailyTripGeneration(claim: ClaimedProfile) {
    const now = this.now();
    const windowStart = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    ));
    const nextWindow = new Date(windowStart.valueOf() + 24 * 60 * 60 * 1_000);
    return this.options.database.transaction().execute(async (transaction) => {
      const stillClaimed = await transaction.selectFrom("place_planning_profiles")
        .select("place_id")
        .where("place_id", "=", claim.identityId)
        .where("status", "=", "generating")
        .where("claim_token", "=", claim.token)
        .forUpdate()
        .executeTakeFirst();
      if (!stillClaimed) return false;
      const reserved = await transaction.insertInto("rate_limit_windows").values({
        scope: DAILY_RATE_SCOPE,
        key_hash: hashText(claim.tripId.toLowerCase()),
        window_start: windowStart,
        request_count: 1,
      }).onConflict((conflict) => conflict
        .columns(["scope", "key_hash", "window_start"])
        .doUpdateSet((expression) => ({
          request_count: expression("rate_limit_windows.request_count", "+", 1),
        }))
        .where("rate_limit_windows.request_count", "<", PLACE_PLANNING_PROFILE_DAILY_TRIP_LIMIT))
        .returning("request_count")
        .executeTakeFirst();
      if (reserved) return true;
      await transaction.updateTable("place_planning_profiles").set({
        status: "pending",
        claim_token: null,
        claimed_at: null,
        next_attempt_at: nextWindow,
        updated_at: now,
      }).where("place_id", "=", claim.identityId)
        .where("status", "=", "generating")
        .where("claim_token", "=", claim.token)
        .execute();
      return false;
    });
  }

  private async recordFailure(claim: ClaimedProfile) {
    const current = await this.options.database.selectFrom("place_planning_profiles")
      .select("attempts")
      .where("place_id", "=", claim.identityId)
      .where("status", "=", "generating")
      .where("claim_token", "=", claim.token)
      .executeTakeFirst();
    if (!current) return;
    const attempts = current.attempts + 1;
    const retryIndex = Math.min(attempts, FAILED_RETRY_MILLISECONDS.length) - 1;
    const now = this.now();
    await this.options.database.updateTable("place_planning_profiles").set({
      visit_minutes: null,
      effort_level: null,
      confidence: null,
      rationale_zh_tw: null,
      evidence_indexes: JSON.stringify([]),
      sources: JSON.stringify([]),
      status: "failed",
      claim_token: null,
      claimed_at: null,
      attempts,
      next_attempt_at: new Date(now.valueOf() + FAILED_RETRY_MILLISECONDS[retryIndex]!),
      generated_at: now,
      updated_at: now,
    }).where("place_id", "=", claim.identityId)
      .where("status", "=", "generating")
      .where("claim_token", "=", claim.token)
      .execute();
  }

  private async wikidataId(identityId: string) {
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
      .where("identity.id", "=", identityId)
      .executeTakeFirst();
    return row?.wikidata_id ?? null;
  }
}

function profileInputHash(canonicalName: string, placeType: PlaceType, evidenceHash: string) {
  return hashJson({ canonicalName, placeType, evidenceHash });
}

function hashJson(value: unknown) {
  return hashText(JSON.stringify(value));
}

function hashText(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function parseEvidenceIndexes(value: unknown) {
  if (!Array.isArray(value) || value.some((item) => !Number.isSafeInteger(item) || Number(item) < 0)) {
    return null;
  }
  const indexes = value.map(Number);
  if (new Set(indexes).size !== indexes.length) return null;
  return indexes;
}

function parseSources(value: unknown) {
  if (!Array.isArray(value)) return null;
  const sources: Array<{ title: string; url: string }> = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const source = item as Record<string, unknown>;
    if (Object.keys(source).length !== 2 || typeof source.title !== "string" || typeof source.url !== "string") {
      return null;
    }
    sources.push({ title: source.title, url: source.url });
  }
  return sources;
}
