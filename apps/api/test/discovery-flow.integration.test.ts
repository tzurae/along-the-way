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
import { unrelatedDayPlanModule } from "./day-plan-test-support";

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
  /** Further places Google knows, by name: well reviewed and, unless overridden, open, in Japan, with coordinates. */
  readonly known = new Map<string, {
    businessStatus?: RatedPlaceCandidate["businessStatus"];
    countryCode?: string;
    located?: boolean;
  }>();
  async search() {
    return [market];
  }
  async getPlace() {
    return market;
  }
  async lookup(query: string): Promise<RatedPlaceCandidate[]> {
    this.lookups.push(query);
    const open = { businessStatus: "operational" as const, countryCode: "JP" };
    const known = [...this.known.keys()].find((name) => query.includes(name));
    if (known) {
      const facts = this.known.get(known)!;
      const candidate = place(known, `ChIJ-${known.replaceAll(" ", "-")}`);
      return [{
        candidate: facts.located === false ? { ...candidate, latitude: null, longitude: null } : candidate,
        rating: 4.5,
        userRatingCount: 1_000,
        websiteUri: null,
        businessStatus: facts.businessStatus ?? open.businessStatus,
        countryCode: facts.countryCode ?? open.countryCode,
      }];
    }
    if (query.includes("Nishiki")) {
      return [{ candidate: market, rating: 4.4, userRatingCount: 12_000, websiteUri: "https://www.kyoto-nishiki.or.jp/", ...open }];
    }
    if (query.includes("Tiny Cafe")) {
      // A near-perfect rating from too few reviews to count.
      return [{ candidate: place("Tiny Cafe", "ChIJ-Tiny-Cafe"), rating: 4.9, userRatingCount: 40, websiteUri: null, ...open }];
    }
    if (query.includes("Takao") || query.includes("高雄")) {
      return [{ candidate: place("Takao Kanko Hotel", "ChIJ-Takao-Hotel"), rating: 4.3, userRatingCount: 900, websiteUri: null, ...open }];
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
    if (url.endsWith("/gardens")) {
      return "Kyoto's gardens: Gion Garden, Okazaki Garden, Shoren Garden, Ruined Garden, Seoul Garden and Floating Garden.";
    }
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
  /** When set, research finds exactly these places, each cited by an official tourism page. */
  researchedPlaces: string[] | null = null;
  feedbackCalls = 0;
  readonly planInputs: Array<Parameters<DiscoveryModel["plan"]>[0]> = [];
  readonly researchInputs: Array<Parameters<DiscoveryModel["research"]>[0]> = [];
  readonly feedbackInputs: Array<Parameters<DiscoveryModel["interpretFeedback"]>[0]> = [];
  unresolvedQuestions: string[] = [];
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

  async plan(input: Parameters<DiscoveryModel["plan"]>[0]): Promise<DiscoveryPlanResult> {
    this.planInputs.push(input);
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
      unresolvedQuestions: this.unresolvedQuestions,
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

  async research(input: Parameters<DiscoveryModel["research"]>[0]): Promise<DiscoveryResearchResult> {
    this.researchInputs.push(input);
    this.researchCalls += 1;
    if (this.researchFailure) throw this.researchFailure;
    if (this.researchedPlaces) {
      return {
        modelId: this.modelId,
        sources: [{ url: "https://kyoto.example.test/gardens", title: "Official Kyoto gardens guide" }],
        candidates: this.researchedPlaces.map((name) => ({
          name,
          localName: null,
          englishName: null,
          namedPlace: null,
          area: "Kyoto",
          category: "Food markets",
          matchedNeeds: ["gardens"],
          tradeoffSentences: [],
          unknowns: [],
          confidence: "medium" as const,
          recommendationSentences: [{
            text: `${name} is a quiet garden.`,
            sourceUrls: ["https://kyoto.example.test/gardens"],
          }],
          sources: [{ url: "https://kyoto.example.test/gardens", type: "tourism_board" as const }],
        })),
      };
    }
    const base = {
      area: "Kyoto",
      category: "Food markets",
      matchedNeeds: ["food markets"],
      tradeoffSentences: [],
      unknowns: ["holiday opening hours"],
      confidence: "medium" as const,
    };
    return {
      modelId: this.modelId,
      sources: [
        { url: "https://kyoto.example.test/nishiki", title: "Official Nishiki Market guide" },
        { url: "https://travel.example.test/nishiki-crowds", title: "When to visit Nishiki Market" },
        { url: "https://kyoto.example.test/tiny-cafe", title: "Tiny Cafe feature" },
      ],
      candidates: [
        {
          ...base,
          name: "Nishiki Market",
          localName: "錦市場",
          englishName: "Nishiki Market",
          namedPlace: "Nishiki Market",
          recommendationSentences: [{
            text: "A compact food-market stop matching the trip's main interest.",
            sourceUrls: ["https://kyoto.example.test/nishiki"],
          }],
          tradeoffSentences: [{
            text: "Busy around lunch.",
            sourceUrls: ["https://travel.example.test/nishiki-crowds"],
          }],
          sources: [{ url: "https://kyoto.example.test/nishiki", type: "tourism_board" }],
        },
        {
          ...base,
          name: "Tiny Cafe",
          localName: null,
          englishName: null,
          namedPlace: null,
          recommendationSentences: [{
            text: "A quiet coffee stop.",
            sourceUrls: ["https://kyoto.example.test/tiny-cafe"],
          }],
          sources: [{ url: "https://kyoto.example.test/tiny-cafe", type: "tourism_board" }],
        },
        {
          ...base,
          name: "Takao",
          localName: "高雄",
          englishName: "Takao",
          namedPlace: null,
          recommendationSentences: [{ text: "Mountain temples with early autumn leaves.", sourceUrls: [] }],
          sources: [],
        },
      ],
    };
  }

  async interpretFeedback(
    input: Parameters<DiscoveryModel["interpretFeedback"]>[0],
  ): Promise<InterpretedDiscoveryFeedback> {
    this.feedbackInputs.push(input);
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
      randomSessionToken: (() => {
        let sessions = 0;
        return () => `discovery-session-token-${sessions += 1}`;
      })(),
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
      dayPlans: unrelatedDayPlanModule,
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

  async function login(address = "owner@example.test") {
    const requested = await app.request("/api/auth/magic-links", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://app.example.test",
        "x-forwarded-for": address,
      },
      body: json({ email: address }),
    });
    expect(requested.status).toBe(202);
    await worker.runOnce();
    const link = email.magicLinks.at(-1)?.url;
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

  async function createTrip(cookie: string, name = "Kyoto week") {
    const response = await app.request("/api/trips", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "idempotency-key": `create-discovery-trip-${name}`,
        origin: "https://app.example.test",
      },
      body: json({
        name,
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
      method: path.includes("/discovery/brief") ? "PUT" : "POST",
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
      "web-source:travel.example.test",
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
      originalText: "This place looks too crowded. Keep the food focus and slow pace.",
      proposalId: proposal.id,
    });
    await model.feedbackStarted;
    const duplicateFeedback = await discoveryRequest(cookie, `/api/trips/${trip.id}/discovery/feedback`, "feedback-1", {
      originalText: "This place looks too crowded. Keep the food focus and slow pace.",
      proposalId: proposal.id,
    });
    expect(duplicateFeedback.status).toBe(409);
    model.releaseFeedback();
    const feedbackResponse = await firstFeedback;
    expect(feedbackResponse.status).toBe(200);
    expect(model.feedbackCalls).toBe(1);
    expect(model.feedbackInputs).toEqual([{
      text: "This place looks too crowded. Keep the food focus and slow pace.",
      proposalName: "Nishiki Market",
    }]);
    const pendingFeedback = parseDiscoveryWorkspaceResponse(await feedbackResponse.json()).discovery.feedback[0];
    expect(pendingFeedback).toMatchObject({
      proposalId: proposal.id,
      proposalName: "Nishiki Market",
      status: "pending",
      isOwn: true,
      interpretationEdited: false,
    });

    await database.insertInto("users").values({
      email: "feedback-editor@example.test", display_name: "feedback editor", status: "active", created_at: now(), updated_at: now(),
    }).execute();
    const otherCookie = await login("feedback-editor@example.test");
    const other = await database.selectFrom("users").select("id")
      .where("email", "=", "feedback-editor@example.test").executeTakeFirstOrThrow();
    await database.insertInto("trip_members").values({
      trip_id: trip.id, user_id: other.id, role: "editor", removed_at: null,
    }).execute();
    const otherWorkspaceResponse = await app.request(`/api/trips/${trip.id}/discovery`, { headers: { cookie: otherCookie } });
    expect(otherWorkspaceResponse.status).toBe(200);
    expect(parseDiscoveryWorkspaceResponse(await otherWorkspaceResponse.json()).discovery.feedback[0]?.isOwn).toBe(false);

    if (!pendingFeedback) throw new Error("Expected feedback");
    const editedInterpretation = {
      interests: ["covered food markets"],
      exclusions: ["crowded places"],
      pace: "one main stop per day",
      budget: "moderate",
      summary: "Prefer quieter covered markets and keep each day slow.",
    };
    const refused = await discoveryRequest(
      otherCookie,
      `/api/trips/${trip.id}/discovery/feedback/${pendingFeedback.id}/decision`,
      "other-confirm-feedback-1",
      { expectedVersion: pendingFeedback.version, decision: "confirm", interpretation: editedInterpretation },
    );
    expect(refused.status).toBe(403);

    const confirmed = await discoveryRequest(
      cookie,
      `/api/trips/${trip.id}/discovery/feedback/${pendingFeedback.id}/decision`,
      "confirm-feedback-1",
      { expectedVersion: pendingFeedback.version, decision: "confirm", interpretation: editedInterpretation },
    );
    expect(confirmed.status).toBe(200);
    const confirmedFeedback = parseDiscoveryWorkspaceResponse(await confirmed.json()).discovery.feedback[0];
    expect(confirmedFeedback).toMatchObject({
      originalText: "This place looks too crowded. Keep the food focus and slow pace.",
      interpretation: editedInterpretation,
      interpretationEdited: true,
      isOwn: true,
    });

    const regenerated = await discoveryRequest(cookie, `/api/trips/${trip.id}/discovery/generate`, "generate-with-feedback", {
      expectedBriefVersion: generated.brief?.version,
    });
    expect(regenerated.status).toBe(200);
    expect(model.planInputs.at(-1)?.confirmedFeedback).toHaveLength(1);
    expect(model.planInputs.at(-1)?.confirmedFeedback[0]).toContain("Place: Nishiki Market");
    expect(model.planInputs.at(-1)?.confirmedFeedback[0]).toContain("Member-corrected interpretation (authoritative; overrides original text)");
    expect(model.planInputs.at(-1)?.confirmedFeedback[0]).toContain("Prefer quieter covered markets and keep each day slow.");
    expect(model.planInputs.at(-1)?.confirmedFeedback[0]).not.toContain("Original:");
    expect(model.researchInputs.at(-1)?.confirmedFeedback).toEqual(model.planInputs.at(-1)?.confirmedFeedback);
  });

  it("persists answered and skipped questions for model inputs and clears them when the brief changes", async () => {
    const cookie = await login();
    const trip = await createTrip(cookie);
    const questions = ["Indoor or outdoor markets?", "How much walking is acceptable?"];
    model.unresolvedQuestions = questions;
    model.releasePlan();
    const saved = await discoveryRequest(cookie, `/api/trips/${trip.id}/discovery/brief`, "question-brief", {
      originalText: "Recommend food markets in Kyoto.",
      expectedVersion: null,
    });
    expect(saved.status).toBe(200);
    const generatedResponse = await discoveryRequest(cookie, `/api/trips/${trip.id}/discovery/generate`, "question-generate-1", {
      expectedBriefVersion: 1,
    });
    expect(generatedResponse.status).toBe(200);
    const generated = parseDiscoveryWorkspaceResponse(await generatedResponse.json()).discovery;
    expect(generated.brief).toMatchObject({ unresolvedQuestions: questions, questionAnswers: [], version: 1 });

    const answers = [
      { question: questions[0]!, answer: "Indoor markets" },
      { question: questions[1]!, answer: null },
    ];
    const answeredResponse = await discoveryRequest(
      cookie,
      `/api/trips/${trip.id}/discovery/brief/questions`,
      "question-answers",
      { expectedVersion: generated.brief?.version, answers },
    );
    expect(answeredResponse.status).toBe(200);
    const answered = parseDiscoveryWorkspaceResponse(await answeredResponse.json()).discovery;
    expect(answered.brief).toMatchObject({ questionAnswers: answers, version: 2 });

    const reloadedResponse = await app.request(`/api/trips/${trip.id}/discovery`, { headers: { cookie } });
    expect(reloadedResponse.status).toBe(200);
    expect(parseDiscoveryWorkspaceResponse(await reloadedResponse.json()).discovery.brief?.questionAnswers).toEqual(answers);

    const researchedResponse = await discoveryRequest(cookie, `/api/trips/${trip.id}/discovery/generate`, "question-generate-2", {
      expectedBriefVersion: 2,
    });
    expect(researchedResponse.status).toBe(200);
    expect(model.planInputs.at(-1)?.questionAnswers).toEqual(answers);
    expect(model.researchInputs.at(-1)?.questionAnswers).toEqual(answers);
    expect(parseDiscoveryWorkspaceResponse(await researchedResponse.json()).discovery.brief).toMatchObject({
      unresolvedQuestions: [],
      questionAnswers: answers,
    });

    const changedResponse = await discoveryRequest(cookie, `/api/trips/${trip.id}/discovery/brief`, "changed-question-brief", {
      originalText: "Recommend quiet gardens instead.",
      expectedVersion: 2,
    });
    expect(changedResponse.status).toBe(200);
    expect(parseDiscoveryWorkspaceResponse(await changedResponse.json()).discovery.brief).toMatchObject({
      originalText: "Recommend quiet gardens instead.",
      unresolvedQuestions: [],
      questionAnswers: [],
      version: 3,
    });
  });

  it("links generated claim sentences to evidence from their run and reports stale evidence", async () => {
    const cookie = await login();
    const trip = await createTrip(cookie);
    expect((await discoveryRequest(cookie, `/api/trips/${trip.id}/discovery/brief`, "claim-brief", {
      originalText: "Food markets at an unhurried pace.",
      expectedVersion: null,
    })).status).toBe(200);
    const generation = discoveryRequest(cookie, `/api/trips/${trip.id}/discovery/generate`, "claim-run", {
      expectedBriefVersion: 1,
    });
    await model.planStarted;
    model.releasePlan();
    const generatedResponse = await generation;
    expect(generatedResponse.status).toBe(200);
    const generated = parseDiscoveryWorkspaceResponse(await generatedResponse.json()).discovery;
    const proposal = generated.proposals[0];
    if (!proposal) throw new Error("Expected proposal");

    expect(proposal.recommendationSentences).toEqual([{
      text: "A compact food-market stop matching the trip's main interest.",
      evidenceIds: [expect.any(String)],
    }]);
    expect(proposal.tradeoffSentences).toEqual([{
      text: "Busy around lunch.",
      evidenceIds: [expect.any(String)],
    }]);
    expect(proposal.recommendation).toBe("A compact food-market stop matching the trip's main interest.");
    expect(proposal.tradeoffs).toEqual(["Busy around lunch."]);
    const evidenceIds = new Set(proposal.evidence.map((item) => item.id));
    const citedIds = [
      ...(proposal.recommendationSentences ?? []),
      ...(proposal.tradeoffSentences ?? []),
    ].flatMap((sentence) => sentence.evidenceIds);
    expect(citedIds).toHaveLength(2);
    expect(citedIds.every((id) => evidenceIds.has(id))).toBe(true);
    expect(proposal.evidence.filter((item) => item.kind === "web-source")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceUrl: "https://kyoto.example.test/nishiki",
          expiresAt: "2026-10-28T12:00:00.000Z",
          isStale: false,
        }),
        expect.objectContaining({
          sourceUrl: "https://travel.example.test/nishiki-crowds",
          title: "When to visit Nishiki Market",
          attribution: "travel.example.test",
          expiresAt: "2026-10-28T12:00:00.000Z",
          isStale: false,
        }),
      ]),
    );
    const linkedEvidence = await database.selectFrom("candidate_proposal_evidence as link")
      .innerJoin("discovery_evidence as evidence", "evidence.id", "link.evidence_id")
      .select(["evidence.id", "evidence.run_id"])
      .where("link.proposal_id", "=", proposal.id)
      .execute();
    expect(linkedEvidence.map((item) => item.id)).toEqual(expect.arrayContaining(citedIds));
    expect(new Set(linkedEvidence.map((item) => item.run_id))).toEqual(new Set([proposal.runId]));

    await database.updateTable("discovery_evidence")
      .set({ expires_at: "2026-09-27T12:00:00.000Z" })
      .where("run_id", "=", proposal.runId)
      .where("evidence_kind", "=", "google-place")
      .execute();
    await database.updateTable("discovery_evidence")
      .set({ observed_at: "2026-08-27T12:00:00.000Z", expires_at: null })
      .where("run_id", "=", proposal.runId)
      .where("evidence_kind", "=", "web-source")
      .execute();
    const refreshedResponse = await app.request(`/api/trips/${trip.id}/discovery`, { headers: { cookie } });
    expect(refreshedResponse.status).toBe(200);
    const refreshed = parseDiscoveryWorkspaceResponse(await refreshedResponse.json()).discovery.proposals[0];
    expect(refreshed?.evidence).not.toHaveLength(0);
    expect(refreshed?.evidence.every((item) => item.isStale)).toBe(true);
  });

  it("keeps earlier decisions after a new run and never proposes those places again", async () => {
    const cookie = await login();
    const trip = await createTrip(cookie);
    model.releasePlan();
    for (const name of ["Gion Garden", "Okazaki Garden", "Shoren Garden"]) provider.known.set(name, {});
    expect((await discoveryRequest(cookie, `/api/trips/${trip.id}/discovery/brief`, "decided-brief", {
      originalText: "Quiet gardens.",
      expectedVersion: null,
    })).status).toBe(200);
    const generate = async (key: string) => {
      const response = await discoveryRequest(cookie, `/api/trips/${trip.id}/discovery/generate`, key, {
        expectedBriefVersion: 1,
      });
      expect(response.status).toBe(200);
      return parseDiscoveryWorkspaceResponse(await response.json()).discovery;
    };
    const decide = async (proposal: { id: string; version: number }, decision: "accept" | "reject") => {
      const response = await discoveryRequest(
        cookie,
        `/api/trips/${trip.id}/discovery/proposals/${proposal.id}/${decision}`,
        `${decision}-${proposal.id}`,
        { expectedVersion: proposal.version },
      );
      expect(response.status).toBe(200);
    };

    model.researchedPlaces = ["Gion Garden", "Okazaki Garden"];
    const first = await generate("decided-run-1");
    const byName = new Map(first.proposals.map((proposal) => [proposal.name, proposal]));
    // Proposals created together have no defined order.
    expect([...byName.keys()].sort()).toEqual(["Gion Garden", "Okazaki Garden"]);
    await decide(byName.get("Gion Garden")!, "accept");
    await decide(byName.get("Okazaki Garden")!, "reject");

    // The second run finds both again, plus one new garden.
    model.researchedPlaces = ["Gion Garden", "Okazaki Garden", "Shoren Garden"];
    const second = await generate("decided-run-2");
    expect(second.proposals.map((proposal) => [proposal.name, proposal.status])).toEqual([["Shoren Garden", "pending"]]);
    expect(second.latestRun?.shortfalls.filter((entry) => entry.code === "in_wishlist" || entry.code === "rejected"))
      .toEqual([
        { code: "in_wishlist", subject: "Gion Garden", named: false, endorsements: [], count: null },
        { code: "rejected", subject: "Okazaki Garden", named: false, endorsements: [], count: null },
      ]);
    // The two decided places passed the checks, so the kind is not reported as short.
    expect(second.latestRun?.shortfalls.some((entry) => entry.code === "category_short")).toBe(false);
    const decided = second.decided.map((entry) => [entry.name, entry.status]);
    expect(decided).toEqual(expect.arrayContaining([["Gion Garden", "accepted"], ["Okazaki Garden", "rejected"]]));
    expect(decided).toHaveLength(2);
    expect(second.decided.map((entry) => entry.proposalId).sort())
      .toEqual([byName.get("Gion Garden")!.id, byName.get("Okazaki Garden")!.id].sort());

    // A reload shows the same thing.
    const reloaded = await app.request(`/api/trips/${trip.id}/discovery`, { headers: { cookie } });
    expect(reloaded.status).toBe(200);
    const workspace = parseDiscoveryWorkspaceResponse(await reloaded.json()).discovery;
    expect(workspace.proposals.map((proposal) => proposal.name)).toEqual(["Shoren Garden"]);
    expect(workspace.decided).toEqual(second.decided);

    // Taken off the wishlist again, the accepted place is no longer a decision to keep.
    const listed = await app.request(`/api/trips/${trip.id}/trip-places`, { headers: { cookie } });
    const gion = parseTripPlaceListResponse(await listed.json()).tripPlaces.find((entry) => entry.name === "Gion Garden")!;
    const withdrawn = await discoveryRequest(
      cookie,
      `/api/trips/${trip.id}/trip-places/${gion.id}/contributions/${gion.contributions[0]!.id}/withdraw`,
      "withdraw-gion",
      {},
    );
    expect(withdrawn.status).toBe(200);
    const afterWithdrawal = await app.request(`/api/trips/${trip.id}/discovery`, { headers: { cookie } });
    expect(parseDiscoveryWorkspaceResponse(await afterWithdrawal.json()).discovery.decided
      .map((entry) => [entry.name, entry.status])).toEqual([["Okazaki Garden", "rejected"]]);
  });

  it("never proposes a closed, foreign or unmapped place, and keeps Google's facts out of storage", async () => {
    const cookie = await login();
    const trip = await createTrip(cookie);
    model.releasePlan();
    provider.known
      .set("Shoren Garden", {})
      .set("Ruined Garden", { businessStatus: "closed_permanently" })
      .set("Seoul Garden", { countryCode: "KR" })
      .set("Floating Garden", { located: false });
    expect((await discoveryRequest(cookie, `/api/trips/${trip.id}/discovery/brief`, "feasible-brief", {
      originalText: "Quiet gardens.",
      expectedVersion: null,
    })).status).toBe(200);
    // Each place is reviewed on Google and named by an official page: only Google's facts rule some out.
    model.researchedPlaces = ["Shoren Garden", "Ruined Garden", "Seoul Garden", "Floating Garden"];
    const response = await discoveryRequest(cookie, `/api/trips/${trip.id}/discovery/generate`, "feasible-run", {
      expectedBriefVersion: 1,
    });
    expect(response.status).toBe(200);
    const workspace = parseDiscoveryWorkspaceResponse(await response.json()).discovery;

    expect(workspace.proposals.map((proposal) => proposal.name)).toEqual(["Shoren Garden"]);
    const ruledOut = ["permanently_closed", "temporarily_closed", "outside_trip", "no_location"];
    expect(workspace.latestRun?.shortfalls.filter((entry) => ruledOut.includes(entry.code))).toEqual([
      { code: "permanently_closed", subject: "Ruined Garden", named: false, endorsements: [], count: null },
      { code: "outside_trip", subject: "Seoul Garden", named: false, endorsements: [], count: null },
      { code: "no_location", subject: "Floating Garden", named: false, endorsements: [], count: null },
    ]);
    // The facts come with the lookups the run already makes: one per place.
    expect(provider.lookups).toHaveLength(4);
    // Business status and country are used to screen, never stored.
    const stored = await sql<{ count: string }>`
      select count(*)::text as count from discovery_evidence
      where facts::text ilike '%businessStatus%' or facts::text ilike '%closed_permanently%'
        or facts::text ilike '%countryCode%' or facts::text ilike '%"KR"%'
    `.execute(database);
    expect(stored.rows[0]?.count).toBe("0");
  });

  it("runs one research per trip at a time and caps research per trip and per member each hour", async () => {
    const cookie = await login();
    const trip = await createTrip(cookie);
    await database.insertInto("users").values({
      email: "second@example.test", display_name: "second", status: "active", created_at: now(), updated_at: now(),
    }).execute();
    const secondCookie = await login("second@example.test");
    const second = await database.selectFrom("users").select("id").where("email", "=", "second@example.test").executeTakeFirstOrThrow();
    await database.insertInto("trip_members").values({ trip_id: trip.id, user_id: second.id, role: "editor", removed_at: null }).execute();
    provider.known.set("Shoren Garden", {});
    model.researchedPlaces = ["Shoren Garden"];
    const saveBrief = async (tripId: string) => expect((await discoveryRequest(cookie, `/api/trips/${tripId}/discovery/brief`, `limit-brief-${tripId}`, {
      originalText: "Quiet gardens.",
      expectedVersion: null,
    })).status).toBe(200);
    const generate = (who: string, key: string, tripId = trip.id) =>
      discoveryRequest(who, `/api/trips/${tripId}/discovery/generate`, key, { expectedBriefVersion: 1 });
    await saveBrief(trip.id);

    // The owner's research is still running when the second member asks: no second paid run.
    const first = generate(cookie, "limit-run-1");
    await model.planStarted;
    const blocked = await generate(secondCookie, "limit-second");
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: { code: "research_in_progress" } });
    // The same trip spelled in capitals is still the same trip.
    const blockedUpper = await generate(secondCookie, "limit-second-upper", trip.id.toUpperCase());
    expect(blockedUpper.status).toBe(409);
    model.releasePlan();
    expect((await first).status).toBe(200);
    expect(model.planCalls).toBe(1);
    // Once it finished, the same request goes through.
    expect((await generate(secondCookie, "limit-second")).status).toBe(200);

    // Six runs on the trip within the hour: the seventh is refused before any model call.
    for (const key of ["limit-run-3", "limit-run-4", "limit-run-5", "limit-run-6"]) {
      expect((await generate(cookie, key)).status).toBe(200);
    }
    const plansAtTripLimit = model.planCalls;
    const seventh = await generate(cookie, "limit-run-7");
    expect(seventh.status).toBe(429);
    expect(seventh.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(await seventh.json()).toMatchObject({ error: { code: "research_limit_reached" } });
    expect(model.planCalls).toBe(plansAtTripLimit);
    // A retry of a finished request is answered from what it already returned.
    expect((await generate(cookie, "limit-run-3")).status).toBe(200);
    expect(model.planCalls).toBe(plansAtTripLimit);

    // The owner started five of those; five more on another trip reach the per-member cap of ten.
    const other = await createTrip(cookie, "Osaka week");
    await saveBrief(other.id);
    for (const key of ["other-run-1", "other-run-2", "other-run-3", "other-run-4", "other-run-5"]) {
      expect((await generate(cookie, key, other.id)).status).toBe(200);
    }
    const eleventh = await generate(cookie, "other-run-6", other.id);
    expect(eleventh.status).toBe(429);
    expect(await eleventh.json()).toMatchObject({ error: { code: "research_limit_reached" } });
    expect(model.planCalls).toBe(plansAtTripLimit + 5);
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
    expect(workspace.proposals).toEqual([expect.objectContaining({
      name: "Nishiki Market",
      category: null,
      endorsements: [],
      recommendationSentences: null,
      tradeoffSentences: null,
    })]);
  });

  it("replays a response stored before the quality checks instead of failing", async () => {
    const cookie = await login();
    const trip = await createTrip(cookie);
    const owner = await database.selectFrom("users").select("id").where("email", "=", "owner@example.test")
      .executeTakeFirstOrThrow();
    // The shape the previous release stored: no quality fields, question answers, or feedback ownership/edit marker.
    await database.insertInto("mutation_requests").values({
      actor_id: owner.id,
      operation: `discovery:generate:${trip.id}`,
      idempotency_key: "generate-before-deploy",
      response: {
        brief: {
          originalText: "Food markets.", structured: null, unresolvedQuestions: [], version: 1,
          updatedAt: "2026-10-03T16:38:02.000Z",
        },
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
          status: "pending",
          evidence: [{
            id: "00000000-0000-4000-8000-000000004403",
            kind: "google-place",
            providerPlaceId: market.providerPlaceId,
            sourceUrl: market.sourceUrl,
            title: market.name,
            attribution: market.attribution,
            observedAt: market.observedAt,
            expiresAt: market.expiresAt,
          }],
          acceptedTripPlaceId: null,
          version: 1,
        }],
        feedback: [{
          id: "00000000-0000-4000-8000-000000004403",
          proposalId: null,
          originalText: "More markets.",
          interpretation: { interests: ["markets"], exclusions: [], pace: null, budget: null, summary: "More markets." },
          status: "pending",
          version: 1,
          createdAt: "2026-10-03T16:38:02.000Z",
        }],
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
    expect(workspace.proposals[0]).toMatchObject({
      category: null,
      endorsements: [],
      recommendationSentences: null,
      tradeoffSentences: null,
      evidence: [expect.objectContaining({ isStale: false })],
    });
    expect(workspace.brief?.questionAnswers).toEqual([]);
    expect(workspace.feedback[0]).toMatchObject({
      proposalName: null,
      interpretationEdited: false,
      isOwn: false,
    });
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
