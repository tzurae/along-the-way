import { PostgresCollaborationModule } from "../src/private-trips/postgres-collaboration-module";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { sql, type Kysely } from "kysely";

import { parseDiscoveryWorkspaceResponse, parseUpdateCandidateProposalVoteResponse } from "@along-the-way/contracts/discovery";
import { parseTripResponse } from "@along-the-way/contracts/private-trips";
import {
  parseTripPlaceListResponse,
  parseTripPlaceResponse,
  type ProviderPlaceCandidateDto,
} from "@along-the-way/contracts/trip-places";
import { parseTripSkeletonResponse } from "@along-the-way/contracts/trip-skeleton";

import { createApp } from "../src/app";
import { PostgresPlaceDetailModule } from "../src/place-details/postgres-place-detail-module";
import { packagedPhotoRoot } from "../src/place-details/photo-assets";
import { createDatabase, type AlongTheWayDatabase } from "../src/database/database";
import { runMigrations } from "../src/database/migrate";
import { seedDatabase } from "../src/database/seed";
import type { RecommendationSourceChecks } from "../src/discovery/candidate-verification";
import type {
  ClarifyQuestionDraft,
  ClarifyReviewVerdict,
  DiscoveryModel,
  DiscoveryPlanResult,
  DiscoveryResearchResult,
  ResearchedCandidate,
} from "../src/discovery/discovery-model";
import { claimNextDiscoveryJob } from "../src/discovery/discovery-jobs";
import type { PlaceDiscovery } from "../src/discovery/maps-grounding-lite";
import { PostgresDiscoveryModule } from "../src/discovery/postgres-discovery-module";
import type { EmailSender } from "../src/private-trips/email-sender";
import { PostgresEmailWorker } from "../src/private-trips/postgres-email-worker";
import { PostgresIdentityAccessModule } from "../src/private-trips/postgres-identity-access-module";
import { PostgresRateLimiter } from "../src/private-trips/postgres-rate-limiter";
import { PostgresReadinessProbe } from "../src/private-trips/postgres-readiness-probe";
import { PostgresTripWorkspaceModule } from "../src/private-trips/postgres-trip-workspace-module";
import { TokenIssuer } from "../src/private-trips/token-issuer";
import { PostgresTripSkeletonModule } from "../src/trip-skeleton/postgres-trip-skeleton-module";
import {
  ProviderQuotaError,
  ProviderUnavailableError,
  type PlaceProvider,
  type RatedPlaceCandidate,
  type RatedPlaceLookup,
} from "../src/trip-places/google-places-provider";
import { PostgresTripPlaceModule } from "../src/trip-places/postgres-trip-place-module";
import { unrelatedDayPlanModule } from "./day-plan-test-support";
import { tripFlights } from "./travel-test-support";

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
  typeLabel: null,
  address: "Nakagyo Ward, Kyoto",
  latitude: 35.005,
  longitude: 135.765,
  timeZone: "Asia/Tokyo",
  sourceUrl: "https://www.google.com/maps/search/?api=1&query_place_id=ChIJ-Nishiki-Market-001",
  attribution: "Google Maps",
  observedAt: "2026-09-28T12:00:00.000Z",
  expiresAt: "2026-10-28T12:00:00.000Z",
  photo: null,
};

function place(name: string, providerPlaceId: string): ProviderPlaceCandidateDto {
  return { ...market, name, providerPlaceId, sourceUrl: null };
}

/** Google's ID for a place name in these fixtures. */
const idOf = (name: string) => name === "Nishiki Market" ? market.providerPlaceId : `ChIJ-${name.replaceAll(" ", "-")}`;

class ControlledPlaceProvider implements PlaceProvider, RatedPlaceLookup {
  readonly available = true;
  readonly attribution = "Google Maps";
  /** Place Details calls, by Place ID. */
  lookups: string[] = [];
  alwaysQuota = false;
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
  async details(providerPlaceId: string): Promise<RatedPlaceCandidate> {
    if (this.alwaysQuota) throw new ProviderQuotaError();
    this.lookups.push(providerPlaceId);
    const open = { businessStatus: "operational" as const, countryCode: "JP" };
    const known = [...this.known.keys()].find((name) => idOf(name) === providerPlaceId);
    if (known) {
      const facts = this.known.get(known)!;
      const candidate = place(known, providerPlaceId);
      return {
        candidate: facts.located === false ? { ...candidate, latitude: null, longitude: null } : candidate,
        rating: 4.5,
        userRatingCount: 1_000,
        websiteUri: null,
        businessStatus: facts.businessStatus ?? open.businessStatus,
        countryCode: facts.countryCode ?? open.countryCode,
      };
    }
    if (providerPlaceId === market.providerPlaceId) {
      return { candidate: market, rating: 4.4, userRatingCount: 12_000, websiteUri: "https://www.kyoto-nishiki.or.jp/", ...open };
    }
    if (providerPlaceId === idOf("Tiny Cafe")) {
      // A near-perfect rating from too few reviews to count.
      return { candidate: place("Tiny Cafe", providerPlaceId), rating: 4.9, userRatingCount: 40, websiteUri: null, ...open };
    }
    if (providerPlaceId === idOf("Takao Kanko Hotel")) {
      return { candidate: place("Takao Kanko Hotel", providerPlaceId), rating: 4.3, userRatingCount: 900, websiteUri: null, ...open };
    }
    throw new ProviderUnavailableError();
  }
}

/** Grounding Lite: every search finds the default places plus every place Google knows in this test. */
class ControlledPlaceDiscovery implements PlaceDiscovery {
  readonly available = true;
  readonly searches: string[] = [];
  quota = false;
  constructor(private readonly provider: ControlledPlaceProvider) {}
  async searchPlaces(query: string) {
    if (this.quota) throw new ProviderQuotaError();
    this.searches.push(query);
    const names = ["Nishiki Market", "Tiny Cafe", "Takao Kanko Hotel", ...this.provider.known.keys()];
    return {
      summary: names.map((name, index) => `${name} [${index}]`).join(", "),
      places: names.map((name) => ({ providerPlaceId: idOf(name), latitude: 35, longitude: 135.7 })),
    };
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
      return "Kyoto's gardens: Gion Garden, Okazaki Garden, Shoren Garden, Undecided Garden, Ruined Garden, Seoul Garden and Floating Garden.";
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
  /** When set, research picks exactly these places, each cited by an official tourism page. */
  researchedPlaces: string[] | null = null;
  /** The checklist the clarifying worker drafts. */
  clarifyQuestions: ClarifyQuestionDraft[] = [];
  /** The reviewer's verdict for each reviewed answer. */
  review: (item: { id: string; answer: string | null }) => ClarifyReviewVerdict = (item) =>
    ({ id: item.id, verdict: "sufficient", reason: null, interpretation: item.answer });
  readonly planInputs: Array<Parameters<DiscoveryModel["plan"]>[0]> = [];
  readonly researchInputs: Array<Parameters<DiscoveryModel["research"]>[0]> = [];

  async clarify() {
    return { modelId: this.modelId, questions: this.clarifyQuestions };
  }

  async reviewAnswers(input: Parameters<DiscoveryModel["reviewAnswers"]>[0]) {
    return { verdicts: input.items.map((item) => this.review(item)) };
  }

  async plan(input: Parameters<DiscoveryModel["plan"]>[0]): Promise<DiscoveryPlanResult> {
    this.planInputs.push(input);
    this.planCalls += 1;
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
        searchQueries: [
          { query: "京都 錦市場", area: "Kyoto", category: null, namedPlace: "Nishiki Market" },
          { query: "京都 市場", area: "Kyoto", category: "Food markets", namedPlace: null },
        ],
      },
      outputLanguage: "en",
    };
  }

  async research(input: Parameters<DiscoveryModel["research"]>[0]): Promise<DiscoveryResearchResult> {
    this.researchInputs.push(input);
    this.researchCalls += 1;
    if (this.researchFailure) throw this.researchFailure;
    // Like the real model, it can only pick a Place ID discovery offered this run.
    const offered = new Set(input.discovered.flatMap((group) => group.placeIds.filter((id): id is string => id !== null)));
    const picked = (candidates: ResearchedCandidate[]) => candidates.filter((candidate) => offered.has(candidate.providerPlaceId));
    if (this.researchedPlaces) {
      return {
        modelId: this.modelId,
        sources: [{ url: "https://kyoto.example.test/gardens", title: "Official Kyoto gardens guide" }],
        candidates: picked(this.researchedPlaces.map((name) => ({
          providerPlaceId: idOf(name),
          name,
          localName: null,
          englishName: null,
          namedPlace: null,
          area: "Kyoto",
          category: "Food markets",
          matchedNeeds: ["gardens"],
          tradeoffSentences: [],
          unknowns: [],
          recommendationSentences: [{
            text: `${name} is a quiet garden.`,
            sourceUrls: ["https://kyoto.example.test/gardens"],
          }],
          sources: [{ url: "https://kyoto.example.test/gardens", type: "tourism_board" as const }],
        }))),
      };
    }
    const base = {
      area: "Kyoto",
      category: "Food markets",
      matchedNeeds: ["food markets"],
      tradeoffSentences: [],
      unknowns: ["holiday opening hours"],
    };
    return {
      modelId: this.modelId,
      sources: [
        { url: "https://kyoto.example.test/nishiki", title: "Official Nishiki Market guide" },
        { url: "https://travel.example.test/nishiki-crowds", title: "When to visit Nishiki Market" },
        { url: "https://kyoto.example.test/tiny-cafe", title: "Tiny Cafe feature" },
      ],
      candidates: picked([
        {
          ...base,
          providerPlaceId: market.providerPlaceId,
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
          providerPlaceId: idOf("Tiny Cafe"),
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
          // Written about Takao, but the picked ID is the hotel next to it in Google's answer.
          ...base,
          providerPlaceId: idOf("Takao Kanko Hotel"),
          name: "Takao",
          localName: "高雄",
          englishName: "Takao",
          namedPlace: null,
          recommendationSentences: [{ text: "Mountain temples with early autumn leaves.", sourceUrls: [] }],
          sources: [],
        },
      ]),
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
  let placeDiscovery: ControlledPlaceDiscovery;
  let sourceChecks: ControlledSourceChecks;
  let discovery: PostgresDiscoveryModule;
  const now = () => new Date("2026-09-28T12:00:00.000Z");

  beforeAll(async () => {
    database = createDatabase(databaseUrl);
    await runMigrations(database);
  });

  beforeEach(async () => {
    await sql`
      truncate table
        discovery_jobs,
        discovery_clarifications,
        discovery_feedback,
        discovery_proposal_votes,
        candidate_proposal_evidence,
        candidate_proposals,
        discovery_evidence,
        discovery_runs,
        discovery_briefs,
        trip_place_duplicate_suggestions,
        trip_place_must_items,
        trip_place_excluded_days,
        trip_place_desired_days,
        trip_place_votes,
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
    placeDiscovery = new ControlledPlaceDiscovery(provider);
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
    const rateLimiter = new PostgresRateLimiter(
      database,
      "discovery-rate-secret-at-least-32-bytes",
      now,
    );
    const tripPlaces = new PostgresTripPlaceModule({ database, provider, now });
    discovery = new PostgresDiscoveryModule({
      database,
      model,
      placeLookup: provider,
      placeDiscovery,
      claimAiRun: (userId, tripId) => rateLimiter.claimDiscoveryAiRun(userId, tripId),
      tripPlaces,
      sourceChecks,
      now,
      policyVersion: "discovery-test-v2",
    });
    app = createApp({
      placeDetails: new PostgresPlaceDetailModule({ database, assetRoot: packagedPhotoRoot }),
      collaboration: new PostgresCollaborationModule(database),
      dayPlans: unrelatedDayPlanModule,
      discovery,
      identityAccess,
      rateLimiter,
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
    const fixtureNow = new Date("2026-09-28T12:00:00.000Z");
    await database.insertInto("users").values({
      email: address,
      display_name: null,
      status: "active",
      created_at: fixtureNow,
      updated_at: fixtureNow,
    }).onConflict((conflict) => conflict.column("email").doUpdateSet({
      status: "active",
      updated_at: fixtureNow,
    })).execute();
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
      body: json({ token, confirm: true }),
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
        flights: tripFlights(),
      }),
    });
    expect(response.status).toBe(201);
    return parseTripResponse(await response.json()).trip;
  }

  function discoveryRequest(cookie: string, path: string, key: string, body: unknown) {
    return app.request(path, {
      method: path.includes("/discovery/brief") || path.endsWith("/vote") || path.endsWith("/clarification/answers") ? "PUT" : "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "idempotency-key": key,
        origin: "https://app.example.test",
      },
      body: json(body),
    });
  }

  async function readWorkspace(cookie: string, tripId: string) {
    const response = await app.request(`/api/trips/${tripId}/discovery`, { headers: { cookie } });
    expect(response.status).toBe(200);
    return parseDiscoveryWorkspaceResponse(await response.json()).discovery;
  }

  async function saveBrief(cookie: string, tripId: string, key: string, originalText = "Quiet gardens.") {
    const saved = await discoveryRequest(cookie, `/api/trips/${tripId}/discovery/brief`, key, { originalText, expectedVersion: null });
    expect(saved.status, await saved.clone().text()).toBe(200);
  }

  /** 調查 up to the queue: the checklist (none by default, so it is ready), then the research request. */
  async function queueResearch(cookie: string, tripId: string, key: string, briefVersion = 1) {
    const asked = await discoveryRequest(cookie, `/api/trips/${tripId}/discovery/clarification`, `${key}-clarify`, {
      expectedBriefVersion: briefVersion,
    });
    expect(asked.status, await asked.clone().text()).toBe(200);
    return discoveryRequest(cookie, `/api/trips/${tripId}/discovery/research`, key, { expectedBriefVersion: briefVersion });
  }

  /** What the worker does: claim the oldest queued job and run it. */
  async function runQueuedJob() {
    const claimed = await claimNextDiscoveryJob(database, now());
    if (!claimed) throw new Error("Expected a queued discovery job");
    await discovery.runJob(claimed);
    return database.selectFrom("discovery_jobs").selectAll().where("id", "=", claimed.id).executeTakeFirstOrThrow();
  }

  /** A whole 調查: queue it, let the worker run it, and read the workspace it left. */
  async function research(cookie: string, tripId: string, key: string, briefVersion = 1) {
    const queued = await queueResearch(cookie, tripId, key, briefVersion);
    expect(queued.status, await queued.clone().text()).toBe(202);
    const job = await runQueuedJob();
    expect(job.status, job.error_code ?? "").toBe("succeeded");
    return readWorkspace(cookie, tripId);
  }

  async function addEditorMember(tripId: string, emailAddress: string) {
    const user = await database.insertInto("users").values({
      email: emailAddress,
      display_name: emailAddress.split("@")[0]!,
      status: "active",
      created_at: now(),
      updated_at: now(),
    }).returning("id").executeTakeFirstOrThrow();
    const cookie = await login(emailAddress);
    await database.insertInto("trip_members").values({
      trip_id: tripId,
      user_id: user.id,
      role: "editor",
      removed_at: null,
    }).execute();
    return { cookie, userId: user.id };
  }

  async function generateLocatedProposals(
    cookie: string,
    tripId: string,
    key: string,
    names: readonly string[],
  ) {
    for (const name of names) provider.known.set(name, {});
    model.researchedPlaces = [...names];
    await saveBrief(cookie, tripId, `${key}-brief`);
    return research(cookie, tripId, `${key}-research`);
  }

  it("stores a readback marker and replays a mutation with a large decided list", async () => {
    const cookie = await login("large-discovery-replay@example.test");
    const trip = await createTrip(cookie, "Large discovery replay");
    expect((await discoveryRequest(cookie, `/api/trips/${trip.id}/discovery/brief`, "large-replay-initial", {
      originalText: "Gardens.",
      expectedVersion: null,
    })).status).toBe(200);
    const owner = await database.selectFrom("users")
      .select("id")
      .where("email", "=", "large-discovery-replay@example.test")
      .executeTakeFirstOrThrow();
    const run = await database.insertInto("discovery_runs").values({
      trip_id: trip.id,
      brief_version: 1,
      policy_version: "large-replay-test",
      model_id: "fixture",
      status: "completed",
      search_plan: {},
      error_code: null,
      created_by: owner.id,
      completed_at: now(),
    }).returning("id").executeTakeFirstOrThrow();
    const proposal = (index: number) => ({
      trip_id: trip.id,
      run_id: run.id,
      provider_place_id: `ChIJ-large-rejected-${index}`,
      name: `Rejected place ${index} ${"x".repeat(160)}`,
      place_type: "activity" as const,
      address: null,
      latitude: null,
      longitude: null,
      source_url: null,
      recommendation: "Older rejected recommendation",
      matched_needs: JSON.stringify([]),
      tradeoffs: JSON.stringify([]),
      unknowns: JSON.stringify([]),
      confidence: "medium" as const,
      status: "rejected" as const,
      accepted_trip_place_id: null,
      decided_by: owner.id,
      decided_at: now(),
    });
    await database.insertInto("candidate_proposals")
      .values(Array.from({ length: 400 }, (_, index) => proposal(index)))
      .execute();
    await database.updateTable("discovery_runs")
      .set({ created_at: new Date(now().valueOf() - 60_000) })
      .where("id", "=", run.id)
      .execute();
    await database.insertInto("discovery_runs").values({
      trip_id: trip.id,
      brief_version: 1,
      policy_version: "large-replay-test",
      model_id: "fixture-latest",
      status: "completed",
      search_plan: {},
      error_code: null,
      created_by: owner.id,
      completed_at: now(),
    }).execute();
    const body = { originalText: "Gardens and markets.", expectedVersion: 1 };
    const first = await discoveryRequest(
      cookie,
      `/api/trips/${trip.id}/discovery/brief`,
      "large-replay-update",
      body,
    );
    expect(first.status, await first.clone().text()).toBe(200);
    expect(parseDiscoveryWorkspaceResponse(await first.json()).discovery.decided).toHaveLength(400);
    const stored = await database.selectFrom("mutation_requests")
      .select([
        "response",
        sql<number>`pg_column_size(response)`.as("bytes"),
      ])
      .where("idempotency_key", "=", "large-replay-update")
      .executeTakeFirstOrThrow();
    expect(stored.response).toEqual({ type: "discovery_workspace_readback" });
    expect(stored.bytes).toBeLessThan(100);

    await database.insertInto("candidate_proposals").values(proposal(400)).execute();
    const replay = await discoveryRequest(
      cookie,
      `/api/trips/${trip.id}/discovery/brief`,
      "large-replay-update",
      body,
    );
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect(parseDiscoveryWorkspaceResponse(await replay.json()).discovery.decided).toHaveLength(401);
  });

  it("hides other voters' emails in discovery reads and vote responses", async () => {
    const ownerCookie = await login("discovery-email-owner@example.test");
    const trip = await createTrip(ownerCookie, "Private discovery voters");
    const editor = await addEditorMember(trip.id, "discovery-email-editor@example.test");
    const generated = await generateLocatedProposals(
      ownerCookie,
      trip.id,
      "private-discovery-voters",
      ["Gion Garden"],
    );
    const proposal = generated.proposals[0]!;
    expect((await discoveryRequest(
      ownerCookie,
      `/api/trips/${trip.id}/discovery/proposals/${proposal.id}/vote`,
      "private-discovery-owner-vote",
      { voted: true },
    )).status).toBe(200);
    const editorVote = await discoveryRequest(
      editor.cookie,
      `/api/trips/${trip.id}/discovery/proposals/${proposal.id}/vote`,
      "private-discovery-editor-vote",
      { voted: true },
    );
    expect(editorVote.status).toBe(200);
    expect(parseUpdateCandidateProposalVoteResponse(await editorVote.json()).proposal.voters
      .map((voter) => [voter.memberUserId, voter.memberEmail])).toEqual([
      [trip.members[0]!.userId, null],
      [editor.userId, "discovery-email-editor@example.test"],
    ]);

    const editorRead = parseDiscoveryWorkspaceResponse(await (await app.request(
      `/api/trips/${trip.id}/discovery`,
      { headers: { cookie: editor.cookie } },
    )).json()).discovery;
    expect(editorRead.proposals[0]!.voters.map((voter) => [voter.memberUserId, voter.memberEmail]))
      .toEqual([
        [trip.members[0]!.userId, null],
        [editor.userId, "discovery-email-editor@example.test"],
      ]);
    const ownerRead = parseDiscoveryWorkspaceResponse(await (await app.request(
      `/api/trips/${trip.id}/discovery`,
      { headers: { cookie: ownerCookie } },
    )).json()).discovery;
    expect(ownerRead.proposals[0]!.voters.map((voter) => voter.memberEmail)).toEqual([
      "discovery-email-owner@example.test",
      "discovery-email-editor@example.test",
    ]);
  });

  it("treats a concurrently created discovery brief as a version conflict without overwriting it", async () => {
    const cookie = await login();
    const trip = await createTrip(cookie, "Concurrent brief creation");
    const path = `/api/trips/${trip.id}/discovery/brief`;
    const inputs = ["Architecture and temples.", "Food markets and gardens."];
    const results = await Promise.all(inputs.map((originalText, index) => discoveryRequest(cookie, path, `brief-create-${index}`, {
      originalText, expectedVersion: null,
    })));
    expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
    const winner = results.findIndex((response) => response.status === 200);
    const saved = parseDiscoveryWorkspaceResponse(await results[winner]!.json()).discovery;
    const rejected = await results[1 - winner]!.json();
    expect(rejected).toMatchObject({ error: { code: "conflict", currentVersion: saved.brief!.version } });
    const readBrief = async () => parseDiscoveryWorkspaceResponse(await (await app.request(`/api/trips/${trip.id}/discovery`, { headers: { cookie } })).json()).discovery.brief;
    const readHistory = async () => (await (await app.request(`/api/trips/${trip.id}/history`, { headers: { cookie } })).json()).events;
    const before = await readHistory();
    expect(before.filter((event: { eventType: string }) => event.eventType.startsWith("discovery.brief_"))).toHaveLength(1);
    expect(await readBrief()).toEqual(saved.brief);
    const stale = await discoveryRequest(cookie, path, "brief-stale-create", { originalText: "Stale third editor.", expectedVersion: null });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { currentVersion: saved.brief!.version, latestChange: { eventId: before[0].id } } });
    expect(await readBrief()).toEqual(saved.brief);
    expect(await readHistory()).toEqual(before);
    const replay = await discoveryRequest(cookie, path, `brief-create-${winner}`, { originalText: inputs[winner], expectedVersion: null });
    expect(parseDiscoveryWorkspaceResponse(await replay.json()).discovery).toEqual(saved);
    expect(await readHistory()).toEqual(before);
    const reapplied = await discoveryRequest(cookie, path, "brief-reapplied", { originalText: inputs[1 - winner], expectedVersion: saved.brief!.version });
    expect(reapplied.status).toBe(200);
    expect((await readBrief())?.originalText).toBe(inputs[1 - winner]);
  });


  it("asks back at most twice on a required answer, then researches with it as uncertain", async () => {
    const cookie = await login();
    const trip = await createTrip(cookie);
    model.clarifyQuestions = [
      { text: "How much walking is fine?", why: "Sets how far apart places may be.", options: ["Little", "Some"], allowOther: true, multiple: false, required: true },
      { text: "Indoor or outdoor markets?", why: "Picks the kind of market.", options: ["Indoor", "Outdoor"], allowOther: false, multiple: false, required: false },
    ];
    model.review = (item) => item.id === "q1"
      ? { id: item.id, verdict: "insufficient", reason: "Say roughly how long.", interpretation: null }
      : { id: item.id, verdict: "sufficient", reason: null, interpretation: item.answer };
    await saveBrief(cookie, trip.id, "clarify-brief", "Food markets.");
    const asked = await discoveryRequest(cookie, `/api/trips/${trip.id}/discovery/clarification`, "clarify-start", { expectedBriefVersion: 1 });
    expect(asked.status).toBe(200);
    let clarification = parseDiscoveryWorkspaceResponse(await asked.json()).discovery.clarification!;
    expect(clarification).toMatchObject({ status: "asking", version: 1, items: [{ id: "q1", required: true }, { id: "q2", required: false }] });

    // Research is refused while a required answer is missing or not accepted.
    const early = await discoveryRequest(cookie, `/api/trips/${trip.id}/discovery/research`, "clarify-too-early", { expectedBriefVersion: 1 });
    expect(early.status).toBe(409);
    expect(await early.json()).toMatchObject({ error: { code: "clarification_incomplete" } });

    const answer = async (key: string, text: string) => {
      const response = await discoveryRequest(cookie, `/api/trips/${trip.id}/discovery/clarification/answers`, key, {
        expectedVersion: clarification.version, answers: [{ id: "q1", answer: text }, { id: "q2", answer: null }],
      });
      expect(response.status, await response.clone().text()).toBe(200);
      clarification = parseDiscoveryWorkspaceResponse(await response.json()).discovery.clarification!;
      return clarification;
    };
    expect(await answer("clarify-answer-1", "A bit")).toMatchObject({
      status: "asking", items: [{ verdict: "insufficient", reason: "Say roughly how long.", followUps: 1 }, { skipped: true, verdict: "sufficient" }],
    });
    expect((await answer("clarify-answer-2", "Not much")).items[0]).toMatchObject({ verdict: "insufficient", followUps: 2 });
    // The third rejection is not asked back: the answer counts as uncertain and research may start.
    expect(await answer("clarify-answer-3", "Some")).toMatchObject({ status: "ready", items: [{ verdict: "unknown", reason: null }, {}] });

    const queued = await discoveryRequest(cookie, `/api/trips/${trip.id}/discovery/research`, "clarify-research", { expectedBriefVersion: 1 });
    expect(queued.status).toBe(202);
    expect((await runQueuedJob()).status).toBe("succeeded");
    // Uncertain and skipped answers reach planning and research as unknown, never guessed.
    expect(model.planInputs.at(-1)?.questionAnswers).toEqual([
      { question: "How much walking is fine?", answer: null },
      { question: "Indoor or outdoor markets?", answer: null },
    ]);
    expect(model.researchInputs.at(-1)?.questionAnswers).toEqual(model.planInputs.at(-1)?.questionAnswers);
    // A successful run used up its checklist: the next 調查 asks fresh questions.
    expect((await readWorkspace(cookie, trip.id)).clarification).toBeNull();
  });

  it("finds real places first, lets research pick only those, and drops a picked ID that is another place", async () => {
    const cookie = await login();
    const trip = await createTrip(cookie);
    await saveBrief(cookie, trip.id, "claim-brief", "Food markets at an unhurried pace.");
    const generated = await research(cookie, trip.id, "claim-run");

    // Every planned search ran before research, and research saw only what they found.
    expect(placeDiscovery.searches).toEqual(["京都 錦市場", "京都 市場"]);
    expect(model.researchInputs[0]!.discovered.flatMap((group) => group.placeIds)).toContain(market.providerPlaceId);
    // Takao was written about but its ID is the hotel: a name mismatch, never shown.
    expect(generated.latestRun?.shortfalls).toContainEqual(expect.objectContaining({ code: "name_mismatch", subject: "Takao" }));
    // Tiny Cafe has 40 reviews, so only its official page vouches for it: one verified source is
    // enough, and the proposal says which one.
    expect(new Map(generated.proposals.map((proposal) => [proposal.name, proposal.endorsements]))).toEqual(new Map([
      ["Nishiki Market", ["google_reviews", "wikivoyage", "official_tourism"]],
      ["Tiny Cafe", ["official_tourism"]],
    ]));
    const job = generated.latestJob!;
    expect(job).toMatchObject({ status: "succeeded", addedCount: 2 });
    // Every stage ran in order; photos is partial because this module has no Commons photo finder.
    expect(Object.values(job.stages).map((stage) => stage.state)).toEqual(["done", "done", "done", "done", "done", "partial"]);

    const proposal = generated.proposals.find((entry) => entry.name === "Nishiki Market")!;
    expect(proposal.recommendationSentences).toEqual([{
      text: "A compact food-market stop matching the trip's main interest.",
      evidenceIds: [expect.any(String)],
    }]);
    expect(proposal.tradeoffSentences).toEqual([{
      text: "Busy around lunch.",
      evidenceIds: [expect.any(String)],
    }]);
    const evidenceIds = new Set(proposal.evidence.map((item) => item.id));
    const citedIds = [
      ...(proposal.recommendationSentences ?? []),
      ...(proposal.tradeoffSentences ?? []),
    ].flatMap((sentence) => sentence.evidenceIds);
    expect(citedIds).toHaveLength(2);
    expect(citedIds.every((id) => evidenceIds.has(id))).toBe(true);
    const linkedEvidence = await database.selectFrom("candidate_proposal_evidence as link")
      .innerJoin("discovery_evidence as evidence", "evidence.id", "link.evidence_id")
      .select(["evidence.id", "evidence.run_id"])
      .where("link.proposal_id", "=", proposal.id)
      .execute();
    expect(linkedEvidence.map((item) => item.id)).toEqual(expect.arrayContaining(citedIds));
    expect(new Set(linkedEvidence.map((item) => item.run_id))).toEqual(new Set([proposal.runId]));
    expect(proposal.evidence.filter((item) => item.kind === "web-source")).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceUrl: "https://kyoto.example.test/nishiki", expiresAt: "2026-10-28T12:00:00.000Z", isStale: false }),
      expect.objectContaining({
        sourceUrl: "https://travel.example.test/nishiki-crowds", title: "When to visit Nishiki Market",
        attribution: "travel.example.test", expiresAt: "2026-10-28T12:00:00.000Z", isStale: false,
      }),
    ]));

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
    const refreshed = (await readWorkspace(cookie, trip.id)).proposals[0];
    expect(refreshed?.evidence).not.toHaveLength(0);
    expect(refreshed?.evidence.every((item) => item.isStale)).toBe(true);
  });

  it("holds places the trip already has or rejected back from research, and keeps an undo version-checked", async () => {
    const cookie = await login();
    const trip = await createTrip(cookie, "Restored after two rejections");
    const ownerId = trip.members[0]!.userId;
    provider.known.set("Shoren Garden", {}).set("Gion Garden", {});
    // Two earlier runs proposed Shoren Garden and both proposals were rejected.
    const rejectedIds: string[] = [];
    for (const index of [0, 1]) {
      const at = new Date(Date.UTC(2026, 8, 20 + index));
      const run = await sql<{ id: string }>`
        insert into discovery_runs (trip_id, brief_version, policy_version, model_id, status, search_plan, created_by, created_at)
        values (${trip.id}, 1, 'historical', 'historical', 'completed', '{}'::jsonb, ${ownerId}, ${at})
        returning id
      `.execute(database);
      const proposal = await sql<{ id: string }>`
        insert into candidate_proposals (
          trip_id, run_id, provider_place_id, name, place_type, recommendation, matched_needs,
          tradeoffs, unknowns, confidence, status, decided_by, decided_at, version, created_at, updated_at
        ) values (
          ${trip.id}, ${run.rows[0]!.id}, ${idOf(index === 0 ? "Gion Garden" : "Shoren Garden")}, ${index === 0 ? "Gion Garden" : "Shoren Garden"},
          'activity', 'Historical recommendation', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'medium', 'rejected', ${ownerId}, ${at}, 2, ${at}, ${at}
        ) returning id
      `.execute(database);
      rejectedIds.push(proposal.rows[0]!.id);
    }
    // An undo names the rejection it undoes: version 0 (from before restore existed) and a stale
    // version are conflicts, not validation errors.
    expect((await discoveryRequest(cookie, `/api/trips/${trip.id}/discovery/proposals/${rejectedIds[1]}/restore`,
      "restore-unknown-version", { expectedVersion: 0 })).status).toBe(409);
    expect((await discoveryRequest(cookie, `/api/trips/${trip.id}/discovery/proposals/${rejectedIds[1]}/restore`,
      "restore-stale-version", { expectedVersion: 1 })).status).toBe(409);
    // The owner restores Shoren Garden; Gion Garden stays rejected.
    expect((await discoveryRequest(cookie, `/api/trips/${trip.id}/discovery/proposals/${rejectedIds[1]}/restore`,
      "restore-later", { expectedVersion: 2 })).status).toBe(200);
    model.researchedPlaces = ["Shoren Garden", "Gion Garden"];
    await saveBrief(cookie, trip.id, "restored-brief");
    const workspace = await research(cookie, trip.id, "restored-run");

    // The rejected place never reached research; the restored one (pending again) was not offered either.
    // Rejected Gion Garden and restored (pending again) Shoren Garden were held back from research
    // by Place ID, in place, so the summary's citations still line up.
    const offered = model.researchInputs[0]!.discovered[0]!;
    expect(offered.placeIds).not.toContain(idOf("Gion Garden"));
    expect(offered.placeIds).not.toContain(idOf("Shoren Garden"));
    expect(offered.placeIds.filter((id) => id === null)).toHaveLength(2);
    expect(await database.selectFrom("candidate_proposals").select("id")
      .where("trip_id", "=", trip.id).where("provider_place_id", "=", idOf("Shoren Garden")).execute()).toHaveLength(1);
    expect(workspace.decided.map((decision) => decision.name)).toContain("Gion Garden");
    expect(workspace.proposals.map((proposal) => [proposal.name, proposal.status])).toEqual([["Shoren Garden", "pending"]]);
    expect(workspace.latestRun?.shortfalls.filter((entry) => entry.code === "rejected")).toEqual([]);
  });

  it("never proposes a closed, foreign or unmapped place, and keeps Google's facts out of storage", async () => {
    const cookie = await login();
    const trip = await createTrip(cookie);
    provider.known
      .set("Shoren Garden", {})
      .set("Ruined Garden", { businessStatus: "closed_permanently" })
      .set("Seoul Garden", { countryCode: "KR" })
      .set("Floating Garden", { located: false });
    await saveBrief(cookie, trip.id, "feasible-brief");
    // Each place is reviewed on Google and named by an official page: only Google's facts rule some out.
    model.researchedPlaces = ["Shoren Garden", "Ruined Garden", "Seoul Garden", "Floating Garden"];
    const workspace = await research(cookie, trip.id, "feasible-run");

    expect(workspace.proposals.map((proposal) => proposal.name)).toEqual(["Shoren Garden"]);
    const ruledOut = ["permanently_closed", "temporarily_closed", "outside_trip", "no_location"];
    expect(workspace.latestRun?.shortfalls.filter((entry) => ruledOut.includes(entry.code))).toEqual([
      { code: "permanently_closed", subject: "Ruined Garden", named: false, endorsements: [], count: null },
      { code: "outside_trip", subject: "Seoul Garden", named: false, endorsements: [], count: null },
      { code: "no_location", subject: "Floating Garden", named: false, endorsements: [], count: null },
    ]);
    // The facts come with the one details lookup per picked place.
    expect(provider.lookups).toHaveLength(4);
    // Business status and country are used to screen, never stored; nor is Google's summary.
    const stored = await sql<{ count: string }>`
      select count(*)::text as count from discovery_evidence
      where facts::text ilike '%businessStatus%' or facts::text ilike '%closed_permanently%'
        or facts::text ilike '%countryCode%' or facts::text ilike '%"KR"%' or facts::text ilike '%[0]%'
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
    await saveBrief(cookie, trip.id, "limit-brief");
    const start = (who: string, key: string, tripId = trip.id) =>
      discoveryRequest(who, `/api/trips/${tripId}/discovery/research`, key, { expectedBriefVersion: 1 });

    // The owner's research is queued when the second member asks: no second paid run.
    expect((await queueResearch(cookie, trip.id, "limit-run-1")).status).toBe(202);
    const blocked = await start(secondCookie, "limit-second");
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: { code: "research_in_progress" } });
    // The same trip spelled in capitals is still the same trip.
    expect((await start(secondCookie, "limit-second-upper", trip.id.toUpperCase())).status).toBe(409);
    expect((await runQueuedJob()).status).toBe("succeeded");
    // Once it finished, the next one is accepted (a successful run used its checklist, so ask again).
    expect((await queueResearch(secondCookie, trip.id, "limit-second")).status).toBe(202);
    await runQueuedJob();

    // Six runs on the trip within the hour, failed ones included: the seventh is refused before anything is queued.
    for (const key of ["limit-run-3", "limit-run-4", "limit-run-5", "limit-run-6"]) {
      model.researchFailure = key === "limit-run-4" ? new TypeError("unexpected") : null;
      expect((await queueResearch(cookie, trip.id, key)).status).toBe(202);
      await runQueuedJob();
    }
    model.researchFailure = null;
    const plansAtTripLimit = model.planCalls;
    const seventh = await queueResearch(cookie, trip.id, "limit-run-7");
    expect(seventh.status).toBe(429);
    expect(seventh.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(await seventh.json()).toMatchObject({ error: { code: "research_limit_reached" } });
    expect(await database.selectFrom("discovery_jobs").select("id").where("status", "=", "queued").execute()).toEqual([]);
    // A retry of an accepted request is answered without queueing another run.
    expect((await start(cookie, "limit-run-3")).status).toBe(202);
    expect(await database.selectFrom("discovery_jobs").select("id").where("status", "=", "queued").execute()).toEqual([]);
    expect(model.planCalls).toBe(plansAtTripLimit);

    // The owner started five of those; five more on another trip reach the per-member cap of ten.
    const other = await createTrip(cookie, "Osaka week");
    await saveBrief(cookie, other.id, "limit-other-brief");
    for (const key of ["other-run-1", "other-run-2", "other-run-3", "other-run-4", "other-run-5"]) {
      expect((await queueResearch(cookie, other.id, key)).status).toBe(202);
      await runQueuedJob();
    }
    const eleventh = await queueResearch(cookie, other.id, "other-run-6");
    expect(eleventh.status).toBe(429);
    expect(await eleventh.json()).toMatchObject({ error: { code: "research_limit_reached" } });
  });

  it("fails a job on an exhausted Google quota or an unexpected error, keeping the shortlist and the answers", async () => {
    const cookie = await login();
    const trip = await createTrip(cookie);
    const before = await generateLocatedProposals(cookie, trip.id, "failure-baseline", ["Gion Garden"]);
    expect(before.proposals).toHaveLength(1);
    await discoveryRequest(cookie, `/api/trips/${trip.id}/discovery/brief`, "failure-brief-2", { originalText: "More gardens.", expectedVersion: 1 });

    placeDiscovery.quota = true;
    expect((await queueResearch(cookie, trip.id, "failure-quota", 2)).status).toBe(202);
    const quota = await runQueuedJob();
    expect(quota).toMatchObject({ status: "failed", error_code: "provider_quota", stage: "discover" });
    expect(quota.stages).toMatchObject({ plan: { state: "done" }, discover: { state: "failed" }, research: { state: "pending" } });

    placeDiscovery.quota = false;
    // A new place reaches verification, where Google's Place Details quota is spent.
    provider.known.set("Okazaki Garden", {});
    model.researchedPlaces = ["Okazaki Garden"];
    provider.alwaysQuota = true;
    expect((await discoveryRequest(cookie, `/api/trips/${trip.id}/discovery/research`, "failure-details-quota", { expectedBriefVersion: 2 })).status).toBe(202);
    expect(await runQueuedJob()).toMatchObject({ status: "failed", error_code: "provider_quota", stage: "verify", added_count: null });

    provider.alwaysQuota = false;
    model.researchFailure = new TypeError("unexpected");
    expect((await discoveryRequest(cookie, `/api/trips/${trip.id}/discovery/research`, "failure-unexpected", { expectedBriefVersion: 2 })).status).toBe(202);
    expect(await runQueuedJob()).toMatchObject({ status: "failed", error_code: "internal_error", stage: "research" });

    // Nothing was lost: the earlier place is still listed and the checklist is kept for 重新調查.
    const after = await readWorkspace(cookie, trip.id);
    expect(after.proposals.map((proposal) => proposal.id)).toEqual(before.proposals.map((proposal) => proposal.id));
    expect(after.clarification).toMatchObject({ briefVersion: 2, status: "ready" });
    expect(after.latestJob).toMatchObject({ status: "failed", errorCode: "internal_error" });
    model.researchFailure = null;
    expect((await discoveryRequest(cookie, `/api/trips/${trip.id}/discovery/research`, "failure-retry", { expectedBriefVersion: 2 })).status).toBe(202);
    expect((await runQueuedJob()).status).toBe("succeeded");
  });

  it("scheduling proposals is all-or-nothing and idempotent", async () => {
    const ownerCookie = await login();
    const trip = await createTrip(ownerCookie, "Atomic proposal scheduling");
    const owner = await database.selectFrom("users").select("id")
      .where("email", "=", "owner@example.test").executeTakeFirstOrThrow();
    const editor = await addEditorMember(trip.id, "atomic-voter@example.test");
    const generated = await generateLocatedProposals(ownerCookie, trip.id, "atomic-schedule", [
      "Gion Garden",
      "Okazaki Garden",
    ]);
    const located = generated.proposals.find((proposal) => proposal.name === "Gion Garden")!;
    const unlocated = generated.proposals.find((proposal) => proposal.name === "Okazaki Garden")!;
    expect(generated.proposals).toHaveLength(2);
    await database.updateTable("candidate_proposals")
      .set({ latitude: null, longitude: null })
      .where("id", "=", unlocated.id)
      .execute();
    for (const [cookie, key] of [
      [ownerCookie, "atomic-owner-vote"],
      [editor.cookie, "atomic-editor-vote"],
    ] as const) {
      const vote = await discoveryRequest(
        cookie,
        `/api/trips/${trip.id}/discovery/proposals/${located.id}/vote`,
        key,
        { voted: true },
      );
      expect(vote.status).toBe(200);
    }
    const failedBody = {
      tripDayId: trip.days[1]!.id,
      proposals: [
        { proposalId: located.id, expectedVersion: located.version },
        { proposalId: unlocated.id, expectedVersion: unlocated.version },
      ],
    };

    // catches: partial commit or duplicate replay in proposal scheduling; the pending-state, identical-body, and one-place assertions fail.
    const failed = await discoveryRequest(
      ownerCookie,
      `/api/trips/${trip.id}/discovery/proposals/schedule`,
      "atomic-schedule-failure",
      failedBody,
    );
    expect(failed.status).toBe(400);
    expect(await failed.json()).toEqual({
      error: {
        code: "validation_error",
        message: `Proposal ${unlocated.id} has no coordinates and cannot be scheduled`,
      },
    });
    const afterFailureResponse = await app.request(`/api/trips/${trip.id}/discovery`, {
      headers: { cookie: ownerCookie },
    });
    expect(afterFailureResponse.status).toBe(200);
    const afterFailure = parseDiscoveryWorkspaceResponse(await afterFailureResponse.json()).discovery;
    for (const proposal of [located, unlocated]) {
      expect(afterFailure.proposals.find((candidate) => candidate.id === proposal.id))
        .toMatchObject({
          status: "pending",
          version: proposal.version,
          acceptedTripPlaceId: null,
        });
    }
    const emptyPlacesResponse = await app.request(`/api/trips/${trip.id}/trip-places`, {
      headers: { cookie: ownerCookie },
    });
    expect(emptyPlacesResponse.status).toBe(200);
    expect(parseTripPlaceListResponse(await emptyPlacesResponse.json()).tripPlaces).toEqual([]);

    const validBody = {
      tripDayId: trip.days[1]!.id,
      proposals: [{ proposalId: located.id, expectedVersion: located.version }],
    };
    const scheduled = await discoveryRequest(
      ownerCookie,
      `/api/trips/${trip.id}/discovery/proposals/schedule`,
      "atomic-schedule-success",
      validBody,
    );
    expect(scheduled.status).toBe(200);
    const scheduledBody = await scheduled.json();
    const accepted = parseDiscoveryWorkspaceResponse(scheduledBody).discovery.proposals
      .find((proposal) => proposal.id === located.id)!;
    expect(accepted).toMatchObject({
      status: "accepted",
      acceptedTripPlaceId: expect.any(String),
    });
    const placesResponse = await app.request(`/api/trips/${trip.id}/trip-places`, {
      headers: { cookie: ownerCookie },
    });
    expect(placesResponse.status).toBe(200);
    const places = parseTripPlaceListResponse(await placesResponse.json()).tripPlaces;
    expect(places).toHaveLength(1);
    expect(places[0]).toMatchObject({
      id: accepted.acceptedTripPlaceId,
      aiProposalId: located.id,
      selectedForItinerary: true,
      assignedDayId: trip.days[1]!.id,
      voteCount: 2,
    });
    expect(places[0]!.voters.map((voter) => voter.memberUserId).sort())
      .toEqual([owner.id, editor.userId].sort());

    const replay = await discoveryRequest(
      ownerCookie,
      `/api/trips/${trip.id}/discovery/proposals/schedule`,
      "atomic-schedule-success",
      validBody,
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(scheduledBody);
    const afterReplayResponse = await app.request(`/api/trips/${trip.id}/trip-places`, {
      headers: { cookie: ownerCookie },
    });
    expect(afterReplayResponse.status).toBe(200);
    expect(parseTripPlaceListResponse(await afterReplayResponse.json()).tripPlaces).toEqual(places);

    const stale = await discoveryRequest(
      ownerCookie,
      `/api/trips/${trip.id}/discovery/proposals/schedule`,
      "atomic-schedule-stale",
      {
        tripDayId: trip.days[1]!.id,
        proposals: [{ proposalId: located.id, expectedVersion: located.version }],
      },
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: { code: "conflict", currentVersion: accepted.version },
    });
  });

  it("returns 404 instead of replaying a proposal response through another trip", async () => {
    const cookie = await login();
    const sourceTrip = await createTrip(cookie, "Discovery replay source");
    const routeTrip = await createTrip(cookie, "Discovery replay route");
    const generated = await generateLocatedProposals(cookie, sourceTrip.id, "discovery-replay", [
      "Gion Garden",
    ]);
    const proposal = generated.proposals[0]!;
    const key = "cross-trip-proposal-replay";
    expect((await discoveryRequest(
      cookie,
      `/api/trips/${sourceTrip.id}/discovery/proposals/${proposal.id}/vote`,
      key,
      { voted: true },
    )).status).toBe(200);

    expect((await discoveryRequest(
      cookie,
      `/api/trips/${routeTrip.id}/discovery/proposals/${proposal.id}/vote`,
      key,
      { voted: false },
    )).status).toBe(404);
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
    expect(workspace.proposals[0]).not.toHaveProperty("confidence");
  });
});
