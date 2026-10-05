import type {
  CandidateProposalDto,
  CreateDiscoveryFeedbackInput,
  DecideCandidateProposalInput,
  DecideDiscoveryFeedbackInput,
  DiscoveryDecisionDto,
  DiscoveryEndorsement,
  DiscoveryFeedbackDto,
  DiscoveryShortfallDto,
  DiscoveryWorkspaceDto,
  GenerateDiscoveryInput,
  SaveDiscoveryBriefInput,
} from "@along-the-way/contracts/discovery";
import { parseDiscoveryWorkspaceResponse } from "@along-the-way/contracts/discovery";
import type { ProviderPlaceCandidateDto } from "@along-the-way/contracts/trip-places";
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
import {
  defaultRecommendationSourceChecks,
  verifyResearchedCandidates,
  type RecommendationSourceChecks,
} from "./candidate-verification";
import {
  DiscoveryModelResponseError,
  DiscoveryModelUnavailableError,
  type DiscoveryModel,
  type DiscoverySearchPlan,
  type DiscoveryTripFacts,
  type InterpretedDiscoveryFeedback,
  type StructuredDiscoveryBrief,
} from "./discovery-model";
import type { DiscoveryModule } from "./discovery-module";
import {
  ProviderUnavailableError,
  type RatedPlaceLookup,
} from "../trip-places/google-places-provider";
import type { TripPlaceModule } from "../trip-places/trip-place-module";

interface PostgresDiscoveryModuleOptions {
  database: Kysely<AlongTheWayDatabase>;
  model: DiscoveryModel;
  /** Google lookups with rating and review count, used to place and screen researched candidates. */
  placeLookup: RatedPlaceLookup;
  tripPlaces: TripPlaceModule;
  sourceChecks?: RecommendationSourceChecks;
  now?: () => Date;
  policyVersion?: string;
}

const ENDORSEMENTS: readonly DiscoveryEndorsement[] = ["google_reviews", "wikivoyage", "official_tourism"];
const SHORTFALL_CODES: readonly DiscoveryShortfallDto["code"][] = [
  "not_researched", "not_found", "name_mismatch", "single_source", "category_short", "in_wishlist", "rejected",
  "permanently_closed", "temporarily_closed", "outside_trip", "no_location",
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new AppError("validation_error", "expectedVersion must be a positive integer");
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

/**
 * Workspace snapshots stored for idempotent replay before quality checks existed lack their
 * fields; a retried request replays them as "none recorded" instead of failing to parse.
 */
function upgradeStoredWorkspace(value: unknown) {
  const workspace = jsonObject(value);
  const run = workspace.latestRun === null ? null : jsonObject(workspace.latestRun);
  return {
    ...workspace,
    latestRun: run && {
      ...run,
      shortfalls: Array.isArray(run.shortfalls) ? run.shortfalls : [],
      searchPlan: { defaultCategories: false, namedPlaces: [], alreadyArranged: [], ...jsonObject(run.searchPlan) },
    },
    proposals: Array.isArray(workspace.proposals)
      ? workspace.proposals.map((proposal) => ({ category: null, endorsements: [], ...jsonObject(proposal) }))
      : workspace.proposals,
    decided: Array.isArray(workspace.decided) ? workspace.decided : [],
  };
}

function replayedWorkspace(value: unknown) {
  return parseDiscoveryWorkspaceResponse({ discovery: upgradeStoredWorkspace(value) }).discovery;
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
  private readonly tripPlaces: TripPlaceModule;
  private readonly sourceChecks: RecommendationSourceChecks;
  private readonly now: () => Date;
  private readonly policyVersion: string;

  constructor(options: PostgresDiscoveryModuleOptions) {
    this.database = options.database;
    this.model = options.model;
    this.placeLookup = options.placeLookup;
    this.tripPlaces = options.tripPlaces;
    this.sourceChecks = options.sourceChecks ?? defaultRecommendationSourceChecks;
    this.now = options.now ?? (() => new Date());
    // v2: research first, Google only places candidates, two independent sources required.
    this.policyVersion = options.policyVersion ?? "discovery-v2";
  }

  async getWorkspace(userId: string, tripId: string) {
    uuid(tripId, "tripId");
    await this.requireMember(this.database, userId, tripId);
    return this.readWorkspace(this.database, tripId);
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
      if (replay) return replayedWorkspace(replay);
      const current = await transaction.selectFrom("discovery_briefs")
        .select(["version", "original_text"])
        .where("trip_id", "=", tripId)
        .forUpdate()
        .executeTakeFirst();
      if (current) {
        const version = expectedVersion(input.expectedVersion);
        if (current.version !== version) {
          throw new AppError("conflict", "The discovery brief changed; reload before saving", 409, undefined, current.version);
        }
        await transaction.updateTable("discovery_briefs").set({
          original_text: originalText,
          structured_brief: null,
          unresolved_questions: JSON.stringify([]),
          version: sql`version + 1`,
          updated_by: userId,
          updated_at: this.now(),
        }).where("trip_id", "=", tripId).execute();
      } else {
        if (input.expectedVersion !== undefined && input.expectedVersion !== null) {
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
      const response = await this.readWorkspace(transaction, tripId);
      await remember(transaction, userId, operation, key, response);
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
    const operation = `discovery:generate:${tripId}`;
    await this.requireMember(this.database, userId, tripId);
    const earlyReplay = await replayed(this.database, userId, operation, key);
    if (earlyReplay) return aiRequestReplay(earlyReplay);
    const brief = await this.database.selectFrom("discovery_briefs")
      .select(["original_text", "version"])
      .where("trip_id", "=", tripId)
      .executeTakeFirst();
    if (!brief) throw new AppError("validation_error", "Save a discovery brief first");
    if (brief.version !== version) {
      throw new AppError("conflict", "The discovery brief changed; reload before generating", 409, undefined, brief.version);
    }
    const trip = await this.tripFacts(userId, tripId);
    const feedback = await this.confirmedFeedback(tripId);
    const rejected = await this.database.selectFrom("candidate_proposals")
      .select(["provider_place_id", "name"])
      .where("trip_id", "=", tripId)
      .where("status", "=", "rejected")
      .execute();
    const claimedReplay = await this.database.transaction().execute(async (transaction) => {
      await lockMutation(transaction, userId, operation, key);
      const existing = await replayed(transaction, userId, operation, key);
      if (existing) return existing;
      await remember(transaction, userId, operation, key, {
        type: AI_REQUEST_STATE,
        state: "in-progress",
      });
      return null;
    });
    if (claimedReplay) return aiRequestReplay(claimedReplay);
    try {
      const plan = await this.model.plan({
        brief: brief.original_text,
        trip,
        confirmedFeedback: feedback,
      });
      if (this.placeLookup.available === false) {
        throw new AppError("provider_unavailable", "Google Places is unavailable; the existing shortlist is unchanged", 503);
      }
      const research = await this.model.research({
        brief: plan.structuredBrief,
        request: plan.request,
        trip,
        confirmedFeedback: feedback,
        rejectedPlaces: [...new Set(rejected.map((row) => row.name))],
        outputLanguage: plan.outputLanguage,
      });
      // Read after research, which takes minutes, so a place accepted meanwhile is not proposed again.
      const wishlist = await this.database.selectFrom("trip_places as tripPlace")
        .innerJoin("place_identities as identity", "identity.id", "tripPlace.place_id")
        .select("identity.provider_place_id")
        .where("tripPlace.trip_id", "=", tripId)
        .where("tripPlace.archived_at", "is", null)
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
      return await this.database.transaction().execute(async (transaction) => {
        await this.requireMember(transaction, userId, tripId);
        await lockMutation(transaction, userId, operation, key);
        const replay = await replayed(transaction, userId, operation, key);
        if (replay && !isAiRequestClaim(replay)) return replayedWorkspace(replay);
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
          unresolved_questions: JSON.stringify(plan.unresolvedQuestions),
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
          const row = await transaction.insertInto("discovery_evidence").values({
            trip_id: tripId,
            run_id: run.id,
            evidence_kind: "web-source",
            provider_place_id: null,
            source_url: url,
            title,
            attribution,
            observed_at: this.now(),
            expires_at: null,
            facts: { sourceOnly: true },
          }).returning("id").executeTakeFirstOrThrow();
          webEvidence.set(url, row.id);
          return row.id;
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
            recommendation: researched.recommendation,
            matched_needs: JSON.stringify(researched.matchedNeeds),
            tradeoffs: JSON.stringify(researched.tradeoffs),
            unknowns: JSON.stringify(researched.unknowns),
            confidence: researched.confidence,
            status: "pending",
            accepted_trip_place_id: null,
            decided_by: null,
            decided_at: null,
            // A named place of no requested kind shows the kind a merged entry was found for.
            category: researched.category ?? merged.find((entry) => entry.researched.category)?.researched.category ?? null,
            endorsements: JSON.stringify(endorsements),
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
          summary: `Generated ${verification.gate.shown.length} place proposals vouched for by two independent sources`,
        });
        const response = await this.readWorkspace(transaction, tripId);
        await transaction.updateTable("mutation_requests").set({ response })
          .where("actor_id", "=", userId)
          .where("operation", "=", operation)
          .where("idempotency_key", "=", key)
          .execute();
        return response;
      });
    } catch (error) {
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

  async acceptProposal(
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
    const operation = `discovery:accept:${proposalId}`;
    await this.requireMember(this.database, userId, tripId);
    const replay = await replayed(this.database, userId, operation, key);
    if (replay) return replayedWorkspace(replay);
    const proposal = await this.database.transaction().execute(async (transaction) => {
      await this.requireMember(transaction, userId, tripId);
      await lockMutation(transaction, userId, operation, key);
      const existingReplay = await replayed(transaction, userId, operation, key);
      if (existingReplay) return null;
      const row = await transaction.selectFrom("candidate_proposals")
        .selectAll()
        .where("id", "=", proposalId)
        .where("trip_id", "=", tripId)
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw new AppError("discovery_proposal_not_found", "Candidate proposal not found", 404);
      if (row.status === "accepting" && row.version === version + 1) return row;
      if (row.status !== "pending" || row.version !== version) {
        throw new AppError("conflict", "The candidate proposal changed; reload before accepting", 409, undefined, row.version);
      }
      await transaction.updateTable("candidate_proposals").set({
        status: "accepting",
        version: sql`version + 1`,
        updated_at: this.now(),
      }).where("id", "=", proposalId).execute();
      return row;
    });
    if (!proposal) {
      const completed = await replayed(this.database, userId, operation, key);
      if (completed) return replayedWorkspace(completed);
      throw new AppError("conflict", "Candidate acceptance is already in progress", 409);
    }
    try {
      const evidence = await this.database.selectFrom("discovery_evidence as evidence")
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
        address: proposal.address,
        latitude: proposal.latitude,
        longitude: proposal.longitude,
        timeZone: typeof facts.timeZone === "string" ? facts.timeZone : null,
        sourceUrl: proposal.source_url,
        attribution: typeof facts.attribution === "string" ? facts.attribution : this.placeLookup.attribution,
        observedAt: typeof facts.observedAt === "string" ? facts.observedAt : isoTimestamp(proposal.created_at),
        expiresAt: typeof facts.expiresAt === "string" ? facts.expiresAt : isoTimestamp(this.now()),
      };
      const tripPlace = await this.tripPlaces.addObservedCandidate(
        userId,
        tripId,
        `${key}:trip-place`,
        candidate,
      );
      return await this.database.transaction().execute(async (transaction) => {
        await lockMutation(transaction, userId, operation, key);
        const existingReplay = await replayed(transaction, userId, operation, key);
        if (existingReplay) return replayedWorkspace(existingReplay);
        const updated = await transaction.updateTable("candidate_proposals").set({
          status: "accepted",
          accepted_trip_place_id: tripPlace.id,
          decided_by: userId,
          decided_at: this.now(),
          version: sql`version + 1`,
          updated_at: this.now(),
        }).where("id", "=", proposalId)
          .where("trip_id", "=", tripId)
          .where("status", "=", "accepting")
          .returning("id")
          .executeTakeFirst();
        if (!updated) throw new AppError("conflict", "Candidate acceptance state changed", 409);
        await recordEvent(transaction, {
          tripId,
          actorId: userId,
          eventType: "discovery.proposal_accepted",
          targetType: "candidate_proposal",
          targetId: proposalId,
          summary: "Accepted an AI place proposal into the shared wishlist",
        });
        const response = await this.readWorkspace(transaction, tripId);
        await remember(transaction, userId, operation, key, response);
        return response;
      });
    } catch (error) {
      await this.database.updateTable("candidate_proposals").set({
        status: "pending",
        version: sql`version + 1`,
        updated_at: this.now(),
      }).where("id", "=", proposalId).where("status", "=", "accepting").execute();
      throw error;
    }
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
    const operation = `discovery:reject:${proposalId}`;
    return this.database.transaction().execute(async (transaction) => {
      await this.requireMember(transaction, userId, tripId);
      await lockMutation(transaction, userId, operation, key);
      const replay = await replayed(transaction, userId, operation, key);
      if (replay) return replayedWorkspace(replay);
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
        summary: "Rejected an AI place proposal",
      });
      const response = await this.readWorkspace(transaction, tripId);
      await remember(transaction, userId, operation, key, response);
      return response;
    });
  }

  async createFeedback(
    userId: string,
    tripId: string,
    rawKey: string,
    input: CreateDiscoveryFeedbackInput,
  ) {
    uuid(tripId, "tripId");
    const key = requireIdempotencyKey(rawKey);
    const originalText = requiredText(input.originalText, "originalText", 2_000);
    const proposalId = input.proposalId ? uuid(input.proposalId, "proposalId") : null;
    const operation = `discovery:feedback:${tripId}`;
    await this.requireMember(this.database, userId, tripId);
    const earlyReplay = await replayed(this.database, userId, operation, key);
    if (earlyReplay) return aiRequestReplay(earlyReplay);
    const proposal = proposalId
      ? await this.database.selectFrom("candidate_proposals").select("name")
        .where("id", "=", proposalId).where("trip_id", "=", tripId).executeTakeFirst()
      : null;
    if (proposalId && !proposal) throw new AppError("discovery_proposal_not_found", "Candidate proposal not found", 404);
    const claimedReplay = await this.database.transaction().execute(async (transaction) => {
      await lockMutation(transaction, userId, operation, key);
      const existing = await replayed(transaction, userId, operation, key);
      if (existing) return existing;
      await remember(transaction, userId, operation, key, {
        type: AI_REQUEST_STATE,
        state: "in-progress",
      });
      return null;
    });
    if (claimedReplay) return aiRequestReplay(claimedReplay);
    let interpretation: InterpretedDiscoveryFeedback;
    try {
      interpretation = await this.model.interpretFeedback({ text: originalText, proposalName: proposal?.name ?? null });
    } catch (error) {
      const failure = error instanceof DiscoveryModelUnavailableError || error instanceof DiscoveryModelResponseError
        ? new AppError("model_unavailable", error.message, 503)
        : null;
      if (!failure) throw error;
      await this.database.updateTable("mutation_requests").set({
        response: {
          type: AI_REQUEST_STATE,
          state: "failed",
          code: "model_unavailable",
          message: failure.message,
        },
      })
        .where("actor_id", "=", userId)
        .where("operation", "=", operation)
        .where("idempotency_key", "=", key)
        .execute();
      throw failure;
    }
    return this.database.transaction().execute(async (transaction) => {
      await this.requireMember(transaction, userId, tripId);
      await lockMutation(transaction, userId, operation, key);
      const replay = await replayed(transaction, userId, operation, key);
      if (replay && !isAiRequestClaim(replay)) return replayedWorkspace(replay);
      const feedback = await transaction.insertInto("discovery_feedback").values({
        trip_id: tripId,
        proposal_id: proposalId,
        actor_id: userId,
        original_text: originalText,
        interpretation: {
          interests: interpretation.interests,
          exclusions: interpretation.exclusions,
          pace: interpretation.pace,
          budget: interpretation.budget,
          summary: interpretation.summary,
        },
        status: "pending",
        decided_at: null,
      }).returning("id").executeTakeFirstOrThrow();
      await recordEvent(transaction, {
        tripId,
        actorId: userId,
        eventType: "discovery.feedback_interpreted",
        targetType: "discovery_feedback",
        targetId: feedback.id,
        summary: "Interpreted discovery feedback for member confirmation",
      });
      const response = await this.readWorkspace(transaction, tripId);
      await transaction.updateTable("mutation_requests").set({ response })
        .where("actor_id", "=", userId)
        .where("operation", "=", operation)
        .where("idempotency_key", "=", key)
        .execute();
      return response;
    });
  }

  async decideFeedback(
    userId: string,
    tripId: string,
    feedbackId: string,
    rawKey: string,
    input: DecideDiscoveryFeedbackInput,
  ) {
    uuid(tripId, "tripId");
    uuid(feedbackId, "feedbackId");
    const key = requireIdempotencyKey(rawKey);
    const version = expectedVersion(input.expectedVersion);
    if (input.decision !== "confirm" && input.decision !== "reject") {
      throw new AppError("validation_error", "decision must be confirm or reject");
    }
    const operation = `discovery:feedback-decision:${feedbackId}`;
    return this.database.transaction().execute(async (transaction) => {
      await this.requireMember(transaction, userId, tripId);
      await lockMutation(transaction, userId, operation, key);
      const replay = await replayed(transaction, userId, operation, key);
      if (replay) return replayedWorkspace(replay);
      const updated = await transaction.updateTable("discovery_feedback").set({
        status: input.decision === "confirm" ? "confirmed" : "rejected",
        decided_at: this.now(),
        version: sql`version + 1`,
        updated_at: this.now(),
      }).where("id", "=", feedbackId)
        .where("trip_id", "=", tripId)
        .where("actor_id", "=", userId)
        .where("status", "=", "pending")
        .where("version", "=", version)
        .returning("id")
        .executeTakeFirst();
      if (!updated) {
        const current = await transaction.selectFrom("discovery_feedback").select(["version", "actor_id"])
          .where("id", "=", feedbackId).where("trip_id", "=", tripId).executeTakeFirst();
        if (!current) throw new AppError("discovery_feedback_not_found", "Discovery feedback not found", 404);
        if (current.actor_id !== userId) throw new AppError("forbidden", "Only the feedback author can decide it", 403);
        throw new AppError("conflict", "The discovery feedback changed; reload before deciding", 409, undefined, current.version);
      }
      await recordEvent(transaction, {
        tripId,
        actorId: userId,
        eventType: input.decision === "confirm" ? "discovery.feedback_confirmed" : "discovery.feedback_rejected",
        targetType: "discovery_feedback",
        targetId: feedbackId,
        summary: input.decision === "confirm" ? "Confirmed interpreted discovery feedback" : "Rejected interpreted discovery feedback",
      });
      const response = await this.readWorkspace(transaction, tripId);
      await remember(transaction, userId, operation, key, response);
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

  private async confirmedFeedback(tripId: string) {
    const rows = await this.database.selectFrom("discovery_feedback")
      .select(["original_text", "interpretation"])
      .where("trip_id", "=", tripId)
      .where("status", "=", "confirmed")
      .orderBy("created_at")
      .execute();
    return rows.map((row) => `${row.original_text}\nInterpretation: ${JSON.stringify(row.interpretation)}`);
  }

  private async readWorkspace(
    executor: DatabaseExecutor,
    tripId: string,
  ): Promise<DiscoveryWorkspaceDto> {
    const briefRow = await executor.selectFrom("discovery_briefs").selectAll()
      .where("trip_id", "=", tripId).executeTakeFirst();
    const run = await executor.selectFrom("discovery_runs").selectAll()
      .where("trip_id", "=", tripId)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .executeTakeFirst();
    const proposalRows = run
      ? await executor.selectFrom("candidate_proposals").selectAll()
        .where("run_id", "=", run.id)
        .orderBy("created_at")
        .orderBy("id")
        .execute()
      : [];
    const proposalIds = proposalRows.map((proposal) => proposal.id);
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
      if (row.status === "accepted" && row.accepted_place_archived_at) continue;
      if ((row.status === "accepted" || row.status === "rejected") && row.decided_at) {
        decided.push({
          proposalId: row.id,
          providerPlaceId: row.provider_place_id,
          name: row.name,
          status: row.status,
          decidedAt: isoTimestamp(row.decided_at),
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
    for (const row of evidenceRows) {
      const values = evidenceByProposal.get(row.proposal_id) ?? [];
      values.push({
        id: row.id,
        kind: row.evidence_kind,
        providerPlaceId: row.provider_place_id,
        sourceUrl: row.source_url,
        title: row.title,
        attribution: row.attribution,
        observedAt: isoTimestamp(row.observed_at),
        expiresAt: row.expires_at ? isoTimestamp(row.expires_at) : null,
      });
      evidenceByProposal.set(row.proposal_id, values);
    }
    const feedbackRows = await executor.selectFrom("discovery_feedback").selectAll()
      .where("trip_id", "=", tripId)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .execute();
    return {
      brief: briefRow ? {
        originalText: briefRow.original_text,
        structured: briefRow.structured_brief ? this.readStructuredBrief(briefRow.structured_brief) : null,
        unresolvedQuestions: jsonStrings(briefRow.unresolved_questions),
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
      proposals: proposalRows.map((proposal) => ({
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
        matchedNeeds: jsonStrings(proposal.matched_needs),
        tradeoffs: jsonStrings(proposal.tradeoffs),
        unknowns: jsonStrings(proposal.unknowns),
        confidence: proposal.confidence,
        status: proposal.status,
        evidence: evidenceByProposal.get(proposal.id) ?? [],
        acceptedTripPlaceId: proposal.accepted_trip_place_id,
        version: proposal.version,
        category: proposal.category,
        endorsements: this.readEndorsements(proposal.endorsements),
      })),
      decided,
      feedback: feedbackRows.map((feedback): DiscoveryFeedbackDto => {
        const interpretation = jsonObject(feedback.interpretation);
        return {
          id: feedback.id,
          proposalId: feedback.proposal_id,
          originalText: feedback.original_text,
          interpretation: {
            interests: jsonStrings(interpretation.interests),
            exclusions: jsonStrings(interpretation.exclusions),
            pace: typeof interpretation.pace === "string" ? interpretation.pace : null,
            budget: typeof interpretation.budget === "string" ? interpretation.budget : null,
            summary: typeof interpretation.summary === "string" ? interpretation.summary : "",
          },
          status: feedback.status,
          version: feedback.version,
          createdAt: isoTimestamp(feedback.created_at),
        };
      }),
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
