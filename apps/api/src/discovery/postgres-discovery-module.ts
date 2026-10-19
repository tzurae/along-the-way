import type {
  CandidateProposalDto,
  DecideCandidateProposalInput,
  DiscoveryDecisionDto,
  DiscoveryEndorsement,
  DiscoveryShortfallDto,
  DiscoveryWorkspaceDto,
  GenerateDiscoveryInput,
  SaveDiscoveryBriefInput,
  SaveDiscoveryQuestionAnswersInput,
  ScheduleDiscoveryProposalsInput,
  UpdateCandidateProposalVoteInput,
} from "@along-the-way/contracts/discovery";
import { parseDiscoveryWorkspaceResponse, parseUpdateCandidateProposalVoteResponse } from "@along-the-way/contracts/discovery";
import type { ProviderPlaceCandidateDto } from "@along-the-way/contracts/trip-places";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";

import type { AlongTheWayDatabase, CandidateProposalTable } from "../database/database";
import { AppError } from "../private-trips/private-trip-module";
import {
  dateOnly,
  isoTimestamp,
  lockMutation,
  recordEvent,
  remember,
  replayed,
  requireIdempotencyKey,
  requireOwner as requireTripOwner,
  requireScheduler,
  type DatabaseExecutor,
} from "../private-trips/postgres-private-trip-store";
import {
  defaultRecommendationSourceChecks,
  verifyResearchedCandidates,
  type RecommendationSourceChecks,
} from "./candidate-verification";
import {
  DiscoveryModelResponseError,
  DiscoveryModelUnavailableError,
  type DiscoveryClaimSentence,
  type DiscoveryModel,
  type DiscoverySearchPlan,
  type DiscoveryTripFacts,
  type StructuredDiscoveryBrief,
} from "./discovery-model";
import type { DiscoveryModule } from "./discovery-module";
import {
  ProviderQuotaError,
  ProviderUnavailableError,
  type RatedPlaceLookup,
} from "../trip-places/google-places-provider";
import { PostgresTripPlaceModule } from "../trip-places/postgres-trip-place-module";
import { upsertGooglePlaceIdentity } from "../trip-places/google-place-identity";
import type { CommonsCandidateGenerator } from "../place-details/commons-photo-candidates";

interface PostgresDiscoveryModuleOptions {
  database: Kysely<AlongTheWayDatabase>;
  model: DiscoveryModel;
  /** Google lookups with rating and review count, used to place and screen researched candidates. */
  placeLookup: RatedPlaceLookup;
  tripPlaces: PostgresTripPlaceModule;
  /** Permanently charges one hourly AI start immediately before the model is called. */
  claimAiRun: (userId: string, tripId: string) => Promise<void>;
  sourceChecks?: RecommendationSourceChecks;
  /** Finds a Commons photo for each suggestion's place identity, so list thumbnails need no Google call. */
  commonsCandidates?: CommonsCandidateGenerator;
  now?: () => Date;
  policyVersion?: string;
}

const ENDORSEMENTS: readonly DiscoveryEndorsement[] = ["google_reviews", "wikivoyage", "official_tourism"];
const SHORTFALL_CODES: readonly DiscoveryShortfallDto["code"][] = [
  "not_researched", "not_found", "name_mismatch", "single_source", "category_short", "in_wishlist", "rejected",
  "permanently_closed", "temporarily_closed", "outside_trip", "no_location",
];

/** Research runs one trip may start per hour; each run also incurs Google calls. */
const RESEARCH_PER_TRIP_PER_HOUR = 6;
/** Research runs one member may start across all trips per hour. */
const RESEARCH_PER_ACCOUNT_PER_HOUR = 10;
const GENERATE_OPERATION_PREFIX = "discovery:generate:";
const AI_LIMIT_LOCK_PREFIX = "discovery:ai-limit:";
const WEB_EVIDENCE_FRESHNESS_MS = 30 * 24 * 60 * 60 * 1_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POSTGRES_INTEGER_MAX = 2_147_483_647;
const EMPTY_PLAN: DiscoverySearchPlan = {
  queries: [],
  areas: [],
  categories: [],
  defaultCategories: false,
  namedPlaces: [],
  alreadyArranged: [],
  exclusions: [],
  dateRange: { start: "", end: "" },
};

function requiredText(value: unknown, field: string, maximum: number) {
  if (typeof value !== "string") throw new AppError("validation_error", `${field} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new AppError("validation_error", `${field} is required and must be at most ${maximum} characters`);
  }
  return normalized;
}

function expectedVersion(value: unknown) {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 1
    || value > POSTGRES_INTEGER_MAX
  ) {
    throw new AppError("validation_error", `expectedVersion must be an integer between 1 and ${POSTGRES_INTEGER_MAX}`);
  }
  return value;
}

function uuid(value: string, field: string) {
  if (!UUID.test(value)) throw new AppError("validation_error", `${field} must be a UUID`);
  return value;
}

function jsonObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function jsonStrings(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function jsonClaimSentences(value: unknown): CandidateProposalDto["recommendationSentences"] {
  if (value === null) return null;
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const sentence = jsonObject(raw);
    return typeof sentence.text === "string"
      ? [{ text: sentence.text, evidenceIds: jsonStrings(sentence.evidenceIds) }]
      : [];
  });
}

function storedQuestionAnswers(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const item = jsonObject(raw);
    if (typeof item.question !== "string" || (item.answer !== null && typeof item.answer !== "string")) return [];
    return [{ question: item.question, answer: item.answer }];
  });
}

/**
 * Older idempotent workspace snapshots lack later additive fields. A retry uses the
 * documented empty or unknown value instead of rejecting a response already returned.
 */
function upgradeStoredWorkspace(value: unknown) {
  const workspace = jsonObject(value);
  const brief = workspace.brief === null ? null : jsonObject(workspace.brief);
  const run = workspace.latestRun === null ? null : jsonObject(workspace.latestRun);
  return {
    ...workspace,
    brief: brief && {
      ...brief,
      questionAnswers: Array.isArray(brief.questionAnswers) ? brief.questionAnswers : [],
    },
    latestRun: run && {
      ...run,
      shortfalls: Array.isArray(run.shortfalls) ? run.shortfalls : [],
      searchPlan: { defaultCategories: false, namedPlaces: [], alreadyArranged: [], ...jsonObject(run.searchPlan) },
    },
    proposals: Array.isArray(workspace.proposals)
      ? workspace.proposals.map((proposal) => {
        const item = jsonObject(proposal);
        return {
          category: null,
          endorsements: [],
          recommendationSentences: null,
          tradeoffSentences: null,
          voters: [],
          voteCount: 0,
          ownVote: false,
          votingAvailable: false,
          ...item,
          evidence: Array.isArray(item.evidence)
            ? item.evidence.map((entry) => ({ isStale: false, ...jsonObject(entry) }))
            : item.evidence,
        };
      })
      : workspace.proposals,
    // Decisions stored before restore existed have no version: 0 never matches a row, so restoring
    // from such a replay is refused as stale and the member reloads.
    decided: Array.isArray(workspace.decided)
      ? workspace.decided.map((entry) => ({ version: 0, ...jsonObject(entry) }))
      : [],
  };
}

function replayedWorkspace(value: unknown) {
  return parseDiscoveryWorkspaceResponse({ discovery: upgradeStoredWorkspace(value) }).discovery;
}

const DISCOVERY_WORKSPACE_READBACK = "discovery_workspace_readback";

function isDiscoveryWorkspaceReadback(value: unknown) {
  return jsonObject(value).type === DISCOVERY_WORKSPACE_READBACK;
}

/**
 * Votes recorded before 0.8.0 stored the whole workspace as their response; newer ones store the
 * proposal. A retried old vote must still replay, so pick its proposal out of the stored workspace.
 */
function replayedProposal(value: unknown, proposalId: string) {
  if (typeof value === "object" && value !== null && "proposals" in value && Array.isArray(value.proposals)) {
    const proposal = replayedWorkspace(value).proposals.find((candidate) => candidate.id === proposalId);
    if (!proposal) throw new AppError("discovery_proposal_not_found", "Candidate proposal not found", 404);
    return proposal;
  }
  return parseUpdateCandidateProposalVoteResponse({ proposal: value }).proposal;
}

const AI_REQUEST_STATE = "discovery-ai-request-state";

function aiRequestReplay(value: unknown) {
  const item = jsonObject(value);
  if (item.type !== AI_REQUEST_STATE) return replayedWorkspace(value);
  if (item.state === "in-progress") {
    throw new AppError("conflict", "This discovery request is already in progress", 409);
  }
  const message = typeof item.message === "string"
    ? item.message
    : "The discovery request failed and was not charged again";
  if (item.code === "provider_unavailable") {
    throw new AppError("provider_unavailable", message, 503);
  }
  if (item.code === "conflict") {
    throw new AppError("conflict", message, 409);
  }
  throw new AppError("model_unavailable", message, 503);
}

function isAiRequestClaim(value: unknown) {
  return jsonObject(value).type === AI_REQUEST_STATE;
}

export class PostgresDiscoveryModule implements DiscoveryModule {
  private readonly database: Kysely<AlongTheWayDatabase>;
  private readonly model: DiscoveryModel;
  private readonly placeLookup: RatedPlaceLookup;
  private readonly tripPlaces: PostgresTripPlaceModule;
  private readonly claimAiRun: (userId: string, tripId: string) => Promise<void>;
  private readonly sourceChecks: RecommendationSourceChecks;
  private readonly commonsCandidates: CommonsCandidateGenerator | undefined;
  private readonly now: () => Date;
  private readonly policyVersion: string;

  constructor(options: PostgresDiscoveryModuleOptions) {
    this.database = options.database;
    this.model = options.model;
    this.placeLookup = options.placeLookup;
    this.tripPlaces = options.tripPlaces;
    this.claimAiRun = options.claimAiRun;
    this.sourceChecks = options.sourceChecks ?? defaultRecommendationSourceChecks;
    this.commonsCandidates = options.commonsCandidates;
    this.now = options.now ?? (() => new Date());
    // v2: research first, Google only places candidates, two independent sources required.
    this.policyVersion = options.policyVersion ?? "discovery-v2";
  }

  async getWorkspace(userId: string, tripId: string) {
    uuid(tripId, "tripId");
    await this.requireMember(this.database, userId, tripId);
    return this.readWorkspace(this.database, tripId, userId);
  }

  /** Background and serial (Wikimedia is polite-use only); a failure only leaves the type icon. */
  private findSuggestionPhotos(placeIdentityIds: readonly string[]) {
    const generator = this.commonsCandidates;
    if (!generator || placeIdentityIds.length === 0) return;
    void (async () => {
      for (const placeIdentityId of placeIdentityIds) {
        try {
          await generator.generate(placeIdentityId);
        } catch (error) {
          console.error(JSON.stringify({
            event: "commons_candidate_generation_failed",
            placeIdentityId,
            errorClass: error instanceof Error ? error.constructor.name : "NonErrorThrow",
          }));
        }
      }
    })();
  }

  async saveBrief(
    userId: string,
    tripId: string,
    rawKey: string,
    input: SaveDiscoveryBriefInput,
  ) {
    uuid(tripId, "tripId");
    const key = requireIdempotencyKey(rawKey);
    const originalText = requiredText(input.originalText, "originalText", 5_000);
    const operation = `discovery:brief:${tripId}`;
    return this.database.transaction().execute(async (transaction) => {
      await this.requireMember(transaction, userId, tripId);
      await lockMutation(transaction, userId, operation, key);
      const replay = await replayed(transaction, userId, operation, key);
      if (replay) {
        return isDiscoveryWorkspaceReadback(replay)
          ? this.readWorkspace(transaction, tripId, userId)
          : replayedWorkspace(replay);
      }
      // A missing row cannot be FOR UPDATE locked: serialize creation by this
      // aggregate's identity before checking whether its initial version exists.
      await sql`select pg_advisory_xact_lock(hashtextextended(${operation}, 0))`.execute(transaction);
      const version = input.expectedVersion == null ? null : expectedVersion(input.expectedVersion);
      const current = await transaction.selectFrom("discovery_briefs")
        .select(["version", "original_text"])
        .where("trip_id", "=", tripId)
        .forUpdate()
        .executeTakeFirst();
      if (current) {
        if (current.version !== version) {
          throw new AppError("conflict", "The discovery brief changed; reload before saving", 409, undefined, current.version);
        }
        await transaction.updateTable("discovery_briefs").set({
          original_text: originalText,
          structured_brief: null,
          unresolved_questions: JSON.stringify([]),
          question_answers: JSON.stringify([]),
          version: sql`version + 1`,
          updated_by: userId,
          updated_at: this.now(),
        }).where("trip_id", "=", tripId).execute();
      } else {
        if (version !== null) {
          throw new AppError("conflict", "The discovery brief does not exist", 409);
        }
        await transaction.insertInto("discovery_briefs").values({
          trip_id: tripId,
          original_text: originalText,
          structured_brief: null,
          unresolved_questions: JSON.stringify([]),
          updated_by: userId,
        }).execute();
      }
      await recordEvent(transaction, {
        tripId,
        actorId: userId,
        eventType: current ? "discovery.brief_updated" : "discovery.brief_created",
        targetType: "discovery_brief",
        targetId: tripId,
        summary: "Saved the trip discovery brief",
      });
      const response = await this.readWorkspace(transaction, tripId, userId);
      await remember(transaction, userId, operation, key, { type: DISCOVERY_WORKSPACE_READBACK });
      return response;
    });
  }
  async saveQuestionAnswers(
    userId: string,
    tripId: string,
    rawKey: string,
    input: SaveDiscoveryQuestionAnswersInput,
  ) {
    uuid(tripId, "tripId");
    const key = requireIdempotencyKey(rawKey);
    const version = expectedVersion(input.expectedVersion);
    if (!Array.isArray(input.answers) || input.answers.length > 20) {
      throw new AppError("validation_error", "answers must contain at most 20 question answers");
    }
    const operation = `discovery:brief-questions:${tripId}`;
    return this.database.transaction().execute(async (transaction) => {
      await this.requireMember(transaction, userId, tripId);
      await lockMutation(transaction, userId, operation, key);
      const replay = await replayed(transaction, userId, operation, key);
      if (replay) {
        return isDiscoveryWorkspaceReadback(replay)
          ? this.readWorkspace(transaction, tripId, userId)
          : replayedWorkspace(replay);
      }
      const brief = await transaction.selectFrom("discovery_briefs")
        .select(["version", "unresolved_questions", "question_answers"])
        .where("trip_id", "=", tripId)
        .forUpdate()
        .executeTakeFirst();
      if (!brief) throw new AppError("validation_error", "Save a discovery brief first");
      if (brief.version !== version) {
        throw new AppError("conflict", "The discovery brief changed; reload before saving answers", 409, undefined, brief.version);
      }
      const previous = storedQuestionAnswers(brief.question_answers);
      const orderedQuestions = [...previous.map((entry) => entry.question)];
      for (const question of jsonStrings(brief.unresolved_questions)) {
        if (!orderedQuestions.includes(question)) orderedQuestions.push(question);
      }
      const submitted = new Map<string, string | null>();
      for (const answer of input.answers) {
        if (!answer || typeof answer.question !== "string" || !orderedQuestions.includes(answer.question)) {
          throw new AppError("validation_error", "Each answer must match a question for the current brief");
        }
        if (submitted.has(answer.question)) {
          throw new AppError("validation_error", "Each question may be answered once");
        }
        submitted.set(
          answer.question,
          answer.answer === null ? null : requiredText(answer.answer, "answer", 1_000),
        );
      }
      const answers = orderedQuestions.flatMap((question) => {
        if (!submitted.has(question)) return [];
        return [{ question, answer: submitted.get(question) ?? null }];
      });
      await transaction.updateTable("discovery_briefs").set({
        question_answers: JSON.stringify(answers),
        version: sql`version + 1`,
        updated_by: userId,
        updated_at: this.now(),
      }).where("trip_id", "=", tripId).execute();
      await recordEvent(transaction, {
        tripId,
        actorId: userId,
        eventType: "discovery.questions_answered",
        targetType: "discovery_brief",
        targetId: tripId,
        summary: "Saved answers to AI discovery questions",
      });
      const response = await this.readWorkspace(transaction, tripId, userId);
      await remember(transaction, userId, operation, key, { type: DISCOVERY_WORKSPACE_READBACK });
      return response;
    });
  }


  async generate(
    userId: string,
    tripId: string,
    rawKey: string,
    input: GenerateDiscoveryInput,
  ) {
    uuid(tripId, "tripId");
    const key = requireIdempotencyKey(rawKey);
    const version = expectedVersion(input.expectedBriefVersion);
    // Lowercase: the path accepts the UUID in any case, and the research lock and limits are
    // keyed on this string, so another spelling must not count as another trip.
    const operation = `${GENERATE_OPERATION_PREFIX}${tripId.toLowerCase()}`;
    await this.requireMember(this.database, userId, tripId);
    const earlyReplay = await replayed(this.database, userId, operation, key);
    if (earlyReplay) {
      return isDiscoveryWorkspaceReadback(earlyReplay)
        ? this.readWorkspace(this.database, tripId, userId)
        : aiRequestReplay(earlyReplay);
    }
    const brief = await this.database.selectFrom("discovery_briefs")
      .select(["original_text", "version", "question_answers"])
      .where("trip_id", "=", tripId)
      .executeTakeFirst();
    if (!brief) throw new AppError("validation_error", "Save a discovery brief first");
    if (brief.version !== version) {
      throw new AppError("conflict", "The discovery brief changed; reload before generating", 409, undefined, brief.version);
    }
    const questionAnswers = storedQuestionAnswers(brief.question_answers);
    const trip = await this.tripFacts(userId, tripId);
    const rejected = await this.database.selectFrom("candidate_proposals")
      .select(["provider_place_id", "name"])
      .where("trip_id", "=", tripId)
      .where("status", "=", "rejected")
      .execute();
    const claimedReplay = await this.database.transaction().execute(async (transaction) => {
      await lockMutation(transaction, userId, operation, key);
      const existing = await replayed(transaction, userId, operation, key);
      if (existing) return existing;
      await this.claimAiSlot(transaction, userId, tripId);
      await remember(transaction, userId, operation, key, {
        type: AI_REQUEST_STATE,
        state: "in-progress",
      });
      return null;
    });
    if (claimedReplay) {
      return isDiscoveryWorkspaceReadback(claimedReplay)
        ? this.readWorkspace(this.database, tripId, userId)
        : aiRequestReplay(claimedReplay);
    }
    try {
      await this.claimAiRun(userId, tripId);
    } catch (error) {
      // The model was not called. Release only the idempotency claim; successful earlier model
      // starts remain in the independent hourly accounting windows.
      await this.database.deleteFrom("mutation_requests")
        .where("actor_id", "=", userId)
        .where("operation", "=", operation)
        .where("idempotency_key", "=", key)
        .execute();
      throw error;
    }
    try {
      const plan = await this.model.plan({
        brief: brief.original_text,
        trip,
        questionAnswers,
      });
      if (this.placeLookup.available === false) {
        throw new AppError("provider_unavailable", "Google Places is unavailable; the existing shortlist is unchanged", 503);
      }
      const research = await this.model.research({
        brief: plan.structuredBrief,
        request: plan.request,
        trip,
        questionAnswers,
        rejectedPlaces: [...new Set(rejected.map((row) => row.name))],
        outputLanguage: plan.outputLanguage,
      });
      // Read after research, which takes minutes, so a place accepted meanwhile is not proposed again.
      const wishlist = await this.database.selectFrom("trip_places as tripPlace")
        .innerJoin("place_identities as identity", "identity.id", "tripPlace.place_id")
        .innerJoin("places as legacy", (join) => join.onRef("legacy.id", "=", "tripPlace.legacy_place_id")
          .onRef("legacy.trip_id", "=", "tripPlace.trip_id"))
        .select("identity.provider_place_id")
        .where("tripPlace.trip_id", "=", tripId)
        .where((expression) => expression.or([
          expression("tripPlace.archived_at", "is", null),
          expression("legacy.travel_only", "=", true),
        ]))
        .where("identity.provider_place_id", "is not", null)
        .execute();
      const verification = await verifyResearchedCandidates({
        candidates: research.candidates,
        request: plan.request,
        outputLanguage: plan.outputLanguage,
        placeLookup: this.placeLookup,
        sourceChecks: this.sourceChecks,
        rejectedProviderPlaceIds: new Set(rejected.map((row) => row.provider_place_id)),
        wishlistProviderPlaceIds: new Set(wishlist.flatMap((row) => row.provider_place_id ?? [])),
        tripCountryCodes: new Set(trip.countries.map((country) => country.code)),
      }).catch((error: unknown) => {
        if (error instanceof ProviderQuotaError) throw error;
        if (error instanceof ProviderUnavailableError) {
          throw new AppError("provider_unavailable", "Google Places is unavailable; the existing shortlist is unchanged", 503);
        }
        throw error;
      });
      const searchPlan: DiscoverySearchPlan = {
        queries: verification.queries,
        areas: plan.request.areas,
        categories: plan.request.categories,
        defaultCategories: plan.request.defaultCategories,
        namedPlaces: plan.request.namedPlaces.map((place) => place.name),
        alreadyArranged: plan.request.alreadyArranged,
        exclusions: plan.request.exclusions,
        dateRange: { start: trip.startDate, end: trip.endDate },
      };
      const sourceTitles = new Map(research.sources.map((source) => [source.url, source.title]));
      // Identities created for this run's suggestions; their Commons photos are found after commit.
      const suggestionIdentityIds: string[] = [];
      const workspace = await this.database.transaction().execute(async (transaction) => {
        await this.requireMember(transaction, userId, tripId);
        await lockMutation(transaction, userId, operation, key);
        const replay = await replayed(transaction, userId, operation, key);
        if (replay && !isAiRequestClaim(replay)) {
          return isDiscoveryWorkspaceReadback(replay)
            ? this.readWorkspace(transaction, tripId, userId)
            : replayedWorkspace(replay);
        }
        // Serialize against removal/voting before touching old proposals, without blocking brief writers' event FKs.
        await transaction.selectFrom("trips").select("id").where("id", "=", tripId)
          .forKeyShare().executeTakeFirstOrThrow();
        await this.requireMember(transaction, userId, tripId);
        const lockedBrief = await transaction.selectFrom("discovery_briefs")
          .select("version")
          .where("trip_id", "=", tripId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (lockedBrief.version !== version) {
          throw new AppError("conflict", "The discovery brief changed while candidates were generated", 409, undefined, lockedBrief.version);
        }
        await transaction.updateTable("discovery_briefs").set({
          structured_brief: plan.structuredBrief,
          unresolved_questions: JSON.stringify(plan.unresolvedQuestions.filter((question) =>
            !questionAnswers.some((answer) => answer.question === question))),
          updated_at: this.now(),
        }).where("trip_id", "=", tripId).execute();
        const run = await transaction.insertInto("discovery_runs").values({
          trip_id: tripId,
          brief_version: version,
          policy_version: this.policyVersion,
          model_id: research.modelId || plan.modelId,
          status: "completed",
          search_plan: searchPlan,
          error_code: null,
          created_by: userId,
          completed_at: this.now(),
          shortfalls: JSON.stringify(verification.gate.shortfalls),
        }).returning("id").executeTakeFirstOrThrow();
        // One web-source row per page per run, shared by every place it vouches for.
        const webEvidence = new Map<string, string>();
        const webSource = async (url: string, title: string, attribution: string) => {
          const existing = webEvidence.get(url);
          if (existing) return existing;
          const observedAt = this.now();
          const row = await transaction.insertInto("discovery_evidence").values({
            trip_id: tripId,
            run_id: run.id,
            evidence_kind: "web-source",
            provider_place_id: null,
            source_url: url,
            title,
            attribution,
            observed_at: observedAt,
            expires_at: new Date(observedAt.getTime() + WEB_EVIDENCE_FRESHNESS_MS),
            facts: { sourceOnly: true },
          }).returning("id").executeTakeFirstOrThrow();
          webEvidence.set(url, row.id);
          return row.id;
        };
        const storeClaimSentences = async (
          sentences: DiscoveryClaimSentence[],
          proposalEvidenceIds: string[],
        ) => {
          const stored: NonNullable<CandidateProposalDto["recommendationSentences"]> = [];
          for (const sentence of sentences) {
            const citedEvidenceIds: string[] = [];
            for (const url of sentence.sourceUrls) {
              const title = sourceTitles.get(url);
              if (!title) continue;
              const evidenceId = await webSource(url, title, new URL(url).hostname);
              if (!citedEvidenceIds.includes(evidenceId)) citedEvidenceIds.push(evidenceId);
              proposalEvidenceIds.push(evidenceId);
            }
            stored.push({ text: sentence.text, evidenceIds: citedEvidenceIds });
          }
          return stored;
        };
        for (const { index, members, endorsements } of verification.gate.shown) {
          const { researched, place } = verification.candidates[index]!;
          // Entries merged into this place may have found the pages that vouch for it.
          const merged = members.map((member) => verification.candidates[member]!);
          if (!place) continue;
          const googleUrl = place.sourceUrl ?? `https://www.google.com/maps/search/?api=1&query_place_id=${encodeURIComponent(place.providerPlaceId)}`;
          // Only the place identity is kept; Google's rating and review count never are.
          const googleEvidence = await transaction.insertInto("discovery_evidence").values({
            trip_id: tripId,
            run_id: run.id,
            evidence_kind: "google-place",
            provider_place_id: place.providerPlaceId,
            source_url: googleUrl,
            title: place.name,
            attribution: place.attribution,
            observed_at: place.observedAt,
            expires_at: place.expiresAt,
            facts: place,
          }).returning("id").executeTakeFirstOrThrow();
          const evidenceIds = [googleEvidence.id];
          const official = new Set<string>();
          for (const entry of merged) {
            if (entry.wikivoyagePage) {
              evidenceIds.push(await webSource(entry.wikivoyagePage.url, `${entry.wikivoyagePage.title} (Wikivoyage)`, "Wikivoyage"));
            }
            if (entry.officialPage) {
              official.add(entry.officialPage);
              evidenceIds.push(await webSource(
                entry.officialPage,
                sourceTitles.get(entry.officialPage) ?? new URL(entry.officialPage).hostname,
                "Official tourism site",
              ));
            }
          }
          for (const source of merged.flatMap((entry) => entry.researched.sources)) {
            if (source.type !== "place_official" || official.has(source.url)) continue;
            evidenceIds.push(await webSource(
              source.url,
              sourceTitles.get(source.url) ?? new URL(source.url).hostname,
              "Place's own website",
            ));
          }
          const recommendationSentences = await storeClaimSentences(researched.recommendationSentences, evidenceIds);
          const tradeoffSentences = await storeClaimSentences(researched.tradeoffSentences, evidenceIds);
          const proposal = await transaction.insertInto("candidate_proposals").values({
            trip_id: tripId,
            run_id: run.id,
            provider_place_id: place.providerPlaceId,
            name: place.name,
            place_type: place.type,
            address: place.address,
            latitude: place.latitude,
            longitude: place.longitude,
            source_url: place.sourceUrl,
            recommendation: recommendationSentences.map((sentence) => sentence.text).join(" "),
            matched_needs: JSON.stringify(researched.matchedNeeds),
            tradeoffs: JSON.stringify(tradeoffSentences.map((sentence) => sentence.text)),
            unknowns: JSON.stringify(researched.unknowns),
            status: "pending",
            accepted_trip_place_id: null,
            decided_by: null,
            decided_at: null,
            // A named place of no requested kind shows the kind a merged entry was found for.
            category: researched.category ?? merged.find((entry) => entry.researched.category)?.researched.category ?? null,
            endorsements: JSON.stringify(endorsements),
            recommendation_sentences: JSON.stringify(recommendationSentences),
            tradeoff_sentences: JSON.stringify(tradeoffSentences),
          }).returning("id").executeTakeFirstOrThrow();
          // Owner decision 2026-10-19: a suggestion gets its place identity now, not on acceptance,
          // so the Commons pipeline can give it a list photo. Acceptance reuses this identity.
          const identity = await upsertGooglePlaceIdentity(transaction, place, this.now());
          if (!suggestionIdentityIds.includes(identity.id)) suggestionIdentityIds.push(identity.id);
          await transaction.insertInto("candidate_proposal_evidence").values(
            [...new Set(evidenceIds)].map((evidenceId) => ({ proposal_id: proposal.id, evidence_id: evidenceId })),
          ).execute();
        }
        // Reopened candidates last until the next successful run; retain only active members' interest
        // when that run independently recommends the same identity again.
        await sql`
          with superseded as (
            update candidate_proposals
            set reopened_at = null
            where trip_id = ${tripId} and run_id <> ${run.id}
              and status = 'pending' and reopened_at is not null
            returning id, provider_place_id
          )
          insert into discovery_proposal_votes (trip_id, proposal_id, member_user_id)
          select distinct replacement.trip_id, replacement.id, vote.member_user_id
          from superseded
          join candidate_proposals as replacement
            on replacement.provider_place_id = superseded.provider_place_id
            and replacement.trip_id = ${tripId} and replacement.run_id = ${run.id}
          join discovery_proposal_votes as vote on vote.proposal_id = superseded.id
          join trip_members as member
            on member.trip_id = vote.trip_id and member.user_id = vote.member_user_id
          where member.removed_at is null
          on conflict (proposal_id, member_user_id) do nothing
        `.execute(transaction);
        await recordEvent(transaction, {
          tripId,
          actorId: userId,
          eventType: "discovery.generated",
          targetType: "discovery_run",
          targetId: run.id,
          summary: `Generated ${verification.gate.shown.length} place proposals vouched for by two independent sources`,
        });
        const response = await this.readWorkspace(transaction, tripId, userId);
        await transaction.updateTable("mutation_requests")
          .set({ response: { type: DISCOVERY_WORKSPACE_READBACK } })
          .where("actor_id", "=", userId)
          .where("operation", "=", operation)
          .where("idempotency_key", "=", key)
          .execute();
        return response;
      });
      this.findSuggestionPhotos(suggestionIdentityIds);
      return workspace;
    } catch (error) {
      if (error instanceof ProviderQuotaError) {
        // A daily budget refusal is transient and made no Google request. Remove the claim so the
        // same idempotency key can retry after capacity becomes available.
        await this.database.deleteFrom("mutation_requests")
          .where("actor_id", "=", userId)
          .where("operation", "=", operation)
          .where("idempotency_key", "=", key)
          .execute();
        throw new AppError("provider_unavailable", error.message, 503);
      }
      const failure = error instanceof AppError
        ? error
        : error instanceof DiscoveryModelUnavailableError
          ? new AppError("model_unavailable", error.message, 503)
          : error instanceof DiscoveryModelResponseError
            ? new AppError("model_unavailable", error.message, 503)
            : null;
      if (!failure) {
        // An unexpected failure must still release the claim, or every retry of this key
        // would be told the request is in progress forever.
        await this.database.updateTable("mutation_requests").set({
          response: {
            type: AI_REQUEST_STATE,
            state: "failed",
            code: "model_unavailable",
            message: "The discovery request failed; try again",
          },
        })
          .where("actor_id", "=", userId)
          .where("operation", "=", operation)
          .where("idempotency_key", "=", key)
          .execute();
        throw error;
      }
      const replayCode = failure.code === "provider_unavailable"
        ? "provider_unavailable"
        : failure.code === "conflict"
          ? "conflict"
          : "model_unavailable";
      await this.database.updateTable("mutation_requests").set({
        response: {
          type: AI_REQUEST_STATE,
          state: "failed",
          code: replayCode,
          message: failure.message,
        },
      })
        .where("actor_id", "=", userId)
        .where("operation", "=", operation)
        .where("idempotency_key", "=", key)
        .execute();
      throw failure;
    }
  }

  async setProposalVote(
    userId: string,
    tripId: string,
    proposalId: string,
    rawKey: string,
    input: UpdateCandidateProposalVoteInput,
  ) {
    uuid(tripId, "tripId");
    uuid(proposalId, "proposalId");
    if (typeof input.voted !== "boolean") {
      throw new AppError("validation_error", "voted must be a boolean");
    }
    const key = requireIdempotencyKey(rawKey);
    const operation = `dv:${tripId.toLowerCase()}:${proposalId.toLowerCase()}`;
    return this.database.transaction().execute(async (transaction) => {
      await this.requireMember(transaction, userId, tripId);
      await lockMutation(transaction, userId, operation, key);
      await transaction.selectFrom("trips").select("id").where("id", "=", tripId).forUpdate().executeTakeFirstOrThrow();
      await this.requireMember(transaction, userId, tripId);
      const replay = await replayed(transaction, userId, operation, key);
      if (replay) return replayedProposal(replay, proposalId);
      const members = await transaction.selectFrom("trip_members")
        .select((builder) => builder.fn.countAll().as("count"))
        .where("trip_id", "=", tripId).where("removed_at", "is", null)
        .executeTakeFirstOrThrow();
      // Owner decision (2026-10-14): a solo traveller can mark proposals too; any active member may vote.
      if (Number(members.count) < 1) {
        throw new AppError("voting_unavailable", "Voting needs an active trip member", 409);
      }
      const proposal = await transaction.selectFrom("candidate_proposals")
        .select(["id", "status"])
        .where("id", "=", proposalId).where("trip_id", "=", tripId)
        .forUpdate().executeTakeFirst();
      if (!proposal) throw new AppError("discovery_proposal_not_found", "Candidate proposal not found", 404);
      if (proposal.status !== "pending") {
        throw new AppError("conflict", "Votes can only be changed on a pending proposal", 409);
      }
      if (input.voted) {
        await transaction.insertInto("discovery_proposal_votes").values({
          trip_id: tripId,
          proposal_id: proposalId,
          member_user_id: userId,
        }).onConflict((conflict) => conflict.columns(["proposal_id", "member_user_id"]).doNothing()).execute();
      } else {
        await transaction.deleteFrom("discovery_proposal_votes")
          .where("proposal_id", "=", proposalId).where("member_user_id", "=", userId).execute();
      }
      await recordEvent(transaction, {
        tripId,
        actorId: userId,
        eventType: "discovery.proposal_vote_changed",
        targetType: "candidate_proposal",
        targetId: proposalId,
        summary: input.voted ? "Voted for an AI place proposal" : "Removed own vote from an AI place proposal",
      });
      const response = await this.readProposal(transaction, tripId, userId, proposalId);
      await remember(transaction, userId, operation, key, response);
      return response;
    });
  }

  async scheduleProposals(
    userId: string,
    tripId: string,
    rawKey: string,
    input: ScheduleDiscoveryProposalsInput,
  ) {
    tripId = uuid(tripId, "tripId").toLowerCase();
    const tripDayId = uuid(input.tripDayId, "tripDayId").toLowerCase();
    if (!Array.isArray(input.proposals) || input.proposals.length === 0 || input.proposals.length > 100) {
      throw new AppError("validation_error", "proposals must contain between 1 and 100 proposals");
    }
    const versions = new Map<string, number>();
    for (const entry of input.proposals) {
      const proposalId = uuid(entry?.proposalId, "proposalId").toLowerCase();
      if (versions.has(proposalId)) {
        throw new AppError("validation_error", `Proposal ${proposalId} appears more than once`);
      }
      const version = expectedVersion(entry.expectedVersion);
      versions.set(proposalId, version);
    }
    const key = requireIdempotencyKey(rawKey);
    const operation = `discovery:schedule:${tripId}`;
    return this.database.transaction().execute(async (transaction) => {
      await requireScheduler(transaction, userId, tripId);
      await lockMutation(transaction, userId, operation, key);
      await transaction.selectFrom("trips").select("id").where("id", "=", tripId)
        .forUpdate().executeTakeFirstOrThrow();
      await requireScheduler(transaction, userId, tripId);
      const replay = await replayed(transaction, userId, operation, key);
      if (replay) {
        return isDiscoveryWorkspaceReadback(replay)
          ? this.readWorkspace(transaction, tripId, userId)
          : replayedWorkspace(replay);
      }
      await PostgresTripPlaceModule.reconcileLegacyPlacesInTransaction(transaction, tripId, this.now);
      const day = await transaction.selectFrom("trip_days").select("id")
        .where("trip_id", "=", tripId).where("id", "=", tripDayId).executeTakeFirst();
      if (!day) throw new AppError("validation_error", "tripDayId must belong to this trip");
      // Provider identities are shared across trips: materialize them in a stable order too.
      const proposals = await transaction.selectFrom("candidate_proposals").selectAll()
        .where("trip_id", "=", tripId).where("id", "in", [...versions.keys()])
        .orderBy("provider_place_id").orderBy("id").forUpdate().execute();
      const found = new Set(proposals.map((proposal) => proposal.id));
      for (const proposalId of versions.keys()) {
        if (!found.has(proposalId)) {
          throw new AppError("discovery_proposal_not_found", `Candidate proposal ${proposalId} not found`, 404);
        }
      }
      const proposalByPlace = new Map<string, string>();
      for (const proposal of proposals) {
        const tripPlaceId = await this.acceptProposalInTransaction(
          transaction, userId, tripId, proposal, versions.get(proposal.id)!, { scheduling: true },
        );
        proposalByPlace.set(tripPlaceId, proposal.id);
      }
      const places = await transaction.selectFrom("trip_places").select(["id", "version", "latitude", "longitude"])
        .where("trip_id", "=", tripId).where("id", "in", [...proposalByPlace.keys()])
        .where("archived_at", "is", null).orderBy("id").forUpdate().execute();
      for (const place of places) {
        if (place.latitude === null || place.longitude === null) {
          throw new AppError(
            "validation_error", `Proposal ${proposalByPlace.get(place.id)} has a trip place without coordinates and cannot be scheduled`,
          );
        }
      }
      await this.tripPlaces.writeDayAssignmentsInTransaction(
        transaction, userId, tripId,
        places.map((place) => ({ tripPlaceId: place.id, tripDayId, expectedVersion: place.version })),
      );
      const response = await this.readWorkspace(transaction, tripId, userId);
      await remember(transaction, userId, operation, key, { type: DISCOVERY_WORKSPACE_READBACK });
      return response;
    });
  }

  /** All acceptance effects use the caller's transaction; no network calls or nested commits. */
  private async acceptProposalInTransaction(
    transaction: Transaction<AlongTheWayDatabase>,
    userId: string,
    tripId: string,
    proposal: Selectable<CandidateProposalTable>,
    version: number,
    options: { scheduling: boolean; resumeKey?: string },
  ) {
    const proposalId = proposal.id;
    const resuming = !options.scheduling && proposal.status === "accepting" && proposal.version === version + 1;
    if (proposal.version !== version && !resuming) {
      throw new AppError(
        "conflict", `Candidate proposal ${proposalId} changed; reload before accepting`,
        409, undefined, proposal.version, proposalId,
      );
    }
    if (options.scheduling && proposal.status === "accepted") {
      const place = proposal.accepted_trip_place_id === null ? undefined
        : await transaction.selectFrom("trip_places").select("id")
          .where("id", "=", proposal.accepted_trip_place_id).where("trip_id", "=", tripId)
          .where("archived_at", "is", null).forUpdate().executeTakeFirst();
      if (!place) {
        throw new AppError("conflict", `Accepted trip place for proposal ${proposalId} is no longer available`, 409);
      }
      return place.id;
    }
    if (proposal.status !== "pending" && !resuming) {
      throw new AppError(
        "conflict", `Candidate proposal ${proposalId} is ${proposal.status}; reload before accepting`,
        409, undefined, proposal.version, proposalId,
      );
    }
    if (options.scheduling && (proposal.latitude === null || proposal.longitude === null)) {
      throw new AppError("validation_error", `Proposal ${proposalId} has no coordinates and cannot be scheduled`);
    }
    if (!resuming) {
      await transaction.updateTable("candidate_proposals").set({
        status: "accepting",
        version: sql`version + 1`,
        updated_at: this.now(),
      }).where("id", "=", proposalId).execute();
    }
    // A retained binary may have committed the old intermediate intake before stopping.
    const previousIntake = options.resumeKey
      ? await replayed(transaction, userId, `tp:add:${tripId}`, `${options.resumeKey}:trip-place`)
      : null;
    let tripPlaceId = previousIntake ? requiredText(jsonObject(previousIntake).id, "tripPlaceId", 36) : null;
    if (tripPlaceId === null) {
      const evidence = await transaction.selectFrom("discovery_evidence as evidence")
        .innerJoin("candidate_proposal_evidence as link", "link.evidence_id", "evidence.id")
        .select("evidence.facts")
        .where("link.proposal_id", "=", proposalId)
        .where("evidence.evidence_kind", "=", "google-place")
        .executeTakeFirstOrThrow();
      const facts = jsonObject(evidence.facts);
      const candidate: ProviderPlaceCandidateDto = {
        provider: "google",
        providerPlaceId: proposal.provider_place_id,
        name: proposal.name,
        type: proposal.place_type,
        typeLabel: null,
        address: proposal.address,
        latitude: proposal.latitude,
        longitude: proposal.longitude,
        timeZone: typeof facts.timeZone === "string" ? facts.timeZone : null,
        sourceUrl: proposal.source_url,
        attribution: typeof facts.attribution === "string" ? facts.attribution : this.placeLookup.attribution,
        observedAt: typeof facts.observedAt === "string" ? facts.observedAt : isoTimestamp(proposal.created_at),
        expiresAt: typeof facts.expiresAt === "string" ? facts.expiresAt : isoTimestamp(this.now()),
        photo: null,
      };
      tripPlaceId = await this.tripPlaces.addObservedCandidateInTransaction(transaction, userId, tripId, candidate);
    }
    const activePlace = await transaction.selectFrom("trip_places").select("id")
      .where("id", "=", tripPlaceId).where("trip_id", "=", tripId)
      .where("archived_at", "is", null).forUpdate().executeTakeFirst();
    if (!activePlace) {
      throw new AppError("conflict", `The accepted place for proposal ${proposalId} was removed from the wishlist; reload`, 409);
    }
    await transaction.updateTable("candidate_proposals").set({
      status: "accepted",
      reopened_at: null,
      accepted_trip_place_id: tripPlaceId,
      decided_by: userId,
      decided_at: this.now(),
      version: sql`version + 1`,
      updated_at: this.now(),
    }).where("id", "=", proposalId).execute();
    const proposalVotes = await transaction.selectFrom("discovery_proposal_votes as vote")
      .innerJoin("trip_members as member", (join) => join
        .onRef("member.trip_id", "=", "vote.trip_id")
        .onRef("member.user_id", "=", "vote.member_user_id"))
      .select("vote.member_user_id")
      .where("vote.proposal_id", "=", proposalId)
      .where("member.removed_at", "is", null)
      .execute();
    const carriedVotes = proposalVotes.length === 0
      ? []
      : await transaction.insertInto("trip_place_votes").values(proposalVotes.map((vote) => ({
          trip_id: tripId,
          trip_place_id: activePlace.id,
          member_user_id: vote.member_user_id,
        }))).onConflict((conflict) => conflict.columns(["trip_place_id", "member_user_id"]).doNothing())
        .returning("member_user_id").execute();
    if (carriedVotes.length > 0) {
      await transaction.updateTable("trip_places").set({
        version: sql`version + 1`,
        updated_at: this.now(),
      }).where("id", "=", tripPlaceId).execute();
      await recordEvent(transaction, {
        tripId,
        actorId: userId,
        eventType: "trip_place.vote_carried_from_proposal",
        targetType: "trip_place",
        targetId: tripPlaceId,
        summary: `Carried ${carriedVotes.length} proposal vote(s) into the shared wishlist`,
      });
    }
    await recordEvent(transaction, {
      tripId,
      actorId: userId,
      eventType: "discovery.proposal_accepted",
      targetType: "candidate_proposal",
      targetId: proposalId,
      summary: "Accepted an AI place proposal into the shared wishlist",
    });
    return tripPlaceId;
  }

  async rejectProposal(
    userId: string,
    tripId: string,
    proposalId: string,
    rawKey: string,
    input: DecideCandidateProposalInput,
  ) {
    uuid(tripId, "tripId");
    uuid(proposalId, "proposalId");
    const key = requireIdempotencyKey(rawKey);
    const version = expectedVersion(input.expectedVersion);
    const operation = `dr:${tripId.toLowerCase()}:${proposalId.toLowerCase()}`;
    return this.database.transaction().execute(async (transaction) => {
      await requireTripOwner(transaction, userId, tripId);
      await lockMutation(transaction, userId, operation, key);
      await transaction.selectFrom("trips").select("id").where("id", "=", tripId)
        .forUpdate().executeTakeFirstOrThrow();
      await requireTripOwner(transaction, userId, tripId);
      const replay = await replayed(transaction, userId, operation, key);
      if (replay) {
        return isDiscoveryWorkspaceReadback(replay)
          ? this.readWorkspace(transaction, tripId, userId)
          : replayedWorkspace(replay);
      }
      const updated = await transaction.updateTable("candidate_proposals").set({
        status: "rejected",
        reopened_at: null,
        decided_by: userId,
        decided_at: this.now(),
        version: sql`version + 1`,
        updated_at: this.now(),
      }).where("id", "=", proposalId)
        .where("trip_id", "=", tripId)
        .where("status", "=", "pending")
        .where("version", "=", version)
        .returning("id")
        .executeTakeFirst();
      if (!updated) {
        const current = await transaction.selectFrom("candidate_proposals").select("version")
          .where("id", "=", proposalId).where("trip_id", "=", tripId).executeTakeFirst();
        if (!current) throw new AppError("discovery_proposal_not_found", "Candidate proposal not found", 404);
        throw new AppError("conflict", "The candidate proposal changed; reload before rejecting", 409, undefined, current.version);
      }
      await recordEvent(transaction, {
        tripId,
        actorId: userId,
        eventType: "discovery.proposal_rejected",
        targetType: "candidate_proposal",
        targetId: proposalId,
        summary: "Marked an AI place proposal as not recommended",
      });
      const response = await this.readWorkspace(transaction, tripId, userId);
      await remember(transaction, userId, operation, key, { type: DISCOVERY_WORKSPACE_READBACK });
      return response;
    });
  }

  async restoreProposal(
    userId: string,
    tripId: string,
    proposalId: string,
    rawKey: string,
    input: DecideCandidateProposalInput,
  ) {
    uuid(tripId, "tripId");
    uuid(proposalId, "proposalId");
    const key = requireIdempotencyKey(rawKey);
    // 0 stands for "unknown" in replays stored before restore existed: it never matches a row.
    const version = input.expectedVersion;
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) {
      throw new AppError("validation_error", "expectedVersion must be a non-negative integer");
    }
    const operation = `ds:${tripId.toLowerCase()}:${proposalId.toLowerCase()}`;
    return this.database.transaction().execute(async (transaction) => {
      await requireTripOwner(transaction, userId, tripId);
      await lockMutation(transaction, userId, operation, key);
      await transaction.selectFrom("trips").select("id").where("id", "=", tripId)
        .forUpdate().executeTakeFirstOrThrow();
      await requireTripOwner(transaction, userId, tripId);
      const replay = await replayed(transaction, userId, operation, key);
      if (replay) {
        return isDiscoveryWorkspaceReadback(replay)
          ? this.readWorkspace(transaction, tripId, userId)
          : replayedWorkspace(replay);
      }
      const target = await transaction.selectFrom("candidate_proposals")
        .select(["provider_place_id", "status", "version", "decided_at"])
        .where("id", "=", proposalId).where("trip_id", "=", tripId)
        .forUpdate().executeTakeFirst();
      if (!target) throw new AppError("discovery_proposal_not_found", "Candidate proposal not found", 404);
      if (target.status !== "rejected" || target.version !== version || target.decided_at === null) {
        throw new AppError("conflict", "The candidate proposal changed; reload before restoring", 409, undefined, target.version);
      }
      // A later rejection of the same place stands; undoing this older one would not bring it back.
      const newer = await transaction.selectFrom("candidate_proposals").select("id")
        .where("trip_id", "=", tripId)
        .where("provider_place_id", "=", target.provider_place_id)
        .where("status", "=", "rejected")
        .where("id", "<>", proposalId)
        .where("decided_at", ">", target.decided_at)
        .executeTakeFirst();
      if (newer) {
        throw new AppError("conflict", "This place was marked not recommended again later; reload", 409, undefined, target.version);
      }
      // Pending with reopened_at keeps an earlier run's proposal on the current shortlist (readWorkspace).
      await transaction.updateTable("candidate_proposals").set({
        status: "pending",
        reopened_at: this.now(),
        decided_by: null,
        decided_at: null,
        version: sql`version + 1`,
        updated_at: this.now(),
      }).where("id", "=", proposalId).execute();
      // Research leaves out any place with a rejected proposal, so this place's earlier rejections
      // are lifted too. They stay off the shortlist (no reopened_at).
      await transaction.updateTable("candidate_proposals").set({
        status: "pending",
        reopened_at: null,
        decided_by: null,
        decided_at: null,
        version: sql`version + 1`,
        updated_at: this.now(),
      }).where("trip_id", "=", tripId)
        .where("provider_place_id", "=", target.provider_place_id)
        .where("status", "=", "rejected")
        .where("id", "<>", proposalId)
        .where("decided_at", "<=", target.decided_at)
        .execute();
      await recordEvent(transaction, {
        tripId,
        actorId: userId,
        eventType: "discovery.proposal_restored",
        targetType: "candidate_proposal",
        targetId: proposalId,
        summary: "Restored an AI place proposal marked as not recommended",
      });
      const response = await this.readWorkspace(transaction, tripId, userId);
      await remember(transaction, userId, operation, key, { type: DISCOVERY_WORKSPACE_READBACK });
      return response;
    });
  }


  private async requireMember(executor: DatabaseExecutor, userId: string, tripId: string) {
    const member = await executor.selectFrom("trip_members").select("user_id")
      .where("trip_id", "=", tripId)
      .where("user_id", "=", userId)
      .where("removed_at", "is", null)
      .executeTakeFirst();
    if (!member) throw new AppError("trip_not_found", "Trip not found", 404);
  }

  /**
   * Model calls cost money, so research has per-account and per-trip limits. A request
   * counts once claimed, whatever its outcome; an idempotent replay never gets here.
   */
  private async claimAiSlot(
    transaction: Transaction<AlongTheWayDatabase>,
    userId: string,
    tripId: string,
  ) {
    for (const lock of [
      `${AI_LIMIT_LOCK_PREFIX}account:${userId}`,
      `${AI_LIMIT_LOCK_PREFIX}trip:${tripId}`,
    ]) {
      await sql`select pg_advisory_xact_lock(hashtextextended(${lock}, 0))`.execute(transaction);
    }
    const tripOperation = `${GENERATE_OPERATION_PREFIX}${tripId.toLowerCase()}`;
    // The query leads with actor_id, the primary key's first column. Trip claims can only
    // come from its members, removed ones included. The database clock stamps created_at.
    const recent = await transaction.selectFrom("mutation_requests")
      .select([
        "operation",
        "actor_id",
        sql<string | null>`response->>'state'`.as("claim_state"),
        sql<boolean>`created_at > now() - interval '10 minutes'`.as("started_recently"),
        sql<number>`ceil(extract(epoch from (created_at + interval '1 hour' - now())))::int`.as("seconds_left"),
      ])
      .where("operation", "like", `${GENERATE_OPERATION_PREFIX}%`)
      .where("created_at", ">", sql<Date>`now() - interval '1 hour'`)
      .where((where) => where.or([
        where.and([
          where("actor_id", "in", where.selectFrom("trip_members").select("user_id").where("trip_id", "=", tripId)),
          where("operation", "=", tripOperation),
        ]),
        where("actor_id", "=", userId),
      ]))
      .execute();
    const forTrip = recent.filter((row) => row.operation === tripOperation);
    // Still marked running after ten minutes means the process running it died.
    if (forTrip.some((row) => row.started_recently && row.claim_state === "in-progress")) {
      throw new AppError("research_in_progress", "An AI request for this trip is already running", 409);
    }
    const byAccount = recent.filter((row) => row.actor_id === userId);
    for (const [rows, limit] of [
      [forTrip, RESEARCH_PER_TRIP_PER_HOUR],
      [byAccount, RESEARCH_PER_ACCOUNT_PER_HOUR],
    ] as const) {
      if (rows.length >= limit) {
        throw new AppError(
          "research_limit_reached",
          "The AI request limit for this hour is reached",
          429,
          Math.max(1, Math.min(...rows.map((row) => row.seconds_left))),
        );
      }
    }
  }

  private async tripFacts(userId: string, tripId: string): Promise<DiscoveryTripFacts> {
    await this.requireMember(this.database, userId, tripId);
    const trip = await this.database.selectFrom("trips").select([
      "name", "start_date", "end_date", "time_zone", "currency",
    ]).where("id", "=", tripId).executeTakeFirst();
    if (!trip) throw new AppError("trip_not_found", "Trip not found", 404);
    const countries = await this.database.selectFrom("trip_country_stops")
      .select(["country_code", "position"])
      .where("trip_id", "=", tripId)
      .orderBy("position")
      .execute();
    return {
      name: trip.name,
      startDate: dateOnly(trip.start_date),
      endDate: dateOnly(trip.end_date),
      timeZone: trip.time_zone,
      currency: trip.currency,
      countries: countries.map((country) => ({ code: country.country_code, position: country.position })),
    };
  }


  private async readProposal(
    executor: DatabaseExecutor,
    tripId: string,
    userId: string,
    proposalId: string,
  ): Promise<CandidateProposalDto> {
    const proposal = await executor.selectFrom("candidate_proposals")
      .select([
        "id",
        "run_id",
        "provider_place_id",
        "name",
        "place_type",
        "address",
        "latitude",
        "longitude",
        "source_url",
        "recommendation",
        "recommendation_sentences",
        "matched_needs",
        "tradeoffs",
        "tradeoff_sentences",
        "unknowns",
        "status",
        "accepted_trip_place_id",
        "version",
        "category",
        "endorsements",
      ])
      .where("trip_id", "=", tripId)
      .where("id", "=", proposalId)
      .executeTakeFirst();
    if (!proposal) throw new AppError("discovery_proposal_not_found", "Candidate proposal not found", 404);

    const members = await executor.selectFrom("trip_members as member")
      .innerJoin("users", "users.id", "member.user_id")
      .select(["member.user_id", "member.role", "users.email", "users.display_name"])
      .where("member.trip_id", "=", tripId)
      .where("member.removed_at", "is", null)
      .orderBy("member.joined_at")
      .execute();
    const voteRows = await executor.selectFrom("discovery_proposal_votes")
      .select("member_user_id")
      .where("proposal_id", "=", proposalId)
      .execute();
    const votedMemberIds = new Set(voteRows.map((vote) => vote.member_user_id));
    const requesterIsOwner = members.some((member) => member.user_id === userId && member.role === "owner");
    const voters = members.filter((member) => votedMemberIds.has(member.user_id)).map((member) => ({
      memberUserId: member.user_id,
      memberEmail: requesterIsOwner || member.user_id === userId ? member.email : null,
      memberDisplayName: member.display_name,
    }));
    const evidenceRows = await executor.selectFrom("candidate_proposal_evidence as link")
      .innerJoin("discovery_evidence as evidence", "evidence.id", "link.evidence_id")
      .select([
        "evidence.id",
        "evidence.evidence_kind",
        "evidence.provider_place_id",
        "evidence.source_url",
        "evidence.title",
        "evidence.attribution",
        "evidence.observed_at",
        "evidence.expires_at",
      ])
      .where("link.proposal_id", "=", proposalId)
      .orderBy("evidence.evidence_kind")
      .orderBy("evidence.id")
      .execute();
    const readAt = this.now().getTime();
    const evidence = evidenceRows.map((row) => {
      const staleAt = row.expires_at?.getTime()
        ?? (row.evidence_kind === "web-source"
          ? row.observed_at.getTime() + WEB_EVIDENCE_FRESHNESS_MS
          : null);
      return {
        id: row.id,
        kind: row.evidence_kind,
        providerPlaceId: row.provider_place_id,
        sourceUrl: row.source_url,
        title: row.title,
        attribution: row.attribution,
        observedAt: isoTimestamp(row.observed_at),
        expiresAt: row.expires_at ? isoTimestamp(row.expires_at) : null,
        isStale: staleAt !== null && staleAt < readAt,
      };
    });
    return {
      id: proposal.id,
      runId: proposal.run_id,
      providerPlaceId: proposal.provider_place_id,
      name: proposal.name,
      type: proposal.place_type,
      address: proposal.address,
      latitude: proposal.latitude,
      longitude: proposal.longitude,
      sourceUrl: proposal.source_url,
      recommendation: proposal.recommendation,
      recommendationSentences: jsonClaimSentences(proposal.recommendation_sentences),
      matchedNeeds: jsonStrings(proposal.matched_needs),
      tradeoffs: jsonStrings(proposal.tradeoffs),
      tradeoffSentences: jsonClaimSentences(proposal.tradeoff_sentences),
      unknowns: jsonStrings(proposal.unknowns),
      status: proposal.status,
      evidence,
      voters,
      voteCount: voters.length,
      ownVote: voters.some((member) => member.memberUserId === userId),
      votingAvailable: members.length >= 1,
      acceptedTripPlaceId: proposal.accepted_trip_place_id,
      version: proposal.version,
      category: proposal.category,
      endorsements: this.readEndorsements(proposal.endorsements),
    };
  }

  private async readWorkspace(
    executor: DatabaseExecutor,
    tripId: string,
    userId: string,
  ): Promise<DiscoveryWorkspaceDto> {
    const briefRow = await executor.selectFrom("discovery_briefs").selectAll()
      .where("trip_id", "=", tripId).executeTakeFirst();
    const run = await executor.selectFrom("discovery_runs").selectAll()
      .where("trip_id", "=", tripId)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .executeTakeFirst();
    const proposalRows = run
      ? await executor.selectFrom("candidate_proposals")
        .select([
          "id",
          "run_id",
          "provider_place_id",
          "name",
          "place_type",
          "address",
          "latitude",
          "longitude",
          "source_url",
          "recommendation",
          "recommendation_sentences",
          "matched_needs",
          "tradeoffs",
          "tradeoff_sentences",
          "unknowns",
          "status",
          "accepted_trip_place_id",
          "version",
          "category",
          "endorsements",
        ])
        .where("trip_id", "=", tripId)
        .where((expression) => expression.or([
          expression("run_id", "=", run.id),
          expression.and([
            expression("status", "=", "pending"),
            expression("reopened_at", "is not", null),
          ]),
        ]))
        // Newest first; votes are shown but never reorder the list (owner decision 2026-10-19).
        .orderBy("candidate_proposals.created_at", "desc")
        .orderBy("candidate_proposals.id", "desc")
        .execute()
      : [];
    const proposalIds = proposalRows.map((proposal) => proposal.id);
    const members = proposalIds.length === 0
      ? []
      : await executor.selectFrom("trip_members as member")
        .innerJoin("users", "users.id", "member.user_id")
        .select(["member.user_id", "member.role", "users.email", "users.display_name"])
        .where("member.trip_id", "=", tripId)
        .where("member.removed_at", "is", null)
        .orderBy("member.joined_at")
        .execute();
    const proposalVoteRows = proposalIds.length === 0
      ? []
      : await executor.selectFrom("discovery_proposal_votes")
        .select(["proposal_id", "member_user_id"])
        .where("proposal_id", "in", proposalIds)
        .execute();
    const proposalVotesByKey = new Set(proposalVoteRows.map((vote) => `${vote.proposal_id}:${vote.member_user_id}`));
    const requesterIsOwner = members.some((member) => member.user_id === userId && member.role === "owner");
    // Earlier runs' decisions stay visible after a new run replaces their undecided proposals:
    // one entry per place, its newest decision, unless the latest run lists the place itself.
    const earlierDecisions = run
      ? await executor.selectFrom("candidate_proposals as proposal")
        .leftJoin("trip_places as tripPlace", "tripPlace.id", "proposal.accepted_trip_place_id")
        .select([
          "proposal.id",
          "proposal.provider_place_id",
          "proposal.name",
          "proposal.status",
          "proposal.decided_at",
          "proposal.version",
          "proposal.accepted_trip_place_id",
          "tripPlace.archived_at as accepted_place_archived_at",
        ])
        .where("proposal.trip_id", "=", tripId)
        .where("proposal.run_id", "<>", run.id)
        .where("proposal.status", "in", ["accepted", "rejected"])
        .where("proposal.decided_at", "is not", null)
        .orderBy("proposal.decided_at", "desc")
        .orderBy("proposal.id", "desc")
        .execute()
      : [];
    const listedPlaceIds = new Set(proposalRows.map((proposal) => proposal.provider_place_id));
    const decided: DiscoveryDecisionDto[] = [];
    for (const row of earlierDecisions) {
      if (listedPlaceIds.has(row.provider_place_id)) continue;
      listedPlaceIds.add(row.provider_place_id);
      // Accepted, then taken off the wishlist: no longer decided, and a new run may propose it.
      if (row.status === "accepted" && (row.accepted_trip_place_id === null || row.accepted_place_archived_at)) continue;
      if ((row.status === "accepted" || row.status === "rejected") && row.decided_at) {
        decided.push({
          proposalId: row.id,
          providerPlaceId: row.provider_place_id,
          name: row.name,
          status: row.status,
          decidedAt: isoTimestamp(row.decided_at),
          version: row.version,
        });
      }
    }
    const evidenceRows = proposalIds.length
      ? await executor.selectFrom("candidate_proposal_evidence as link")
        .innerJoin("discovery_evidence as evidence", "evidence.id", "link.evidence_id")
        .select([
          "link.proposal_id",
          "evidence.id",
          "evidence.evidence_kind",
          "evidence.provider_place_id",
          "evidence.source_url",
          "evidence.title",
          "evidence.attribution",
          "evidence.observed_at",
          "evidence.expires_at",
        ])
        .where("link.proposal_id", "in", proposalIds)
        .orderBy("evidence.evidence_kind")
        .orderBy("evidence.id")
        .execute()
      : [];
    const evidenceByProposal = new Map<string, CandidateProposalDto["evidence"]>();
    const workspaceReadAt = this.now().getTime();
    for (const row of evidenceRows) {
      const values = evidenceByProposal.get(row.proposal_id) ?? [];
      const staleAt = row.expires_at?.getTime()
        ?? (row.evidence_kind === "web-source"
          ? row.observed_at.getTime() + WEB_EVIDENCE_FRESHNESS_MS
          : null);
      values.push({
        id: row.id,
        kind: row.evidence_kind,
        providerPlaceId: row.provider_place_id,
        sourceUrl: row.source_url,
        title: row.title,
        attribution: row.attribution,
        observedAt: isoTimestamp(row.observed_at),
        expiresAt: row.expires_at ? isoTimestamp(row.expires_at) : null,
        isStale: staleAt !== null && staleAt < workspaceReadAt,
      });
      evidenceByProposal.set(row.proposal_id, values);
    }
    return {
      brief: briefRow ? {
        originalText: briefRow.original_text,
        structured: briefRow.structured_brief ? this.readStructuredBrief(briefRow.structured_brief) : null,
        unresolvedQuestions: jsonStrings(briefRow.unresolved_questions),
        questionAnswers: storedQuestionAnswers(briefRow.question_answers),
        version: briefRow.version,
        updatedAt: isoTimestamp(briefRow.updated_at),
      } : null,
      latestRun: run ? {
        id: run.id,
        status: run.status,
        modelId: run.model_id,
        policyVersion: run.policy_version,
        briefVersion: run.brief_version,
        searchPlan: this.readSearchPlan(run.search_plan),
        generatedAt: isoTimestamp(run.completed_at),
        errorCode: run.error_code,
        shortfalls: this.readShortfalls(run.shortfalls),
      } : null,
      proposals: proposalRows.map((proposal) => {
        const voters = members.filter((member) => proposalVotesByKey.has(`${proposal.id}:${member.user_id}`)).map((member) => ({
          memberUserId: member.user_id,
          memberEmail: requesterIsOwner || member.user_id === userId ? member.email : null,
          memberDisplayName: member.display_name,
        }));
        return {
          id: proposal.id,
          runId: proposal.run_id,
          providerPlaceId: proposal.provider_place_id,
          name: proposal.name,
          type: proposal.place_type,
          address: proposal.address,
          latitude: proposal.latitude,
          longitude: proposal.longitude,
          sourceUrl: proposal.source_url,
          recommendation: proposal.recommendation,
          recommendationSentences: jsonClaimSentences(proposal.recommendation_sentences),
          matchedNeeds: jsonStrings(proposal.matched_needs),
          tradeoffs: jsonStrings(proposal.tradeoffs),
          tradeoffSentences: jsonClaimSentences(proposal.tradeoff_sentences),
          unknowns: jsonStrings(proposal.unknowns),
          status: proposal.status,
          evidence: evidenceByProposal.get(proposal.id) ?? [],
          voters,
          voteCount: voters.length,
          ownVote: voters.some((member) => member.memberUserId === userId),
          votingAvailable: members.length >= 1,
          acceptedTripPlaceId: proposal.accepted_trip_place_id,
          version: proposal.version,
          category: proposal.category,
          endorsements: this.readEndorsements(proposal.endorsements),
        };
      }),
      decided,
      modelAvailable: this.model.available,
      placeProviderAvailable: this.placeLookup.available !== false,
    };
  }

  private readStructuredBrief(value: unknown): StructuredDiscoveryBrief {
    const item = jsonObject(value);
    return {
      interests: jsonStrings(item.interests),
      pace: typeof item.pace === "string" ? item.pace : null,
      budget: typeof item.budget === "string" ? item.budget : null,
      exclusions: jsonStrings(item.exclusions),
      areas: jsonStrings(item.areas),
    };
  }

  private readSearchPlan(value: unknown): DiscoverySearchPlan {
    const item = jsonObject(value);
    const dateRange = jsonObject(item.dateRange);
    return {
      queries: jsonStrings(item.queries),
      areas: jsonStrings(item.areas),
      categories: jsonStrings(item.categories),
      defaultCategories: item.defaultCategories === true,
      namedPlaces: jsonStrings(item.namedPlaces),
      alreadyArranged: jsonStrings(item.alreadyArranged),
      exclusions: jsonStrings(item.exclusions),
      dateRange: {
        start: typeof dateRange.start === "string" ? dateRange.start : EMPTY_PLAN.dateRange.start,
        end: typeof dateRange.end === "string" ? dateRange.end : EMPTY_PLAN.dateRange.end,
      },
    };
  }

  private readEndorsements(value: unknown): DiscoveryEndorsement[] {
    return jsonStrings(value).filter((entry): entry is DiscoveryEndorsement =>
      ENDORSEMENTS.some((endorsement) => endorsement === entry));
  }

  private readShortfalls(value: unknown): DiscoveryShortfallDto[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((raw): DiscoveryShortfallDto[] => {
      const item = jsonObject(raw);
      const code = SHORTFALL_CODES.find((entry) => entry === item.code);
      if (!code || typeof item.subject !== "string") return [];
      return [{
        code,
        subject: item.subject,
        named: item.named === true,
        endorsements: this.readEndorsements(item.endorsements),
        count: typeof item.count === "number" && Number.isSafeInteger(item.count) ? item.count : null,
      }];
    });
  }
}
