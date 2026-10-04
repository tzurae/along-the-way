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
import type {
  DiscoveryModel,
  DiscoveryPlanResult,
  DiscoverySynthesisResult,
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
import type { PlaceProvider } from "../src/trip-places/google-places-provider";
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

class ControlledPlaceProvider implements PlaceProvider {
  readonly available = true;
  readonly attribution = "Google Maps";
  searches = 0;
  async search() {
    this.searches += 1;
    return [market];
  }
  async getPlace() {
    return market;
  }
}

class ControlledDiscoveryModel implements DiscoveryModel {
  readonly available = true;
  readonly modelId = "gpt-test";
  planCalls = 0;
  synthesisCalls = 0;
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
      searchPlan: {
        queries: ["Kyoto food markets"],
        areas: ["Kyoto"],
        categories: ["market"],
        exclusions: ["long walks"],
        dateRange: { start: "2026-10-21", end: "2026-10-27" },
      },
      outputLanguage: "en",
    };
  }

  async synthesize(): Promise<DiscoverySynthesisResult> {
    this.synthesisCalls += 1;
    return {
      modelId: this.modelId,
      sources: [{ url: "https://kyoto.example.test/nishiki", title: "Official Nishiki Market guide" }],
      candidates: [{
        providerPlaceId: market.providerPlaceId,
        recommendation: "A compact food-market stop matching the trip's main interest.",
        matchedNeeds: ["food markets", "unhurried half-day"],
        tradeoffs: ["busy around lunch"],
        unknowns: ["holiday opening hours"],
        confidence: "medium",
        sourceUrls: ["https://kyoto.example.test/nishiki"],
      }],
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
      placeProvider: provider,
      tripPlaces,
      now,
      policyVersion: "discovery-test-v1",
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
    expect(model.synthesisCalls).toBe(1);
    expect(provider.searches).toBe(1);
    expect(generated.brief?.structured?.interests).toContain("food markets");
    expect(generated.proposals).toHaveLength(1);
    expect(generated.proposals[0]?.evidence.map((item) => item.kind)).toEqual(["google-place", "web-source"]);

    const replay = await discoveryRequest(cookie, `/api/trips/${trip.id}/discovery/generate`, "generate-1", {
      expectedBriefVersion: 1,
    });
    expect(replay.status).toBe(200);
    expect(parseDiscoveryWorkspaceResponse(await replay.json()).discovery.latestRun?.id)
      .toBe(generated.latestRun?.id);
    expect(model.planCalls).toBe(1);

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
});
