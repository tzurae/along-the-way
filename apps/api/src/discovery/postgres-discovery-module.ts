import type {
  AnswerDiscoveryClarificationInput,
  CandidateProposalDto,
  DecideCandidateProposalInput,
  DiscoveryDecisionDto,
  DiscoveryEndorsement,
  DiscoveryJobDto,
  DiscoveryShortfallDto,
  DiscoveryWorkspaceDto,
  SaveDiscoveryBriefInput,
  ScheduleDiscoveryProposalsInput,
  StartDiscoveryClarificationInput,
  StartDiscoveryResearchInput,
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
import {
  applyClarifyAnswers,
  applyClarifyReview,
  clarificationDto,
  clarificationQuestionAnswers,
  clarificationReady,
  itemsNeedingReview,
  newClarifyItems,
  storedClarifyItems,
} from "./discovery-clarification";
import { discoveryJobDto, DiscoveryJobProgress, emptyStages, type ClaimedDiscoveryJob } from "./discovery-jobs";

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
/** Commons photo searches run at once after a research run (background, Wikimedia polite use). */
const SUGGESTION_PHOTO_CONCURRENCY = 3;
/** The 找照片 stage never holds a job longer than this; unfinished places keep their type icon. */
const SUGGESTION_PHOTO_BUDGET_MS = 90_000;
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

/** Clarifying worker/reviewer failures are a temporary 503, like research; anything else is a bug. */
function modelFailure(error: unknown): never {
  if (error instanceof DiscoveryModelUnavailableError || error instanceof DiscoveryModelResponseError) {
    throw new AppError("model_unavailable", error.message, 503);
  }
  throw error;
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

  /**
   * The 找照片 stage: three identities at a time (a modest load on Wikimedia), at most
   * SUGGESTION_PHOTO_BUDGET_MS. "partial" when a search failed or the budget ran out; either way
   * the places without a photo keep their type icon and the job still succeeds.
   */
  private async findSuggestionPhotos(placeIdentityIds: readonly string[]): Promise<"complete" | "partial"> {
    const generator = this.commonsCandidates;
    if (!generator) return placeIdentityIds.length === 0 ? "complete" : "partial";
    const queue = [...placeIdentityIds];
    let failed = false;
    const worker = async () => {
      for (let placeIdentityId = queue.shift(); placeIdentityId; placeIdentityId = queue.shift()) {
        try {
          await generator.generate(placeIdentityId);
        } catch (error) {
          failed = true;
          console.error(JSON.stringify({
            event: "commons_candidate_generation_failed",
            placeIdentityId,
            errorClass: error instanceof Error ? error.constructor.name : "NonErrorThrow",
          }));
        }
      }
    };
    const all = Promise.all(Array.from({ length: Math.min(SUGGESTION_PHOTO_CONCURRENCY, queue.length) }, worker));
    let timer: Timer | undefined;
    const outOfTime = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), SUGGESTION_PHOTO_BUDGET_MS); });
    const finished = await Promise.race([all.then(() => "done" as const), outOfTime]);
    clearTimeout(timer);
    // Past the budget the remaining searches stop being started (the queue empties).
    if (finished === "timeout") queue.length = 0;
    return finished === "done" && !failed ? "complete" : "partial";
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
  /**
   * 調查 step 1: the worker drafts the checklist for the current brief version (once per version).
   * No web search, so it does not count against the hourly research limit.
   */
  async startClarification(userId: string, tripId: string, input: StartDiscoveryClarificationInput) {
    uuid(tripId, "tripId");
    const version = expectedVersion(input.expectedBriefVersion);
    await this.requireMember(this.database, userId, tripId);
    const brief = await this.currentBrief(version, tripId);
    const existing = await this.database.selectFrom("discovery_clarifications").select("trip_id")
      .where("trip_id", "=", tripId).where("brief_version", "=", version).executeTakeFirst();
    if (!existing) {
      if (!this.model.available) throw new AppError("model_unavailable", "AI discovery is not configured", 503);
      const trip = await this.tripFacts(userId, tripId);
      const drafted = await this.model.clarify({ brief: brief.original_text, trip }).catch(modelFailure);
      const items = newClarifyItems(drafted.questions);
      await this.database.insertInto("discovery_clarifications").values({
        trip_id: tripId,
        brief_version: version,
        // With no questions there is nothing to review: research may start right away.
        status: items.length === 0 ? "ready" : "asking",
        items: JSON.stringify(items),
        model_id: drafted.modelId,
        updated_by: userId,
      }).onConflict((conflict) => conflict.columns(["trip_id", "brief_version"]).doNothing()).execute();
    }
    return this.readWorkspace(this.database, tripId, userId);
  }

  /**
   * 調查 step 2: saves the answers and has the reviewer judge them. A required answer the reviewer
   * rejects gets an ask-back (at most twice), then counts as uncertain.
   */
  async answerClarification(userId: string, tripId: string, input: AnswerDiscoveryClarificationInput) {
    uuid(tripId, "tripId");
    const version = expectedVersion(input.expectedVersion);
    if (!Array.isArray(input.answers) || input.answers.length > 5
      || input.answers.some((answer) => !answer || typeof answer.id !== "string"
        || (answer.answer !== null && typeof answer.answer !== "string"))) {
      throw new AppError("validation_error", "answers must be at most five { id, answer } items");
    }
    await this.requireMember(this.database, userId, tripId);
    const brief = await this.database.selectFrom("discovery_briefs").select(["original_text", "version"])
      .where("trip_id", "=", tripId).executeTakeFirst();
    if (!brief) throw new AppError("validation_error", "Save a discovery brief first");
    const row = await this.database.selectFrom("discovery_clarifications").selectAll()
      .where("trip_id", "=", tripId).where("brief_version", "=", brief.version).executeTakeFirst();
    if (!row) throw new AppError("validation_error", "Start 調查 before answering");
    if (row.version !== version) {
      throw new AppError("conflict", "The checklist changed; reload before answering", 409, undefined, row.version);
    }
    const answered = applyClarifyAnswers(storedClarifyItems(row.items), input.answers);
    if ("error" in answered) throw new AppError("validation_error", answered.error);
    const pending = itemsNeedingReview(answered.items);
    let items = answered.items;
    if (pending.length > 0) {
      if (!this.model.available) throw new AppError("model_unavailable", "AI discovery is not configured", 503);
      const trip = await this.tripFacts(userId, tripId);
      const review = await this.model.reviewAnswers({
        brief: brief.original_text,
        trip,
        items: pending.map((item) => ({ id: item.id, text: item.text, options: item.options, required: item.required, answer: item.answer })),
      }).catch(modelFailure);
      items = applyClarifyReview(items, new Set(pending.map((item) => item.id)), review.verdicts);
    }
    // Optimistic write: the model call ran outside any transaction, so a concurrent answer wins once.
    const updated = await this.database.updateTable("discovery_clarifications").set({
      items: JSON.stringify(items),
      status: clarificationReady(items) ? "ready" : "asking",
      rounds: sql`rounds + 1`,
      version: sql`version + 1`,
      updated_by: userId,
      updated_at: this.now(),
    }).where("trip_id", "=", tripId).where("brief_version", "=", brief.version).where("version", "=", version)
      .returning("version").executeTakeFirst();
    if (!updated) throw new AppError("conflict", "The checklist changed; reload before answering", 409);
    return this.readWorkspace(this.database, tripId, userId);
  }

  /**
   * 調查 step 3: queues research once every required answer is accepted. The worker runs it; the
   * client follows the job's stages. Counts against the hourly research limit like before.
   */
  async startResearch(userId: string, tripId: string, clientIp: string, rawKey: string, input: StartDiscoveryResearchInput) {
    uuid(tripId, "tripId");
    const key = requireIdempotencyKey(rawKey);
    const version = expectedVersion(input.expectedBriefVersion);
    // Lowercase: the path accepts the UUID in any case, and the research limits are keyed on this
    // string, so another spelling must not count as another trip.
    const operation = `${GENERATE_OPERATION_PREFIX}${tripId.toLowerCase()}`;
    await this.requireMember(this.database, userId, tripId);
    if (await replayed(this.database, userId, operation, key)) return this.readWorkspace(this.database, tripId, userId);
    await this.currentBrief(version, tripId);
    const clarification = await this.database.selectFrom("discovery_clarifications").select("status")
      .where("trip_id", "=", tripId).where("brief_version", "=", version).executeTakeFirst();
    if (clarification?.status !== "ready") {
      throw new AppError("clarification_incomplete", "Answer the required questions before research", 409);
    }
    if (!this.model.available) throw new AppError("model_unavailable", "AI discovery is not configured", 503);
    if (this.placeLookup.available === false) {
      throw new AppError("provider_unavailable", "Google Places is unavailable; the existing shortlist is unchanged", 503);
    }
    const jobId = await this.database.transaction().execute(async (transaction) => {
      await lockMutation(transaction, userId, operation, key);
      if (await replayed(transaction, userId, operation, key)) return null;
      await this.claimAiSlot(transaction, userId, tripId);
      const active = await transaction.selectFrom("discovery_jobs").select("id")
        .where("trip_id", "=", tripId).where("status", "in", ["queued", "running"]).executeTakeFirst();
      if (active) throw new AppError("research_in_progress", "A research job for this trip is already running", 409);
      const job = await transaction.insertInto("discovery_jobs").values({
        trip_id: tripId,
        brief_version: version,
        created_by: userId,
        client_ip: clientIp.slice(0, 64),
        status: "queued",
        stages: JSON.stringify(emptyStages()),
      }).returning("id").executeTakeFirstOrThrow();
      await remember(transaction, userId, operation, key, { type: DISCOVERY_WORKSPACE_READBACK });
      return job.id;
    });
    if (jobId) {
      try {
        await this.claimAiRun(userId, tripId);
      } catch (error) {
        // The model was never called: drop the job and the claim so the limit is not spent.
        await this.database.deleteFrom("discovery_jobs").where("id", "=", jobId).execute();
        await this.database.deleteFrom("mutation_requests")
          .where("actor_id", "=", userId).where("operation", "=", operation).where("idempotency_key", "=", key)
          .execute();
        throw error;
      }
    }
    return this.readWorkspace(this.database, tripId, userId);
  }

  /** The trip's newest research job, polled by the client while one is active. */
  async latestJob(userId: string, tripId: string): Promise<DiscoveryJobDto | null> {
    uuid(tripId, "tripId");
    await this.requireMember(this.database, userId, tripId);
    const row = await this.database.selectFrom("discovery_jobs").selectAll()
      .where("trip_id", "=", tripId).orderBy("created_at", "desc").limit(1).executeTakeFirst();
    return row ? discoveryJobDto(row) : null;
  }

  /** Marks a finished job as seen, so its completion notice is not shown again. */
  async acknowledgeJob(userId: string, tripId: string, jobId: string): Promise<DiscoveryJobDto | null> {
    uuid(tripId, "tripId");
    uuid(jobId, "jobId");
    await this.requireMember(this.database, userId, tripId);
    await this.database.updateTable("discovery_jobs").set({ acknowledged_at: this.now() })
      .where("id", "=", jobId).where("trip_id", "=", tripId)
      .where("status", "in", ["succeeded", "failed"]).where("acknowledged_at", "is", null)
      .execute();
    return this.latestJob(userId, tripId);
  }

  private async currentBrief(version: number, tripId: string) {
    const brief = await this.database.selectFrom("discovery_briefs").select(["original_text", "version"])
      .where("trip_id", "=", tripId).executeTakeFirst();
    if (!brief) throw new AppError("validation_error", "Save a discovery brief first");
    if (brief.version !== version) {
      throw new AppError("conflict", "The discovery brief changed; reload before continuing", 409, undefined, brief.version);
    }
    return brief;
  }


  /**
   * Worker side of 調查: runs one claimed job through its stages and records each stage, so the
   * client can show where it is. Never throws; a failure is recorded on the job.
   */
  async runJob(job: ClaimedDiscoveryJob): Promise<void> {
    const tripId = job.tripId;
    const userId = job.createdBy;
    const version = job.briefVersion;
    const progress = new DiscoveryJobProgress(this.database, job.id, this.now);
    try {
    const brief = await this.database.selectFrom("discovery_briefs")
      .select(["original_text", "version"])
      .where("trip_id", "=", tripId)
      .executeTakeFirst();
    if (!brief || brief.version !== version) {
      throw new AppError("conflict", "The discovery brief changed before research started", 409);
    }
    const clarification = await this.database.selectFrom("discovery_clarifications")
      .select(["status", "items"])
      .where("trip_id", "=", tripId)
      .where("brief_version", "=", version)
      .executeTakeFirst();
    if (!clarification || clarification.status !== "ready") {
      throw new AppError("clarification_incomplete", "Answer the required questions before research", 409);
    }
    const questionAnswers = clarificationQuestionAnswers(storedClarifyItems(clarification.items));
    const trip = await this.tripFacts(userId, tripId);
    const rejected = await this.database.selectFrom("candidate_proposals")
      .select(["provider_place_id", "name"])
      .where("trip_id", "=", tripId)
      .where("status", "=", "rejected")
      .execute();
    // One suggestion per place (owner decision 2026-10-19): the model is told what the trip already
    // has, so it neither re-proposes nor rewrites those places, and the gate drops any it still does.
    const suggested = await this.database.selectFrom("candidate_proposals")
      .select(["provider_place_id", "name"])
      .where("trip_id", "=", tripId)
      .where("status", "in", ["pending", "accepted"])
      .execute();
    const wishlistNames = await this.database.selectFrom("trip_places")
      .select("name")
      .where("trip_id", "=", tripId)
      .where("archived_at", "is", null)
      .execute();
      await progress.start("plan");
      const stageStarted = Date.now();
      const plan = await this.model.plan({
        brief: brief.original_text,
        trip,
        questionAnswers,
      });
      if (this.placeLookup.available === false) {
        throw new AppError("provider_unavailable", "Google Places is unavailable; the existing shortlist is unchanged", 503);
      }
      const planMs = Date.now() - stageStarted;
      await progress.finish("plan");
      await progress.start("research");
      const research = await this.model.research({
        brief: plan.structuredBrief,
        request: plan.request,
        trip,
        questionAnswers,
        rejectedPlaces: [...new Set(rejected.map((row) => row.name))],
        knownPlaces: [...new Set([...suggested.map((row) => row.name), ...wishlistNames.map((row) => row.name)])],
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
      const researchMs = Date.now() - stageStarted - planMs;
      await progress.finish("research");
      await progress.start("verify");
      const verification = await verifyResearchedCandidates({
        candidates: research.candidates,
        request: plan.request,
        outputLanguage: plan.outputLanguage,
        placeLookup: this.placeLookup,
        sourceChecks: this.sourceChecks,
        rejectedProviderPlaceIds: new Set(rejected.map((row) => row.provider_place_id)),
        wishlistProviderPlaceIds: new Set(wishlist.flatMap((row) => row.provider_place_id ?? [])),
        suggestedProviderPlaceIds: new Set(suggested.map((row) => row.provider_place_id)),
        tripCountryCodes: new Set(trip.countries.map((country) => country.code)),
      }).catch((error: unknown) => {
        if (error instanceof ProviderQuotaError) throw error;
        if (error instanceof ProviderUnavailableError) {
          throw new AppError("provider_unavailable", "Google Places is unavailable; the existing shortlist is unchanged", 503);
        }
        throw error;
      });
      const verifyMs = Date.now() - stageStarted - planMs - researchMs;
      await progress.finish("verify");
      await progress.start("save");
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
      const added = await this.database.transaction().execute(async (transaction) => {
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
        // A place suggested by another run while this one researched keeps its existing row.
        const listedNow = new Set((await transaction.selectFrom("candidate_proposals")
          .select("provider_place_id").where("trip_id", "=", tripId).execute())
          .map((row) => row.provider_place_id));
        let added = 0;
        for (const { index, members, endorsements } of verification.gate.shown) {
          const { researched, place } = verification.candidates[index]!;
          // Entries merged into this place may have found the pages that vouch for it.
          const merged = members.map((member) => verification.candidates[member]!);
          if (!place || listedNow.has(place.providerPlaceId)) continue;
          listedNow.add(place.providerPlaceId);
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
          }).onConflict((conflict) => conflict.columns(["trip_id", "provider_place_id"]).doNothing())
            .returning("id").executeTakeFirst();
          // An overlapping run listed this place first: keep its row and votes.
          if (!proposal) continue;
          added += 1;
          // Owner decision 2026-10-19: a suggestion gets its place identity now, not on acceptance,
          // so the Commons pipeline can give it a list photo. Acceptance reuses this identity.
          const identity = await upsertGooglePlaceIdentity(transaction, place, this.now());
          if (!suggestionIdentityIds.includes(identity.id)) suggestionIdentityIds.push(identity.id);
          await transaction.insertInto("candidate_proposal_evidence").values(
            [...new Set(evidenceIds)].map((evidenceId) => ({ proposal_id: proposal.id, evidence_id: evidenceId })),
          ).execute();
        }
        await recordEvent(transaction, {
          tripId,
          actorId: userId,
          eventType: "discovery.generated",
          targetType: "discovery_run",
          targetId: run.id,
          summary: `Added ${added} new place proposals vouched for by two independent sources`,
        });
        // The results are visible as soon as this commits; photos follow as their own stage.
        await transaction.updateTable("discovery_jobs").set({ run_id: run.id, added_count: added })
          .where("id", "=", job.id).execute();
        return added;
      });
      await progress.finish("save");
      console.info(JSON.stringify({
        event: "discovery_run_timing",
        tripId,
        planMs,
        researchMs,
        verifyMs,
        saveMs: Date.now() - stageStarted - planMs - researchMs - verifyMs,
        researched: research.candidates.length,
        shown: verification.gate.shown.length,
      }));
      await progress.start("photos");
      const photos = await this.findSuggestionPhotos(suggestionIdentityIds);
      await progress.finish("photos", photos === "complete" ? "done" : "partial");
      // Also removes the checklist this run used (its answers were read before planning).
      await progress.succeed({ tripId, briefVersion: version });
      console.info(JSON.stringify({ event: "discovery_job_finished", jobId: job.id, tripId, added, photos }));
    } catch (error) {
      const code = error instanceof ProviderQuotaError ? "provider_quota"
        : error instanceof AppError ? error.code
          : error instanceof DiscoveryModelUnavailableError || error instanceof DiscoveryModelResponseError ? "model_unavailable"
            : "internal_error";
      console.error(JSON.stringify({
        event: "discovery_job_failed",
        jobId: job.id,
        tripId,
        code,
        errorClass: error instanceof Error ? error.constructor.name : "NonErrorThrow",
      }));
      await progress.fail(code);
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
      // One suggestion per place, so restoring it puts the place back on the 幫我找 list as pending.
      await transaction.updateTable("candidate_proposals").set({
        status: "pending",
        decided_by: null,
        decided_at: null,
        version: sql`version + 1`,
        updated_at: this.now(),
      }).where("id", "=", proposalId).execute();
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
    // A running research job is detected by discovery_jobs (startResearch), not here.
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
    const clarificationRow = briefRow
      ? await executor.selectFrom("discovery_clarifications").selectAll()
        .where("trip_id", "=", tripId).where("brief_version", "=", briefRow.version).executeTakeFirst()
      : undefined;
    const latestJobRow = await executor.selectFrom("discovery_jobs").selectAll()
      .where("trip_id", "=", tripId).orderBy("created_at", "desc").limit(1).executeTakeFirst();
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
        // Cumulative list (one suggestion per place): every pending suggestion of the trip, plus the
        // latest run's decided ones so their 已加入行程／不要再推薦 state stays visible in place.
        .where((expression) => expression.or([
          expression("run_id", "=", run.id),
          expression("status", "=", "pending"),
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
      clarification: clarificationRow ? clarificationDto(clarificationRow) : null,
      latestJob: latestJobRow ? discoveryJobDto(latestJobRow) : null,
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
