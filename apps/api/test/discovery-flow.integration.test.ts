import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { sql, type Kysely } from "kysely";

import { parseDiscoveryWorkspaceResponse } from "@along-the-way/contracts/discovery";
import { parseTripResponse } from "@along-the-way/contracts/private-trips";
import { parseTripPlaceListResponse, type ProviderPlaceCandidateDto } from "@along-the-way/contracts/trip-places";

import { createApp } from "../src/app";
import { createDatabase, type AlongTheWayDatabase } from "../src/database/database";
import { runMigrations } from "../src/database/migrate";
import { seedDatabase } from "../src/database/seed";
import type { RecommendationSourceChecks } from "../src/discovery/candidate-verification";
import type {
  DiscoveryModel,
  DiscoveryPlanResult,
  DiscoveryResearchResult,
  InterpretedDiscoveryFeedback,
} from "../src/discovery/discovery-model";
import { PostgresDiscoveryModule } from "../src/discovery/postgres-discovery-module";
import type { EmailSender } from "../src/private-trips/email-sender";
import { PostgresEmailWorker } from "../src/private-trips/postgres-email-worker";
import { PostgresIdentityAccessModule } from "../src/private-trips/postgres-identity-access-module";
import { PostgresRateLimiter } from "../src/private-trips/postgres-rate-limiter";
import { PostgresReadinessProbe } from "../src/private-trips/postgres-readiness-probe";
import { PostgresTripWorkspaceModule } from "../src/private-trips/postgres-trip-workspace-module";
import { TokenIssuer } from "../src/private-trips/token-issuer";
import { PostgresTripSkeletonModule } from "../src/trip-skeleton/postgres-trip-skeleton-module";
import type {
  PlaceProvider,
  RatedPlaceCandidate,
  RatedPlaceLookup,
} from "../src/trip-places/google-places-provider";
import { PostgresTripPlaceModule } from "../src/trip-places/postgres-trip-place-module";
import { unrelatedDayRouteModule } from "./day-route-test-support";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");

class CapturingEmailSender implements EmailSender {
  readonly magicLinks: Array<{ to: string; url: string }> = [];
  async sendMagicLink(message: { to: string; url: string }) {
    this.magicLinks.push(message);
  }
  async sendTripInvite() {}
}

const market: ProviderPlaceCandidateDto = {
  provider: "google",
  providerPlaceId: "ChIJ-Nishiki-Market-001",
  name: "Nishiki Market",
  type: "activity",
  address: "Nakagyo Ward, Kyoto",
  latitude: 35.005,
  longitude: 135.765,
  timeZone: "Asia/Tokyo",
  sourceUrl: "https://www.google.com/maps/search/?api=1&query_place_id=ChIJ-Nishiki-Market-001",
  attribution: "Google Maps",
  observedAt: "2026-09-28T12:00:00.000Z",
  expiresAt: "2026-10-28T12:00:00.000Z",
};

function place(name: string, providerPlaceId: string): ProviderPlaceCandidateDto {
  return { ...market, name, providerPlaceId, sourceUrl: null };
}

class ControlledPlaceProvider implements PlaceProvider, RatedPlaceLookup {
  readonly available = true;
  readonly attribution = "Google Maps";
  lookups: string[] = [];
  async search() {
    return [market];
  }
  async getPlace() {
    return market;
  }
  async lookup(query: string): Promise<RatedPlaceCandidate[]> {
    this.lookups.push(query);
    if (query.includes("Nishiki")) {
      return [{ candidate: market, rating: 4.4, userRatingCount: 12_000, websiteUri: "https://www.kyoto-nishiki.or.jp/" }];
    }
    if (query.includes("Tiny Cafe")) {
      // A near-perfect rating from too few reviews to count.
      return [{ candidate: place("Tiny Cafe", "ChIJ-Tiny-Cafe"), rating: 4.9, userRatingCount: 40, websiteUri: null }];
    }
    if (query.includes("Takao") || query.includes("高雄")) {
      return [{ candidate: place("Takao Kanko Hotel", "ChIJ-Takao-Hotel"), rating: 4.3, userRatingCount: 900, websiteUri: null }];
    }
    return [];
  }
}

class ControlledSourceChecks implements RecommendationSourceChecks {
  pages: string[] = [];
  wikivoyage() {
    return {
      verify: async (input: { names: readonly string[] }) => input.names.includes("Nishiki Market")
        ? { url: "https://en.wikivoyage.org/wiki/Kyoto/Central", title: "Kyoto/Central" }
        : null,
    };
  }
  async pageText(url: string) {
    this.pages.push(url);
    if (url.endsWith("/nishiki")) return "Nishiki Market, Kyoto's kitchen, is a narrow covered street of food stalls.";
    if (url.endsWith("/tiny-cafe")) return "Tiny Cafe serves hand-drip coffee near the market.";
    return null;
  }
}

class ControlledDiscoveryModel implements DiscoveryModel {
  readonly available = true;
  readonly modelId = "gpt-test";
  planCalls = 0;
  researchCalls = 0;
  /** An unexpected failure (not a model or provider error) to raise from research. */
  researchFailure: Error | null = null;
  feedbackCalls = 0;
  private releaseFirstPlan: (() => void) | null = null;
  private firstPlanStarted: (() => void) | null = null;
  readonly planStarted = new Promise<void>((resolve) => {
    this.firstPlanStarted = resolve;
  });
  private readonly planRelease = new Promise<void>((resolve) => {
    this.releaseFirstPlan = resolve;
  });
  private releaseFirstFeedback: (() => void) | null = null;
  private firstFeedbackStarted: (() => void) | null = null;
  readonly feedbackStarted = new Promise<void>((resolve) => {
    this.firstFeedbackStarted = resolve;
  });
  private readonly feedbackRelease = new Promise<void>((resolve) => {
    this.releaseFirstFeedback = resolve;
  });

  releasePlan() {
    this.releaseFirstPlan?.();
  }

  releaseFeedback() {
    this.releaseFirstFeedback?.();
  }

  async plan(): Promise<DiscoveryPlanResult> {
    this.planCalls += 1;
    if (this.planCalls === 1) {
      this.firstPlanStarted?.();
      await this.planRelease;
    }
    return {
      modelId: this.modelId,
      structuredBrief: {
        interests: ["food markets", "gardens"],
        pace: "unhurried",
        budget: null,
        exclusions: ["long walking days"],
        areas: ["Kyoto"],
      },
      unresolvedQuestions: [],
      request: {
        namedPlaces: [{ name: "Nishiki Market", area: "Kyoto" }, { name: "Saihoji", area: "Kyoto" }],
        categories: ["Food markets"],
        defaultCategories: false,
        alreadyArranged: ["Staying at an airport hotel"],
        areas: ["Kyoto"],
        exclusions: ["long walking days"],
        localLanguage: "ja",
      },
      outputLanguage: "en",
    };
  }

  async research(): Promise<DiscoveryResearchResult> {
    this.researchCalls += 1;
    if (this.researchFailure) throw this.researchFailure;
    const base = {
      area: "Kyoto",
      category: "Food markets",
      matchedNeeds: ["food markets"],
      tradeoffs: [],
      unknowns: ["holiday opening hours"],
      confidence: "medium" as const,
    };
    return {
      modelId: this.modelId,
      sources: [
        { url: "https://kyoto.example.test/nishiki", title: "Official Nishiki Market guide" },
        { url: "https://kyoto.example.test/tiny-cafe", title: "Tiny Cafe feature" },
      ],
      candidates: [
        {
          ...base,
          name: "Nishiki Market",
          localName: "錦市場",
          englishName: "Nishiki Market",
          namedPlace: "Nishiki Market",
          recommendation: "A compact food-market stop matching the trip's main interest.",
          tradeoffs: ["busy around lunch"],
          sources: [{ url: "https://kyoto.example.test/nishiki", type: "tourism_board" }],
        },
        {
          ...base,
          name: "Tiny Cafe",
          localName: null,
          englishName: null,
          namedPlace: null,
          recommendation: "A quiet coffee stop.",
          sources: [{ url: "https://kyoto.example.test/tiny-cafe", type: "tourism_board" }],
        },
        {
          ...base,
          name: "Takao",
          localName: "高雄",
          englishName: "Takao",
          namedPlace: null,
          recommendation: "Mountain temples with early autumn leaves.",
          sources: [],
        },
      ],
    };
  }

  async interpretFeedback(): Promise<InterpretedDiscoveryFeedback> {
    this.feedbackCalls += 1;
    if (this.feedbackCalls === 1) {
      this.firstFeedbackStarted?.();
      await this.feedbackRelease;
    }
    return {
      modelId: this.modelId,
      interests: ["food markets"],
      exclusions: ["too many temples"],
      pace: "unhurried",
      budget: null,
      summary: "Prioritize food markets and reduce temple stops.",
    };
  }
}

function json(value: unknown) {
  return JSON.stringify(value);
}

function sessionCookie(response: Response) {
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("Expected session cookie");
  return cookie;
}

describe("AI place discovery through HTTP and PostgreSQL", () => {
  let database: Kysely<AlongTheWayDatabase>;
  let app: Hono;
  let email: CapturingEmailSender;
  let worker: PostgresEmailWorker;
  let model: ControlledDiscoveryModel;
  let provider: ControlledPlaceProvider;
  let sourceChecks: ControlledSourceChecks;
  const now = () => new Date("2026-09-28T12:00:00.000Z");

  beforeAll(async () => {
    database = createDatabase(databaseUrl);
    await runMigrations(database);
  });

  beforeEach(async () => {
    await sql`
      truncate table
        discovery_feedback,
        candidate_proposal_evidence,
        candidate_proposals,
        discovery_evidence,
        discovery_runs,
        discovery_briefs,
        trip_place_duplicate_suggestions,
        trip_place_excluded_days,
        trip_place_desired_days,
        member_place_preferences,
        trip_place_contributions,
        itinerary_constraints,
        itinerary_endpoints,
        itinerary_items,
        trip_places,
        place_identities,
        legacy_place_origins,
        places,
        change_events,
        rate_limit_windows,
        worker_heartbeats,
        email_jobs,
        mutation_requests,
        invites,
        trip_members,
        trip_days,
        trip_country_stops,
        trip_destinations,
        trips,
        sessions,
        magic_link_tokens,
        users
      restart identity cascade
    `.execute(database);
    await seedDatabase(database, "owner@example.test");
    email = new CapturingEmailSender();
    model = new ControlledDiscoveryModel();
    provider = new ControlledPlaceProvider();
    sourceChecks = new ControlledSourceChecks();
    const tokenIssuer = new TokenIssuer("discovery-integration-secret-at-least-32-bytes");
    const identityAccess = new PostgresIdentityAccessModule({
      database,
      tokenIssuer,
      now,
      randomSessionToken: () => "discovery-session-token",
    });
    worker = new PostgresEmailWorker({
      database,
      emailSender: email,
      siteAddress: "https://app.example.test",
      tokenIssuer,
      now,
    });
    const tripPlaces = new PostgresTripPlaceModule({ database, provider, now });
    const discovery = new PostgresDiscoveryModule({
      database,
      model,
      placeLookup: provider,
      tripPlaces,
      sourceChecks,
      now,
      policyVersion: "discovery-test-v2",
    });
    app = createApp({
      dayRoutes: unrelatedDayRouteModule,
      discovery,
      identityAccess,
      rateLimiter: new PostgresRateLimiter(database, "discovery-rate-secret-at-least-32-bytes", now),
      readiness: new PostgresReadinessProbe(database, now),
      siteAddress: "https://app.example.test",
      tripPlaces,
      tripSkeleton: new PostgresTripSkeletonModule({ database, now }),
      tripWorkspace: new PostgresTripWorkspaceModule({ database, now }),
    });
  });

  afterAll(async () => {
    await database.destroy();
  });

  async function login() {
    const requested = await app.request("/api/auth/magic-links", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://app.example.test",
        "x-forwarded-for": "owner@example.test",
      },
      body: json({ email: "owner@example.test" }),
    });
    expect(requested.status).toBe(202);
    await worker.runOnce();
    const link = email.magicLinks[0]?.url;
    const token = link && new URLSearchParams(new URL(link).hash.slice(1)).get("magicToken");
    if (!token) throw new Error("Magic link missing");
    const consumed = await app.request("/api/auth/magic-links/consume", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://app.example.test" },
      body: json({ token }),
    });
    expect(consumed.status).toBe(200);
    return sessionCookie(consumed);
  }

  async function createTrip(cookie: string) {
    const response = await app.request("/api/trips", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "idempotency-key": "create-discovery-trip",
        origin: "https://app.example.test",
      },
      body: json({
        name: "Kyoto week",
        startDate: "2026-10-21",
        endDate: "2026-10-27",
        countryCodes: ["JP"],
      }),
    });
    expect(response.status).toBe(201);
    return parseTripResponse(await response.json()).trip;
  }

  function discoveryRequest(cookie: string, path: string, key: string, body: unknown) {
    return app.request(path, {
      method: path.endsWith("/brief") ? "PUT" : "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "idempotency-key": key,
        origin: "https://app.example.test",
      },
      body: json(body),
    });
  }

  it("deduplicates model cost, preserves evidence, accepts a proposal, and confirms feedback", async () => {
    const cookie = await login();
    const trip = await createTrip(cookie);
    const saved = await discoveryRequest(cookie, `/api/trips/${trip.id}/discovery/brief`, "brief-1", {
      originalText: "Food markets and gardens at an unhurried pace; avoid long walking days.",
      expectedVersion: null,
    });
    expect(saved.status).toBe(200);
    const brief = parseDiscoveryWorkspaceResponse(await saved.json()).discovery.brief;
    expect(brief?.version).toBe(1);

    const firstGeneration = discoveryRequest(cookie, `/api/trips/${trip.id}/discovery/generate`, "generate-1", {
      expectedBriefVersion: 1,
    });
    await model.planStarted;
    const duplicate = await discoveryRequest(cookie, `/api/trips/${trip.id}/discovery/generate`, "generate-1", {
      expectedBriefVersion: 1,
    });
    expect(duplicate.status).toBe(409);
    model.releasePlan();
    const generatedResponse = await firstGeneration;
    expect(generatedResponse.status).toBe(200);
    const generated = parseDiscoveryWorkspaceResponse(await generatedResponse.json()).discovery;
    expect(model.planCalls).toBe(1);
    expect(model.researchCalls).toBe(1);
    expect(generated.brief?.structured?.interests).toContain("food markets");
    // Only the place three independent sources vouch for is shown.
    expect(generated.proposals.map((entry) => [entry.name, entry.category, entry.endorsements])).toEqual([
      ["Nishiki Market", "Food markets", ["google_reviews", "wikivoyage", "official_tourism"]],
    ]);
    expect(generated.proposals[0]?.evidence.map((item) => `${item.kind}:${item.attribution}`).sort()).toEqual([
      "google-place:Google Maps",
      "web-source:Official tourism site",
      "web-source:Wikivoyage",
    ]);
    expect(generated.latestRun?.searchPlan).toMatchObject({
      categories: ["Food markets"],
      defaultCategories: false,
      namedPlaces: ["Nishiki Market", "Saihoji"],
      alreadyArranged: ["Staying at an airport hotel"],
    });
    expect(generated.latestRun?.shortfalls).toEqual([
      { code: "not_researched", subject: "Saihoji", named: true, endorsements: [], count: null },
      { code: "single_source", subject: "Tiny Cafe", named: false, endorsements: ["official_tourism"], count: null },
      { code: "name_mismatch", subject: "Takao", named: false, endorsements: [], count: null },
      { code: "category_short", subject: "Food markets", named: false, endorsements: [], count: 1 },
    ]);
    // Google's rating and review count are used to screen but never stored.
    const storedRatings = await sql<{ count: string }>`
      select count(*)::text as count from discovery_evidence
      where facts ? 'rating' or facts ? 'userRatingCount' or facts::text ilike '%12000%'
    `.execute(database);
    expect(storedRatings.rows[0]?.count).toBe("0");
    const lookupsAfterGeneration = provider.lookups.length;

    const replay = await discoveryRequest(cookie, `/api/trips/${trip.id}/discovery/generate`, "generate-1", {
      expectedBriefVersion: 1,
    });
    expect(replay.status).toBe(200);
    expect(parseDiscoveryWorkspaceResponse(await replay.json()).discovery.latestRun?.id)
      .toBe(generated.latestRun?.id);
    expect(model.planCalls).toBe(1);
    expect(provider.lookups).toHaveLength(lookupsAfterGeneration);

    const proposal = generated.proposals[0];
    if (!proposal) throw new Error("Expected proposal");
    const acceptance = () => discoveryRequest(
      cookie,
      `/api/trips/${trip.id}/discovery/proposals/${proposal.id}/accept`,
      "accept-1",
      { expectedVersion: proposal.version },
    );
    const [accepted, acceptedReplay] = await Promise.all([acceptance(), acceptance()]);
    expect(accepted.status).toBe(200);
    expect(acceptedReplay.status).toBe(200);
    const acceptedWorkspace = parseDiscoveryWorkspaceResponse(await accepted.json()).discovery;
    expect(acceptedWorkspace.proposals[0]?.status).toBe("accepted");
    expect(acceptedWorkspace.proposals[0]?.acceptedTripPlaceId).toBeTruthy();

    const placesResponse = await app.request(`/api/trips/${trip.id}/trip-places`, { headers: { cookie } });
    expect(placesResponse.status).toBe(200);
    const tripPlaces = parseTripPlaceListResponse(await placesResponse.json()).tripPlaces;
    expect(tripPlaces.map((place) => place.name)).toContain("Nishiki Market");
    expect(tripPlaces[0]?.aiProposalId).toBe(proposal.id);
    expect(tripPlaces[0]?.contributions[0]?.intakeMethod).toBe("search");

    const firstFeedback = discoveryRequest(cookie, `/api/trips/${trip.id}/discovery/feedback`, "feedback-1", {
      originalText: "Too many temples. Keep the food markets and an unhurried pace.",
      proposalId: null,
    });
    await model.feedbackStarted;
    const duplicateFeedback = await discoveryRequest(cookie, `/api/trips/${trip.id}/discovery/feedback`, "feedback-1", {
      originalText: "Too many temples. Keep the food markets and an unhurried pace.",
      proposalId: null,
    });
    expect(duplicateFeedback.status).toBe(409);
    model.releaseFeedback();
    const feedbackResponse = await firstFeedback;
    expect(feedbackResponse.status).toBe(200);
    expect(model.feedbackCalls).toBe(1);
    const pendingFeedback = parseDiscoveryWorkspaceResponse(await feedbackResponse.json()).discovery.feedback[0];
    expect(pendingFeedback?.status).toBe("pending");
    expect(pendingFeedback?.interpretation.summary).toContain("food markets");

    if (!pendingFeedback) throw new Error("Expected feedback");
    const confirmed = await discoveryRequest(
      cookie,
      `/api/trips/${trip.id}/discovery/feedback/${pendingFeedback.id}/decision`,
      "confirm-feedback-1",
      { expectedVersion: pendingFeedback.version, decision: "confirm" },
    );
    expect(confirmed.status).toBe(200);
    expect(parseDiscoveryWorkspaceResponse(await confirmed.json()).discovery.feedback[0]?.status)
      .toBe("confirmed");
  });

  it("keeps shortlists from before the quality checks readable", async () => {
    const cookie = await login();
    const trip = await createTrip(cookie);
    const owner = await database.selectFrom("users").select("id").where("email", "=", "owner@example.test")
      .executeTakeFirstOrThrow();
    const run = await database.insertInto("discovery_runs").values({
      trip_id: trip.id,
      brief_version: 1,
      policy_version: "discovery-v1",
      model_id: "gpt-old",
      status: "completed",
      search_plan: { queries: ["Kyoto food markets"], areas: ["Kyoto"], categories: ["market"], exclusions: [], dateRange: { start: "2026-10-21", end: "2026-10-27" } },
      error_code: null,
      created_by: owner.id,
      completed_at: now(),
    }).returning("id").executeTakeFirstOrThrow();
    await database.insertInto("candidate_proposals").values({
      trip_id: trip.id,
      run_id: run.id,
      provider_place_id: market.providerPlaceId,
      name: market.name,
      place_type: market.type,
      address: market.address,
      latitude: market.latitude,
      longitude: market.longitude,
      source_url: market.sourceUrl,
      recommendation: "An older recommendation.",
      matched_needs: JSON.stringify([]),
      tradeoffs: JSON.stringify([]),
      unknowns: JSON.stringify([]),
      confidence: "medium",
      status: "pending",
      accepted_trip_place_id: null,
      decided_by: null,
      decided_at: null,
    }).execute();

    const response = await app.request(`/api/trips/${trip.id}/discovery`, { headers: { cookie } });

    expect(response.status).toBe(200);
    const workspace = parseDiscoveryWorkspaceResponse(await response.json()).discovery;
    expect(workspace.latestRun).toMatchObject({
      shortfalls: [],
      searchPlan: { queries: ["Kyoto food markets"], categories: ["market"], defaultCategories: false, namedPlaces: [], alreadyArranged: [] },
    });
    expect(workspace.proposals).toEqual([expect.objectContaining({ name: "Nishiki Market", category: null, endorsements: [] })]);
  });

  it("replays a response stored before the quality checks instead of failing", async () => {
    const cookie = await login();
    const trip = await createTrip(cookie);
    const owner = await database.selectFrom("users").select("id").where("email", "=", "owner@example.test")
      .executeTakeFirstOrThrow();
    // The shape the previous release stored: no shortfalls, kinds, endorsements or named places.
    await database.insertInto("mutation_requests").values({
      actor_id: owner.id,
      operation: `discovery:generate:${trip.id}`,
      idempotency_key: "generate-before-deploy",
      response: {
        brief: null,
        latestRun: {
          id: "00000000-0000-4000-8000-000000004401", status: "completed", modelId: "gpt-old", policyVersion: "discovery-v1",
          briefVersion: 1, generatedAt: "2026-10-03T16:38:02.000Z", errorCode: null,
          searchPlan: { queries: ["Kyoto food markets"], areas: ["Kyoto"], categories: ["market"], exclusions: [], dateRange: { start: "2026-10-21", end: "2026-10-27" } },
        },
        proposals: [{
          id: "00000000-0000-4000-8000-000000004402", runId: "00000000-0000-4000-8000-000000004401",
          providerPlaceId: market.providerPlaceId, name: market.name, type: market.type, address: market.address,
          latitude: market.latitude, longitude: market.longitude, sourceUrl: market.sourceUrl,
          recommendation: "An older recommendation.", matchedNeeds: [], tradeoffs: [], unknowns: [], confidence: "medium",
          status: "pending", evidence: [], acceptedTripPlaceId: null, version: 1,
        }],
        feedback: [],
        modelAvailable: true,
        placeProviderAvailable: true,
      },
    }).execute();

    const replay = await discoveryRequest(cookie, `/api/trips/${trip.id}/discovery/generate`, "generate-before-deploy", {
      expectedBriefVersion: 1,
    });

    expect(replay.status).toBe(200);
    const workspace = parseDiscoveryWorkspaceResponse(await replay.json()).discovery;
    expect(workspace.latestRun).toMatchObject({ shortfalls: [], searchPlan: { namedPlaces: [], defaultCategories: false } });
    expect(workspace.proposals[0]).toMatchObject({ category: null, endorsements: [] });
    expect(model.planCalls).toBe(0);
  });

  it("releases the request after an unexpected failure so a retry is not stuck in progress", async () => {
    const cookie = await login();
    const trip = await createTrip(cookie);
    await discoveryRequest(cookie, `/api/trips/${trip.id}/discovery/brief`, "brief-failure", {
      originalText: "Food markets.",
      expectedVersion: null,
    });
    model.releasePlan();
    model.researchFailure = new TypeError("unexpected");
    const generate = () => discoveryRequest(cookie, `/api/trips/${trip.id}/discovery/generate`, "generate-failure", {
      expectedBriefVersion: 1,
    });

    expect((await generate()).status).toBe(500);
    const retry = await generate();

    expect(retry.status).toBe(503);
    expect(model.researchCalls).toBe(1);
  });
});
