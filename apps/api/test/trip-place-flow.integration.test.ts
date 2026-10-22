import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql, type Kysely } from "kysely";
import { Pool } from "pg";
import type { Hono } from "hono";
import { parseDayRouteResponse } from "@along-the-way/contracts/day-plans";
import { EMPTY_PLANNING_OVERRIDE } from "@along-the-way/contracts/planning";
import {
  parseProviderCandidatesResponse,
  parseNearbyAlternativesResponse,
  parseNearbyActivitiesResponse,
  parseTripPlaceListResponse,
  parseTripPlaceResponse,
  type ProviderPlaceCandidateDto,
  type TripPlaceDto,
} from "@along-the-way/contracts/trip-places";
import { parseTripResponse } from "@along-the-way/contracts/private-trips";
import { parseTripHistoryResponse, parseTripChangeNotification, type TripChangeNotification } from "@along-the-way/contracts/private-trips";
import {
  parseItineraryItemResponse,
  parsePlaceResponse,
  parseTripSkeletonResponse,
} from "@along-the-way/contracts/trip-skeleton";

import { createApp, type AppDependencies } from "../src/app";
import { PostgresPlaceDetailModule } from "../src/place-details/postgres-place-detail-module";
import { packagedPhotoRoot } from "../src/place-details/photo-assets";
import { PostgresCollaborationModule } from "../src/private-trips/postgres-collaboration-module";
import { createDatabase, type AlongTheWayDatabase } from "../src/database/database";
import { runMigrations } from "../src/database/migrate";
import {
  down as removeDayAssignmentMigration,
  up as applyDayAssignmentMigration,
} from "../src/database/migrations/007_trip_place_day_assignments";
import {
  down as removeDayOrderMigration,
  up as applyDayOrderMigration,
} from "../src/database/migrations/009_day_place_order";
import {
  down as removeDayVersionMigration,
  up as applyDayVersionMigration,
} from "../src/database/migrations/020_trip_day_versions";
import { seedDatabase } from "../src/database/seed";
import { PostgresDayPlanModule } from "../src/planning/postgres-day-plan-module";
import { PostgresPlanningSettingsModule } from "../src/planning/postgres-planning-settings-module";
import { GoogleRoutesProvider } from "../src/planning/google-routes-provider";
import { NavitimeProvider } from "../src/planning/navitime-provider";
import type { EmailSender } from "../src/private-trips/email-sender";
import { PostgresEmailWorker } from "../src/private-trips/postgres-email-worker";
import { PostgresIdentityAccessModule } from "../src/private-trips/postgres-identity-access-module";
import { PostgresRateLimiter } from "../src/private-trips/postgres-rate-limiter";
import { PostgresRetention } from "../src/private-trips/retention";
import { PostgresReadinessProbe } from "../src/private-trips/postgres-readiness-probe";
import { PostgresTripWorkspaceModule } from "../src/private-trips/postgres-trip-workspace-module";
import { hashToken, TokenIssuer } from "../src/private-trips/token-issuer";
import { PostgresTripSkeletonModule } from "../src/trip-skeleton/postgres-trip-skeleton-module";
import {
  ProviderQuotaError,
  ProviderUnavailableError,
  type NearbyPlaceCandidate,
  type NearbySearchOptions,
  type PlaceProvider,
  type PlaceSearchOptions,
  type ProviderPlaceCandidate,
} from "../src/trip-places/google-places-provider";
import { PostgresTripPlaceModule } from "../src/trip-places/postgres-trip-place-module";
import { straightLineMeters } from "../src/planning/day-route-order";
import { PostgresNearbyActivityModule } from "../src/nearby-activities/postgres-nearby-activity-module";
import type {
  FoundNearbyActivity,
  NearbyActivityModel,
  NearbyActivityQuery,
} from "../src/nearby-activities/nearby-activity-module";
import { unrelatedDiscoveryModule } from "./discovery-test-support";
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

class ControlledProvider implements PlaceProvider {
  readonly attribution = "Google Maps";
  unavailable = false;
  readonly searchRequests: Array<{ query: string; options: PlaceSearchOptions }> = [];
  readonly detailRequests: Array<{ providerPlaceId: string; options: Pick<PlaceSearchOptions, "languageCode" | "regionCode"> }> = [];
  consumeBudget: (() => Promise<boolean>) | null = null;
  detailGate: ((requestNumber: number) => Promise<void>) | null = null;
  readonly nearbyRequests: NearbySearchOptions[] = [];
  nearbyResults: NearbyPlaceCandidate[] = [];
  readonly extraPlaces = new Map<string, ProviderPlaceCandidate>();
  readonly kyoto: ProviderPlaceCandidate = {
    provider: "google",
    providerPlaceId: "ChIJ-Kyoto-Temple-1234",
    name: "Kiyomizu-dera",
    type: "activity",
    typeLabel: "佛寺",
    address: "1-294 Kiyomizu, Kyoto",
    latitude: 34.9948561,
    longitude: 135.7850463,
    timeZone: null,
    sourceUrl: "https://www.google.com/maps/place/?query_place_id=ChIJ-Kyoto-Temple-1234",
    attribution: "Google Maps",
    observedAt: "2026-09-28T12:00:00.000Z",
    expiresAt: "2026-10-28T12:00:00.000Z",
    photo: null,
    providerPhoto: {
      name: "places/ChIJ-Kyoto-Temple-1234/photos/controlled",
      width: 1200,
      height: 800,
      authors: [{ displayName: "攝影者", uri: "https://example.test/photographer" }],
      googleMapsUri: "https://maps.google.com/?cid=controlled",
    },
  };
  readonly branch: ProviderPlaceCandidate = {
    ...this.kyoto,
    providerPlaceId: "ChIJ-Kyoto-Temple-Branch-5678",
    name: "Kiyomizu Cafe",
    typeLabel: "咖啡店",
    type: "restaurant",
    address: "1-295 Kiyomizu, Kyoto",
    sourceUrl: "https://www.google.com/maps/place/?query_place_id=ChIJ-Kyoto-Temple-Branch-5678",
    providerPhoto: {
      ...this.kyoto.providerPhoto!,
      name: "places/ChIJ-Kyoto-Temple-Branch-5678/photos/controlled",
    },
  };

  async search(query: string, options: PlaceSearchOptions = {}) {
    if (this.consumeBudget && !(await this.consumeBudget())) throw new ProviderQuotaError();
    if (this.unavailable) throw new ProviderUnavailableError();
    this.searchRequests.push({ query, options });
    return [this.kyoto, this.branch];
  }

  async searchNearby(options: NearbySearchOptions) {
    if (this.consumeBudget && !(await this.consumeBudget())) throw new ProviderQuotaError();
    if (this.unavailable) throw new ProviderUnavailableError();
    this.nearbyRequests.push(options);
    return this.nearbyResults;
  }

  async getPlace(
    providerPlaceId: string,
    options: Pick<PlaceSearchOptions, "languageCode" | "regionCode"> = {},
  ) {
    if (this.consumeBudget && !(await this.consumeBudget())) throw new ProviderQuotaError();
    if (this.unavailable) throw new ProviderUnavailableError();
    this.detailRequests.push({ providerPlaceId, options });
    await this.detailGate?.(this.detailRequests.length);
    const place = [this.kyoto, this.branch].find(
      (candidate) => candidate.providerPlaceId === providerPlaceId,
    ) ?? this.extraPlaces.get(providerPlaceId);
    if (!place) throw new ProviderUnavailableError("Place is unavailable");
    return place;
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

async function waitForDatabaseLock(pool: Pool, kind: "advisory" | "row") {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ waiting: boolean }>(
      kind === "advisory"
        ? `select exists (
            select 1 from pg_stat_activity
            where datname = current_database()
              and wait_event_type = 'Lock'
              and wait_event = 'advisory'
          ) as waiting`
        : `select exists (
            select 1 from pg_stat_activity
            where datname = current_database()
              and wait_event_type = 'Lock'
              and wait_event <> 'advisory'
          ) as waiting`,
    );
    if (result.rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for the ${kind} lock barrier`);
}

describe("shared trip places through HTTP and PostgreSQL", () => {
  let database: Kysely<AlongTheWayDatabase>;
  let app: Hono;
  let email: CapturingEmailSender;
  let worker: PostgresEmailWorker;
  let provider: ControlledProvider;
  let rateLimiter: PostgresRateLimiter;
  let tripPlaces: PostgresTripPlaceModule;
  let tripSkeleton: PostgresTripSkeletonModule;
  let collaboration: PostgresCollaborationModule;
  let navitime: NavitimeProvider;
  let googleRoutes: GoogleRoutesProvider;
  let appDependencies: AppDependencies;
  let transitRequests: Array<{ fromId: string; toId: string; date: string }>;
  let googleMatrixRequests: Array<Array<{ fromId: string; toId: string }>>;
  let identityAuthenticateCalls = 0;
  let afterReadObserver: (() => void) | null = null;
  let currentNow = new Date("2026-09-28T12:00:00.000Z");
  const now = () => new Date(currentNow.valueOf());

  beforeAll(async () => {
    database = createDatabase(databaseUrl);
    await runMigrations(database);
  });

  beforeEach(async () => {
    currentNow = new Date("2026-09-28T12:00:00.000Z");
    await sql`
      truncate table
        trip_place_duplicate_suggestions,
        trip_place_must_items,
        trip_place_day_assignments,
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
    provider = new ControlledProvider();
    let sessionNumber = 0;
    const tokenIssuer = new TokenIssuer("trip-place-integration-secret-at-least-32-bytes");
    const identityAccess = new PostgresIdentityAccessModule({
      database,
      tokenIssuer,
      now,
      randomSessionToken: () => `trip-place-session-${++sessionNumber}`,
    });
    identityAuthenticateCalls = 0;
    afterReadObserver = null;
    const authenticate = identityAccess.authenticate.bind(identityAccess);
    identityAccess.authenticate = async (token) => {
      identityAuthenticateCalls += 1;
      return authenticate(token);
    };
    worker = new PostgresEmailWorker({
      database,
      emailSender: email,
      siteAddress: "https://app.example.test",
      tokenIssuer,
      now,
    });
    transitRequests = [];
    navitime = new NavitimeProvider({
      apiKey: "stub-navitime-key",
      reserveBudget: async () => ({ refund: async () => {} }),
    });
    vi.spyOn(navitime, "transit").mockImplementation(async (from, to, date) => {
      transitRequests.push({ fromId: from.id, toId: to.id, date });
      return { minutes: 20, lines: ["測試線"] };
    });
    vi.spyOn(navitime, "shape").mockRejectedValue(new Error("Route shapes are not exercised here"));
    googleMatrixRequests = [];
    googleRoutes = new GoogleRoutesProvider({
      apiKey: "stub-google-routes-key",
      reserveBudget: async () => ({ refund: async () => {} }),
    });
    vi.spyOn(googleRoutes, "matrix").mockImplementation(async (pairs) => {
      googleMatrixRequests.push(pairs.map(({ from, to }) => ({ fromId: from.id, toId: to.id })));
      return pairs.map(({ from, to }) => ({
        fromId: from.id,
        toId: to.id,
        fromLatitude: from.latitude,
        fromLongitude: from.longitude,
        toLatitude: to.latitude,
        toLongitude: to.longitude,
        minutes: from.latitude > to.latitude ? 1 : 50,
        lines: ["Google 測試交通"],
      }));
    });
    vi.spyOn(googleRoutes, "shape").mockRejectedValue(new Error("Route shapes are not exercised here"));
    tripPlaces = new PostgresTripPlaceModule({
      database,
      provider,
      now,
      photoCapabilitySecret: "trip-place-photo-capability-secret-at-least-32-bytes",
      urlResolver: {
        fetch: async () => new Response(null, {
          status: 302,
          headers: {
            location:
              "https://www.google.com/maps/place/Kiyomizu-dera/?query_place_id=ChIJ-Kyoto-Temple-1234",
          },
        }),
        resolveHost: async () => ["142.250.72.238"],
      },
    });
    tripSkeleton = new PostgresTripSkeletonModule({ database, now });
    collaboration = new PostgresCollaborationModule(database);
    const collaborationAfter = collaboration.after.bind(collaboration);
    collaboration.after = async (userId, tripId, order) => {
      const events = await collaborationAfter(userId, tripId, order);
      afterReadObserver?.();
      return events;
    };
    rateLimiter = new PostgresRateLimiter(
      database,
      "trip-place-rate-secret-at-least-32-bytes",
      now,
    );
    provider.consumeBudget = () => rateLimiter.tryConsumePaidProvider("google_places");
    appDependencies = {
      placeDetails: new PostgresPlaceDetailModule({ database, assetRoot: packagedPhotoRoot }),
      collaboration,
      dayPlans: new PostgresDayPlanModule({
        database,
        tripSkeleton,
        tripPlaces,
        navitime,
        googleRoutes,
      }),
      discovery: unrelatedDiscoveryModule,
      identityAccess,
      mapsConfig: { browserKey: "  browser-key  ", mapId: " \t " },
      rateLimiter,
      readiness: new PostgresReadinessProbe(database, now),
      siteAddress: "https://app.example.test",
      tripPlaces,
      tripSkeleton,
      tripWorkspace: new PostgresTripWorkspaceModule({ database, now }),
    };
    app = createApp(appDependencies);
  });

  afterAll(async () => {
    await database.destroy();
  });

  async function login(address: string) {
    await database.insertInto("users").values({
      email: address,
      display_name: address.split("@")[0] ?? null,
      status: "active",
      created_at: now(),
      updated_at: now(),
    }).onConflict((conflict) => conflict.column("email").doNothing()).execute();
    const before = email.magicLinks.length;
    const request = await app.request("/api/auth/magic-links", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://app.example.test",
        "x-forwarded-for": address,
      },
      body: json({ email: address }),
    });
    expect(request.status).toBe(202);
    await worker.runOnce();
    const link = email.magicLinks[before]?.url;
    const token = link && new URLSearchParams(new URL(link).hash.slice(1)).get("magicToken");
    if (!token) throw new Error("Magic link missing");
    const consumed = await app.request("/api/auth/magic-links/consume", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://app.example.test",
      },
      body: json({ token, confirm: true }),
    });
    expect(consumed.status).toBe(200);
    const user = await database.selectFrom("users").select(["id", "email"])
      .where("email", "=", address).executeTakeFirstOrThrow();
    return { cookie: sessionCookie(consumed), user };
  }

  async function createTrip(
    cookie: string,
    name: string,
    options: { countryCodes?: string[]; timeZone?: string } = {},
  ) {
    const countryCodes = options.countryCodes ?? ["JP"];
    const timeZone = options.timeZone ?? "Asia/Tokyo";
    const response = await app.request("/api/trips", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "idempotency-key": `create-${name}`,
        origin: "https://app.example.test",
      },
      body: json({
        name,
        startDate: "2026-10-21",
        endDate: "2026-10-27",
        countryCodes,
        flights: tripFlights("2026-10-21", "2026-10-27", timeZone),
      }),
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return parseTripResponse(await response.json()).trip;
  }

  async function addMember(tripId: string, userId: string) {
    await database.insertInto("trip_members").values({
      trip_id: tripId,
      user_id: userId,
      role: "editor",
      removed_at: null,
    }).execute();
  }

  async function addProvider(
    cookie: string,
    tripId: string,
    key: string,
    note: string,
    method: "search" | "google-maps-url" = "search",
  ) {
    return app.request(`/api/trips/${tripId}/trip-places`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "idempotency-key": key,
        origin: "https://app.example.test",
      },
      body: json({
        method,
        providerPlaceId: provider.kyoto.providerPlaceId,
        sourceUrl: provider.kyoto.sourceUrl,
        originalNote: note,
      }),
    });
  }

  async function addProviderCandidate(
    cookie: string,
    tripId: string,
    key: string,
    candidate: ProviderPlaceCandidate,
  ) {
    provider.extraPlaces.set(candidate.providerPlaceId, candidate);
    const response = await app.request(`/api/trips/${tripId}/trip-places`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "idempotency-key": key,
        origin: "https://app.example.test",
      },
      body: json({
        method: "search",
        providerPlaceId: candidate.providerPlaceId,
        sourceUrl: candidate.sourceUrl,
        originalNote: null,
      }),
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return parseTripPlaceResponse(await response.json()).tripPlace;
  }

  async function addLocatedManualPlace(
    cookie: string,
    tripId: string,
    key: string,
    name: string,
    latitude: number,
    longitude: number,
    timeZone = "Asia/Tokyo",
  ) {
    const response = await app.request(`/api/trips/${tripId}/trip-places`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "idempotency-key": key,
        origin: "https://app.example.test",
      },
      body: json({
        method: "manual",
        name,
        type: "restaurant",
        address: `${name} address`,
        latitude,
        longitude,
        timeZone,
        sourceUrl: null,
        originalNote: null,
      }),
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return parseTripPlaceResponse(await response.json()).tripPlace;
  }

  async function addManual(
    cookie: string,
    tripId: string,
    key: string,
    name: string,
    address: string,
  ) {
    return app.request(`/api/trips/${tripId}/trip-places`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "idempotency-key": key,
        origin: "https://app.example.test",
      },
      body: json({
        method: "manual",
        name,
        type: "restaurant",
        address,
        latitude: null,
        longitude: null,
        timeZone: null,
        sourceUrl: null,
        originalNote: null,
      }),
    });
  }

  async function addManualPlace(
    cookie: string,
    tripId: string,
    key: string,
    name: string,
  ) {
    const response = await addManual(cookie, tripId, key, name, `${name} address`);
    expect(response.status, await response.clone().text()).toBe(201);
    return parseTripPlaceResponse(await response.json()).tripPlace;
  }

  async function assignToDay(
    cookie: string,
    tripId: string,
    dayId: string | null,
    places: TripPlaceDto[],
    key: string,
  ) {
    const response = await app.request(`/api/trips/${tripId}/trip-place-day-assignments`, {
      method: "PUT",
      headers: {
        cookie,
        "content-type": "application/json",
        "idempotency-key": key,
        origin: "https://app.example.test",
      },
      body: json({
        assignments: places.map((place) => ({
          tripPlaceId: place.id,
          tripDayId: dayId,
          expectedVersion: place.version,
        })),
      }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return parseTripPlaceListResponse(await response.json()).tripPlaces;
  }

  function dayRoute(
    cookie: string,
    tripId: string,
    dayId: string,
    order: "current" | "suggested" | "custom",
    orderedTripPlaceIds?: string[],
    transit?: "cached" | "fetch",
    maxTransitCalls?: number,
  ) {
    return app.request(`/api/trips/${tripId}/days/${dayId}/route`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        origin: "https://app.example.test",
      },
      body: json({
        order,
        ...(orderedTripPlaceIds === undefined ? {} : { orderedTripPlaceIds }),
        ...(transit === undefined ? {} : { transit }),
        ...(maxTransitCalls === undefined ? {} : { maxTransitCalls }),
      }),
    });
  }

  function nearbyCandidate(
    providerPlaceId: string,
    name: string,
    options: { type?: ProviderPlaceCandidate["type"]; latitude?: number; longitude?: number } = {},
  ): ProviderPlaceCandidate {
    return {
      ...provider.branch,
      providerPlaceId,
      name,
      type: options.type ?? "restaurant",
      latitude: options.latitude ?? 35.0002,
      longitude: options.longitude ?? 135.7702,
      sourceUrl: `https://www.google.com/maps/place/?query_place_id=${providerPlaceId}`,
      providerPhoto: null,
    };
  }

  async function replaceStop(
    cookie: string,
    tripId: string,
    dayId: string,
    stopId: string,
    providerPlaceId: string,
    expectedDayVersion: number,
    key: string,
  ) {
    const response = await app.request(
      `/api/trips/${tripId}/days/${dayId}/trip-places/${stopId}/replacement`,
      {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/json",
          "idempotency-key": key,
          origin: "https://app.example.test",
        },
        body: json({ expectedDayVersion, providerPlaceId }),
      },
    );
    expect(response.status, await response.clone().text()).toBe(200);
    return parseTripPlaceListResponse(await response.json()).tripPlaces;
  }

  function saveDay(
    cookie: string,
    tripId: string,
    dayId: string,
    endpoint: "place-order" | "arrangement",
    key: string,
    expectedVersion: number,
    orderedTripPlaceIds: string[],
  ) {
    return app.request(`/api/trips/${tripId}/days/${dayId}/${endpoint}`, {
      method: "PUT",
      headers: {
        cookie,
        "content-type": "application/json",
        "idempotency-key": key,
        origin: "https://app.example.test",
      },
      body: json({ expectedVersion, orderedTripPlaceIds }),
    });
  }

  it("paginates authorised change history without losing tied timestamps", async () => {
    const owner = await login("history@example.test");
    const outsider = await login("outsider@example.test");
    const trip = await createTrip(owner.cookie, "History pagination");
    const a = parseTripPlaceResponse(await (await addManual(owner.cookie, trip.id, "history-a", "History A", "A")).json()).tripPlace;
    const b = parseTripPlaceResponse(await (await addManual(owner.cookie, trip.id, "history-b", "History B", "B")).json()).tripPlace;
    await database.updateTable("change_events").set({ created_at: now() }).where("trip_id", "=", trip.id).execute();
    const url = `/api/trips/${trip.id}/history?limit=1`;
    const first = await app.request(url, { headers: { cookie: owner.cookie } });
    expect(first.status).toBe(200);
    const page = await first.json();
    expect(page.events[0]).toMatchObject({
      actorId: owner.user.id, actorDisplayName: "history", eventType: "trip_place.created", targetId: b.id,
    });
    await addManual(owner.cookie, trip.id, "history-c", "History C", "C");
    const next = await app.request(`${url}&before=${page.nextCursor}`, { headers: { cookie: owner.cookie } });
    const second = await next.json();
    expect(second.events[0].targetId).toBe(a.id);
    expect((await app.request(url, { headers: { cookie: outsider.cookie } })).status).toBe(404);
  });

  it("shows every active member email only to the owner and each editor only their own", async () => {
    const owner = await login("roster-owner@example.test");
    const first = await login("roster-first@example.test");
    const second = await login("roster-second@example.test");
    const trip = await createTrip(owner.cookie, "Private member roster");
    await addMember(trip.id, first.user.id);
    await addMember(trip.id, second.user.id);
    const readTrip = async (cookie: string) => parseTripResponse(await (await app.request(
      `/api/trips/${trip.id}`,
      { headers: { cookie } },
    )).json()).trip;

    expect((await readTrip(owner.cookie)).members.map((member) => member.email)).toEqual([
      owner.user.email,
      first.user.email,
      second.user.email,
    ]);
    expect((await readTrip(first.cookie)).members.map((member) => [
      member.userId,
      member.email,
    ])).toEqual([
      [owner.user.id, null],
      [first.user.id, first.user.email],
      [second.user.id, null],
    ]);
  });

  it("hides other active voters' emails from editors in the trip-place list", async () => {
    const owner = await login("vote-email-owner@example.test");
    const editor = await login("vote-email-editor@example.test");
    const trip = await createTrip(owner.cookie, "Private voter emails");
    await addMember(trip.id, editor.user.id);
    const place = parseTripPlaceResponse(await (await addManual(
      owner.cookie, trip.id, "private-voter-place", "Private voter cafe", "Kyoto",
    )).json()).tripPlace;
    expect((await setVote(owner.cookie, trip.id, place.id, true, "private-owner-vote")).status).toBe(200);
    expect((await setVote(editor.cookie, trip.id, place.id, true, "private-editor-vote")).status).toBe(200);

    const ownerVoters = (await list(owner.cookie, trip.id)).find((entry) => entry.id === place.id)!.voters;
    expect(ownerVoters.map((voter) => voter.memberEmail)).toEqual([
      owner.user.email,
      editor.user.email,
    ]);
    const editorVoters = (await list(editor.cookie, trip.id)).find((entry) => entry.id === place.id)!.voters;
    expect(editorVoters.map((voter) => [voter.memberUserId, voter.memberEmail])).toEqual([
      [owner.user.id, null],
      [editor.user.id, editor.user.email],
    ]);
  });

  it("reveals history actor emails only for active members to the owner or actor", async () => {
    const owner = await login("label-owner@example.test");
    const member = await login("label-member@example.test");
    const other = await login("label-other@example.test");
    await database.updateTable("users").set({ display_name: null }).where("id", "=", member.user.id).execute();
    const trip = await createTrip(owner.cookie, "Identifiable history actors");
    await addMember(trip.id, member.user.id);
    await addMember(trip.id, other.user.id);
    const place = parseTripPlaceResponse(await (await addManual(member.cookie, trip.id, "actor-place", "Member cafe", "Kyoto")).json()).tripPlace;
    const readHistory = async (cookie: string) => {
      const response = await app.request(`/api/trips/${trip.id}/history`, { headers: { cookie } });
      expect(response.status).toBe(200);
      return (await response.json()).events as Array<Record<string, unknown>>;
    };
    const events = await readHistory(owner.cookie);
    const added = events.find((event) => event.targetId === place.id)!;
    expect(added).toMatchObject({
      actorId: member.user.id,
      actorDisplayName: null,
      actorEmail: member.user.email,
      actorIsActiveMember: true,
    });
    expect(events.find((event) => event.eventType === "trip.created")).toMatchObject({
      actorDisplayName: "label-owner", actorEmail: owner.user.email,
    });
    for (const [reader, isOwn, actorEmail] of [
      [member, true, member.user.email],
      [owner, false, member.user.email],
      [other, false, null],
    ] as const) {
      const stale = await planning(reader.cookie, trip.id, place.id, place.version + 1, `actor-stale-${String(actorEmail)}`, "Not saved");
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ error: { latestChange: {
        actorId: member.user.id, actorDisplayName: null, actorEmail, actorIsActiveMember: true, isOwn,
      } } });
    }
    expect((await app.request(`/api/trips/${trip.id}/members/${member.user.id}`, {
      method: "DELETE", headers: { cookie: owner.cookie, origin: "https://app.example.test", "idempotency-key": "remove-history-actor" },
    })).status).toBe(204);
    expect((await readHistory(owner.cookie)).find((event) => event.id === added.id)).toMatchObject({
      actorId: member.user.id,
      actorDisplayName: null,
      actorEmail: null,
      actorIsActiveMember: false,
    });
    const removedActorConflict = await planning(
      owner.cookie, trip.id, place.id, place.version + 1, "removed-actor-conflict", "Denied",
    );
    expect(removedActorConflict.status).toBe(409);
    expect(await removedActorConflict.json()).toMatchObject({ error: { latestChange: {
      actorId: member.user.id,
      actorEmail: null,
      actorIsActiveMember: false,
    } } });
    expect((await app.request(`/api/trips/${trip.id}/history`, { headers: { cookie: member.cookie } })).status).toBe(404);
    expect((await planning(member.cookie, trip.id, place.id, place.version + 1, "removed-actor-read", "Denied")).status).toBe(404);
  });





  function planning(cookie: string, tripId: string, placeId: string, expectedVersion: number, key: string, notes: string, conflictBase?: number) {
    return app.request(`/api/trips/${tripId}/trip-places/${placeId}/planning`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json", origin: "https://app.example.test", "idempotency-key": key,
        ...(conflictBase ? { "Conflict-Base-Version": String(conflictBase) } : {}) },
      body: json({ expectedVersion, notes, durationMinutes: 90, budgetAmountMinor: 1000, budgetCurrency: "JPY" }),
    });
  }

  it("resolves history targets to names and dates without revealing deleted or foreign targets", async () => {
    const owner = await login("target-owner@example.test");
    const trip = await createTrip(owner.cookie, "Named history targets");
    const headers = (key: string) => ({ cookie: owner.cookie, origin: "https://app.example.test", "content-type": "application/json", "idempotency-key": key });
    const skeleton = async () => parseTripSkeletonResponse(await (await app.request(`/api/trips/${trip.id}/skeleton`, { headers: { cookie: owner.cookie } })).json()).skeleton;
    const readTargets = async () => {
      const response = await app.request(`/api/trips/${trip.id}/history?limit=100`, { headers: { cookie: owner.cookie } });
      expect(response.status).toBe(200);
      return (await response.json()).events as Array<Record<string, unknown>>;
    };
    const wishlist = parseTripPlaceResponse(await (await addManual(owner.cookie, trip.id, "target-wishlist", "Named wishlist target", "Kyoto")).json()).tripPlace;
    const inserted = await database.insertInto("places").values({
      trip_id: trip.id,
      name: "Named map target",
      place_type: "activity",
      address: null,
      latitude: null,
      longitude: null,
      time_zone: "Asia/Tokyo",
      source_url: null,
      notes: null,
      created_by: owner.user.id,
    }).returning("id").executeTakeFirstOrThrow();
    const seededPlace = (await skeleton()).places.find((entry) => entry.id === inserted.id)!;
    const updatedPlace = await app.request(`/api/trips/${trip.id}/places/${inserted.id}`, {
      method: "PATCH", headers: headers("target-place"),
      body: json({ ...seededPlace, expectedVersion: seededPlace.version }),
    });
    expect(updatedPlace.status).toBe(200);
    const place = parsePlaceResponse(await updatedPlace.json()).place;
    const fixture = (await skeleton()).items.find((entry) => entry.title === "FIXTURE-OUT")!;
    const createdItem = await app.request(`/api/trips/${trip.id}/items/${fixture.id}`, {
      method: "PATCH", headers: headers("target-item"),
      body: json({
        type: "free-time", title: "Named morning walk", participantMemberIds: null,
        endpoints: [{ role: "start", countryStopId: trip.countryStops[0]!.id, placeId: place.id,
          localDateTime: "2026-10-22T09:00", timeZone: "Asia/Tokyo" }],
        details: { durationMinutes: 60 }, expectedVersion: fixture.version,
      }),
    });
    expect(createdItem.status).toBe(200);
    const item = parseItineraryItemResponse(await createdItem.json()).item;
    const day = trip.days[1]!;
    const assigned = await assignToDay(owner.cookie, trip.id, day.id, [wishlist], "target-day-assignment");
    const assignedPlace = assigned.find((entry) => entry.id === wishlist.id)!;
    const dayVersion = (await database.selectFrom("trip_days").select("version")
      .where("id", "=", day.id).executeTakeFirstOrThrow()).version;
    expect((await saveDay(owner.cookie, trip.id, day.id, "arrangement", "target-day", dayVersion, [assignedPlace.id])).status).toBe(200);
    const named = await readTargets();
    for (const [targetType, targetId, targetName] of [
      ["trip", trip.id, "Named history targets"],
      ["trip_place", wishlist.id, "Named wishlist target"],
      ["place", place.id, "Named map target"],
      ["itinerary_item", item.id, "Named morning walk"],
      ["trip_day", day.id, "2026-10-22"],
    ]) {
      expect(named.find((event) => event.targetType === targetType && event.targetId === targetId)).toMatchObject({ targetName });
    }
    const currentWishlist = (await list(owner.cookie, trip.id)).find((entry) => entry.id === wishlist.id)!;
    expect((await removePlace(owner.cookie, trip.id, currentWishlist, "target-remove-wishlist")).status).toBe(204);
    expect((await app.request(`/api/trips/${trip.id}/items/${item.id}`, {
      method: "DELETE", headers: headers("target-delete-item"), body: json({ expectedVersion: item.version }),
    })).status).toBe(204);
    expect((await app.request(`/api/trips/${trip.id}/places/${place.id}`, {
      method: "DELETE", headers: headers("target-delete-place"), body: json({ expectedVersion: place.version }),
    })).status).toBe(204);
    const removed = await readTargets();
    for (const id of [wishlist.id, place.id, item.id]) {
      expect(removed.find((event) => event.targetId === id)).toMatchObject({ targetName: null });
    }
    const outsider = await login("target-outsider@example.test");
    const privateTrip = await createTrip(outsider.cookie, "Private other trip");
    const privatePlace = parseTripPlaceResponse(await (await addManual(outsider.cookie, privateTrip.id, "foreign-target", "Private foreign cafe", "Osaka")).json()).tripPlace;
    // A historical malformed target reference must not turn the history reader
    // into a cross-trip name lookup.
    const legacy = await database.insertInto("change_events").values({
      trip_id: trip.id, actor_id: owner.user.id, event_type: "trip_place.planning_updated",
      target_type: "trip_place", target_id: privatePlace.id, summary: "Legacy target reference",
    }).returning("id").executeTakeFirstOrThrow();
    expect((await readTargets()).find((event) => event.id === legacy.id)).toMatchObject({ targetName: null });
  });
  it("returns 404 instead of replaying a trip-place response through another trip", async () => {
    const owner = await login("replay-owner@example.test");
    const sourceTrip = await createTrip(owner.cookie, "Replay source trip");
    const routeTrip = await createTrip(owner.cookie, "Replay route trip");
    const sourcePlace = parseTripPlaceResponse(await (await addManual(
      owner.cookie,
      sourceTrip.id,
      "replay-source-place",
      "Source-only place",
      "Kyoto",
    )).json()).tripPlace;
    const key = "cross-trip-notes-replay";
    expect((await planning(
      owner.cookie,
      sourceTrip.id,
      sourcePlace.id,
      sourcePlace.version,
      key,
      "Stored source response",
    )).status).toBe(200);

    expect((await planning(
      owner.cookie,
      routeTrip.id,
      sourcePlace.id,
      sourcePlace.version,
      key,
      "Must not replay",
    )).status).toBe(404);
  });

  async function history(cookie: string, tripId: string) {
    const response = await app.request(`/api/trips/${tripId}/history?limit=100`, { headers: { cookie } });
    expect(response.status).toBe(200);
    return parseTripHistoryResponse(await response.json()).events;
  }

  async function openEvents(cookie: string, tripId: string, after?: string) {
    const controller = new AbortController();
    const response = await app.request(`/api/trips/${tripId}/events`, {
      headers: { cookie, ...(after ? { "Last-Event-ID": after } : {}) }, signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    return {
      async next(): Promise<TripChangeNotification | null> {
        for (;;) {
          const end = buffered.indexOf("\n\n");
          if (end >= 0) {
            const frame = buffered.slice(0, end);
            buffered = buffered.slice(end + 2);
            const data = frame.split("\n").find((line) => line.startsWith("data: "));
            if (!data) continue;
            expect(data).not.toContain("@");
            const event = parseTripChangeNotification(JSON.parse(data.slice(6)));
            expect(frame.split("\n").find((line) => line.startsWith("id: "))).toBe(`id: ${event.id}`);
            expect(Object.keys(JSON.parse(data.slice(6))).sort()).toEqual(["entityId", "entityType", "id", "kind", "summary", "tripVersion"]);
            return event;
          }
          // Bound an actual platform stream read, not a guessed sleep: PostgreSQL and
          // ReadableStream cannot be driven by Vitest's fake timer queue.
          let timer: NodeJS.Timeout | undefined;
          try {
            const chunk = await Promise.race([
              reader.read(),
              new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("SSE read timed out")), 5_000); }),
            ]);
            if (chunk.done) return null;
            buffered += decoder.decode(chunk.value, { stream: true });
          } finally { clearTimeout(timer); }
        }
      },
      async close() { controller.abort(); await reader.cancel(); },
    };
  }





  it("charges actual Google Places calls to daily account and IP budgets without marking quota as an outage", async () => {
    const owner = await login("provider-account-budget@example.test");
    const trip = await createTrip(owner.cookie, "Provider account budget");
    const ip = "198.51.100.44";
    const secret = "trip-place-rate-secret-at-least-32-bytes";
    const day = new Date("2026-09-28T00:00:00.000Z");
    // Only this account's window is one call below its 2,000-call limit; the global and IP
    // windows have room, so the refusal below can only come from the account budget.
    const windows = [
      { scope: "paid_provider:google_places:global", key: "global", seeded: 10 },
      { scope: "paid_provider:google_places:account", key: owner.user.id, seeded: 1_999 },
      { scope: "paid_provider:google_places:ip", key: ip, seeded: 10 },
    ];
    await database.insertInto("rate_limit_windows").values(windows.map((window) => ({
      scope: window.scope,
      key_hash: createHmac("sha256", Buffer.from(secret))
        .update(`${window.scope}:${window.key}`)
        .digest("hex"),
      window_start: day,
      request_count: window.seeded,
    }))).execute();
    const headers = {
      cookie: owner.cookie,
      origin: "https://app.example.test",
      "content-type": "application/json",
      "x-forwarded-for": ip,
    };
    const added = await app.request(`/api/trips/${trip.id}/trip-places`, {
      method: "POST",
      headers: { ...headers, "idempotency-key": "provider-budget-add" },
      body: json({
        method: "search",
        providerPlaceId: provider.kyoto.providerPlaceId,
        sourceUrl: provider.kyoto.sourceUrl,
        originalNote: null,
      }),
    });
    expect(added.status, await added.clone().text()).toBe(201);
    expect(provider.detailRequests).toHaveLength(1);

    const refused = await app.request(`/api/trips/${trip.id}/trip-places/search`, {
      method: "POST",
      headers,
      body: json({ query: "another paid lookup" }),
    });
    expect(refused.status).toBe(503);
    expect(provider.searchRequests).toHaveLength(0);
    expect(await database.selectFrom("rate_limit_windows")
      .select(["scope", "request_count"])
      .where("scope", "like", "paid_provider:google_places:%")
      .orderBy("scope")
      .execute()).toEqual(windows
        .map((window) => ({ scope: window.scope, request_count: window.seeded + 1 }))
        .sort((left, right) => left.scope.localeCompare(right.scope)));
    expect(await database.selectFrom("trip_places")
      .select("provider_unavailable")
      .where("trip_id", "=", trip.id)
      .executeTakeFirstOrThrow()).toEqual({ provider_unavailable: false });
  });

  it("requires authentication for map settings and rejects map reservations before consuming a counter", async () => {
    expect((await app.request("/api/maps/config")).status).toBe(401);
    const owner = await login("maps-security@example.test");
    const configured = await app.request("/api/maps/config", {
      headers: { cookie: owner.cookie },
    });
    expect(configured.status).toBe(200);
    const config = await configured.json();
    expect(Object.keys(config).sort()).toEqual(["browserKey", "mapId"]);
    expect(config).toEqual({ browserKey: "browser-key", mapId: null });

    const unauthenticated = await app.request("/api/maps/load", {
      method: "POST",
      headers: { origin: "https://app.example.test", "x-forwarded-for": "198.51.100.90" },
    });
    expect(unauthenticated.status).toBe(401);
    const foreignOrigin = await app.request("/api/maps/load", {
      method: "POST",
      headers: {
        cookie: owner.cookie,
        origin: "https://evil.example.test",
        "x-forwarded-for": "198.51.100.91",
      },
    });
    expect(foreignOrigin.status).toBe(403);
    expect(await database.selectFrom("rate_limit_windows").select("scope")
      .where("scope", "like", "paid_provider:google_maps_js:%").execute()).toEqual([]);
  });

  it("caps browser map loads globally at 310 across accounts and IPs and starts a new window at Los Angeles midnight", async () => {
    currentNow = new Date("2026-09-28T06:59:00.000Z");
    const owner = await login("maps-load-budget@example.test");
    const second = await login("maps-load-budget-second@example.test");
    const headers = [
      {
        cookie: owner.cookie,
        origin: "https://app.example.test",
        "x-forwarded-for": "198.51.100.45",
      },
      {
        cookie: second.cookie,
        origin: "https://app.example.test",
        "x-forwarded-for": "198.51.100.46",
      },
    ];
    const reserveMap = (reservation: number) => app.request("/api/maps/load", {
      method: "POST",
      headers: headers[reservation % headers.length]!,
    });

    for (let reservation = 1; reservation < 310; reservation += 1) {
      const response = await reserveMap(reservation);
      expect(response.status, `reservation ${reservation}`).toBe(204);
    }
    const threeHundredTenth = await reserveMap(310);
    expect(threeHundredTenth.status).toBe(204);
    const threeHundredEleventh = await reserveMap(311);
    expect(threeHundredEleventh.status).toBe(429);
    expect(await threeHundredEleventh.json()).toMatchObject({
      error: { code: "maps_daily_limit" },
    });

    expect(await database.selectFrom("rate_limit_windows")
      .select(["window_start", "request_count"])
      .where("scope", "=", "paid_provider:google_maps_js:global")
      .execute()).toEqual([{
      window_start: new Date("2026-09-27T07:00:00.000Z"),
      request_count: 310,
    }]);
    expect(await database.selectFrom("rate_limit_windows")
      .select(["scope", "request_count"])
      .where("scope", "in", [
        "paid_provider:google_maps_js:account",
        "paid_provider:google_maps_js:ip",
      ])
      .orderBy("scope")
      .orderBy("key_hash")
      .execute()).toEqual([
      { scope: "paid_provider:google_maps_js:account", request_count: 155 },
      { scope: "paid_provider:google_maps_js:account", request_count: 155 },
      { scope: "paid_provider:google_maps_js:ip", request_count: 155 },
      { scope: "paid_provider:google_maps_js:ip", request_count: 155 },
    ]);

    // Both instants are on September 28 in UTC, but only the latter is on a new LA calendar day.
    currentNow = new Date("2026-09-28T07:00:00.000Z");
    expect((await reserveMap(312)).status).toBe(204);
    expect(await database.selectFrom("rate_limit_windows")
      .select(["window_start", "request_count"])
      .where("scope", "=", "paid_provider:google_maps_js:global")
      .orderBy("window_start")
      .execute()).toEqual([
      { window_start: new Date("2026-09-27T07:00:00.000Z"), request_count: 310 },
      { window_start: new Date("2026-09-28T07:00:00.000Z"), request_count: 1 },
    ]);
  });


  it("purges expired idempotency replays and rate windows at most once per hour", async () => {
    const owner = await login("retention-owner@example.test");
    const trip = await createTrip(owner.cookie, "Retention policy");
    const expired = parseTripPlaceResponse(await (await addManual(
      owner.cookie, trip.id, "expired-replay", "Expired response", "Old",
    )).json()).tripPlace;
    const current = parseTripPlaceResponse(await (await addManual(
      owner.cookie, trip.id, "current-replay", "Current response", "Now",
    )).json()).tripPlace;
    const eightDaysAgo = new Date(now().valueOf() - 8 * 24 * 60 * 60 * 1_000);
    await database.updateTable("mutation_requests").set({ created_at: eightDaysAgo })
      .where("idempotency_key", "=", "expired-replay").execute();
    await database.insertInto("rate_limit_windows").values([
      {
        scope: "trip_content:account",
        key_hash: "a".repeat(64),
        window_start: new Date(now().valueOf() - 2 * 60 * 60 * 1_000),
        request_count: 1,
      },
      {
        scope: "trip_content:account",
        key_hash: "b".repeat(64),
        window_start: now(),
        request_count: 1,
      },
      ...[
        ["paid_provider:google_routes:global", "c", 25 * 60 * 60],
        ["paid_provider:google_routes:account", "d", 23 * 60 * 60],
        ["paid_provider:navitime:global", "e", 25 * 60 * 60],
        ["paid_provider:navitime:ip", "f", 23 * 60 * 60],
        ["route_planning:account", "1", 2 * 60 * 60],
        ["route_planning:ip", "2", 30 * 60],
      ].map(([scope, hash, ageSeconds]) => ({
        scope: String(scope),
        key_hash: String(hash).repeat(64),
        window_start: new Date(now().valueOf() - Number(ageSeconds) * 1_000),
        request_count: 1,
      })),
    ]).execute();

    const retention = new PostgresRetention(database, now);
    expect(await retention.runIfDue()).toBe(true);
    const replaced = parseTripPlaceResponse(await (await addManual(
      owner.cookie, trip.id, "expired-replay", "Replacement response", "New",
    )).json()).tripPlace;
    const replayedCurrent = parseTripPlaceResponse(await (await addManual(
      owner.cookie, trip.id, "current-replay", "Ignored replacement", "Ignored",
    )).json()).tripPlace;

    expect(replaced.id).not.toBe(expired.id);
    expect(replayedCurrent).toEqual(current);
    const rateHashes = (await database.selectFrom("rate_limit_windows").select("key_hash")
      .where("scope", "=", "trip_content:account").execute()).map((row) => row.key_hash);
    expect(rateHashes).toContain("b".repeat(64));
    expect(rateHashes).not.toContain("a".repeat(64));
    expect(await database.selectFrom("rate_limit_windows")
      .select(["scope", "key_hash"])
      .where((expression) => expression.or([
        expression("scope", "like", "paid_provider:google_routes:%"),
        expression("scope", "like", "paid_provider:navitime:%"),
        expression("scope", "like", "route_planning:%"),
      ]))
      .orderBy("scope")
      .execute()).toEqual([
      { scope: "paid_provider:google_routes:account", key_hash: "d".repeat(64) },
      { scope: "paid_provider:navitime:ip", key_hash: "f".repeat(64) },
      { scope: "route_planning:ip", key_hash: "2".repeat(64) },
    ]);

    await database.updateTable("mutation_requests").set({ created_at: eightDaysAgo })
      .where("idempotency_key", "=", "expired-replay").execute();
    expect(await retention.runIfDue()).toBe(false);
    expect(await database.selectFrom("mutation_requests").select("idempotency_key")
      .where("idempotency_key", "=", "expired-replay").execute()).toHaveLength(1);
  });

  it("stores a bounded readback marker for list mutations and re-reads current state on replay", async () => {
    const owner = await login("bounded-replay@example.test");
    const trip = await createTrip(owner.cookie, "Bounded replay");
    const first = parseTripPlaceResponse(await (await addManual(
      owner.cookie, trip.id, "bounded-first", "First", "One",
    )).json()).tripPlace;
    const headers = {
      cookie: owner.cookie,
      origin: "https://app.example.test",
      "content-type": "application/json",
      "idempotency-key": "bounded-list-mutation",
    };
    const body = json({
      assignments: [{
        tripPlaceId: first.id,
        tripDayId: trip.days[1]!.id,
        expectedVersion: first.version,
      }],
    });
    const assigned = await app.request(`/api/trips/${trip.id}/trip-place-day-assignments`, {
      method: "PUT", headers, body,
    });
    expect(assigned.status).toBe(200);
    const stored = await database.selectFrom("mutation_requests")
      .select([
        "response",
        sql<number>`pg_column_size(response)`.as("bytes"),
      ])
      .where("idempotency_key", "=", "bounded-list-mutation")
      .executeTakeFirstOrThrow();
    expect(stored.response).toEqual({ type: "trip_places_readback" });
    expect(stored.bytes).toBeLessThan(100);

    const later = parseTripPlaceResponse(await (await addManual(
      owner.cookie, trip.id, "bounded-later", "Later", "Two",
    )).json()).tripPlace;
    const replay = await app.request(`/api/trips/${trip.id}/trip-place-day-assignments`, {
      method: "PUT", headers, body,
    });
    expect(replay.status).toBe(200);
    expect(parseTripPlaceListResponse(await replay.json()).tripPlaces.map((place) => place.id))
      .toContain(later.id);
  });

  it("sends no queued SSE payload after membership is revoked between batch read and send", async () => {
    const owner = await login("stream-gate-owner@example.test");
    const member = await login("stream-gate-member@example.test");
    const trip = await createTrip(owner.cookie, "SSE per-event authorization");
    await addMember(trip.id, member.user.id);
    const checkpoint = (await history(owner.cookie, trip.id))[0]!.id;
    await addManual(owner.cookie, trip.id, "stream-gate-place", "Queued private place", "Private district");
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const batchRead = new Promise<void>((resolve) => { reached = resolve; });
    const originalAfter = collaboration.after.bind(collaboration);
    const after = vi.spyOn(collaboration, "after").mockImplementationOnce(async (...args) => {
      const events = await originalAfter(...args);
      expect(events.some((event) => event.notification.entityType === "trip_place")).toBe(true);
      reached();
      await gate;
      return events;
    });
    const stream = await openEvents(member.cookie, trip.id, checkpoint);
    try {
      await batchRead;
      expect((await app.request(`/api/trips/${trip.id}/members/${member.user.id}`, {
        method: "DELETE", headers: { cookie: owner.cookie, origin: "https://app.example.test", "idempotency-key": "stream-gate-revoke" },
      })).status).toBe(204);
      release();
      expect(await stream.next()).toBeNull();
    } finally { release(); after.mockRestore(); await stream.close(); }
  });

  it("keeps independent aggregate edits, reports stale attribution, and never partly writes a conflict", async () => {
    const first = await login("first@example.test");
    const second = await login("second@example.test");
    const trip = await createTrip(first.cookie, "Concurrent aggregate edits");
    await addMember(trip.id, second.user.id);
    const a = parseTripPlaceResponse(await (await addManual(first.cookie, trip.id, "concurrent-a", "A", "A")).json()).tripPlace;
    const b = parseTripPlaceResponse(await (await addManual(first.cookie, trip.id, "concurrent-b", "B", "B")).json()).tripPlace;
    const [one, two] = await Promise.all([
      planning(first.cookie, trip.id, a.id, a.version, "a-save", "First saved"),
      planning(second.cookie, trip.id, b.id, b.version, "b-save", "Second saved"),
    ]);
    expect([one.status, two.status]).toEqual([200, 200]);
    const saved = parseTripPlaceResponse(await one.json()).tripPlace;
    expect((await list(second.cookie, trip.id)).map((place) => place.notes).sort()).toEqual(["First saved", "Second saved"]);
    const before = await history(first.cookie, trip.id);
    const conflict = await planning(second.cookie, trip.id, a.id, a.version, "a-stale", "Must not leak into saved notes");
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: {
      code: "conflict", currentVersion: saved.version,
      latestChange: { actorId: first.user.id, actorDisplayName: "first", eventId: before.find((event) => event.targetId === a.id)!.id, changedAt: expect.any(String) },
    } });
    expect((await list(first.cookie, trip.id)).find((place) => place.id === a.id)).toEqual(saved);
    expect(await history(first.cookie, trip.id)).toEqual(before);
    const replay = await planning(first.cookie, trip.id, a.id, a.version, "a-save", "First saved");
    expect(parseTripPlaceResponse(await replay.json()).tripPlace).toEqual(saved);
    expect(await history(first.cookie, trip.id)).toEqual(before);
    const reapplied = await planning(second.cookie, trip.id, a.id, saved.version, "a-reapply", "My complete input", a.version);
    expect(reapplied.status).toBe(200);
    const current = parseTripPlaceResponse(await reapplied.json()).tripPlace;
    expect(current).toMatchObject({ notes: "My complete input", durationMinutes: 90, budgetAmountMinor: 1000, budgetCurrency: "JPY" });
    expect((await history(first.cookie, trip.id))[0]).toMatchObject({ actorId: second.user.id, reappliedFromVersion: a.version, targetId: a.id });
    expect((await removePlace(first.cookie, trip.id, current, "remove-reapplied")).status).toBe(204);
    const beforeDeletedReapply = await history(first.cookie, trip.id);
    const deleted = await planning(second.cookie, trip.id, a.id, current.version, "deleted-reapply", "Cannot resurrect", a.version);
    expect(deleted.status).toBe(404);
    expect(await deleted.json()).toMatchObject({ error: { code: "trip_place_not_found" } });
    expect(await history(first.cookie, trip.id)).toEqual(beforeDeletedReapply);
  });

  it("streams safe ordered hints to four members, catches up exactly once and revokes an open stream", async () => {
    const owner = await login("stream-owner@example.test");
    const members = [owner];
    for (const name of ["two", "three", "four"]) members.push(await login(`stream-${name}@example.test`));
    const outsider = await login("stream-outsider@example.test");
    const trip = await createTrip(owner.cookie, "Four member stream");
    for (const member of members.slice(1)) await addMember(trip.id, member.user.id);
    const other = await createTrip(owner.cookie, "Other isolated trip");
    const place = parseTripPlaceResponse(await (await addManual(owner.cookie, trip.id, "stream-place", "Private place", "Private address")).json()).tripPlace;
    const before = (await history(owner.cookie, trip.id))[0]!;
    expect((await app.request(`/api/trips/${trip.id}/events`, { headers: { cookie: outsider.cookie } })).status).toBe(404);
    expect((await app.request(`/api/trips/${trip.id}/events`)).status).toBe(401);
    const foreignCursor = (await history(owner.cookie, other.id))[0]!.id;
    expect((await app.request(`/api/trips/${trip.id}/events`, { headers: { cookie: owner.cookie, "Last-Event-ID": foreignCursor } })).status).toBe(400);
    const streams = await Promise.all(members.map((member) => openEvents(member.cookie, trip.id, before.id)));
    try {
      await addManual(owner.cookie, other.id, "isolated-change", "Never cross trips", "Sensitive other address");
      const updated = await planning(members[3]!.cookie, trip.id, place.id, place.version, "stream-update", "PRIVATE HEALTH NOTE provider token session secret");
      expect(updated.status).toBe(200);
      const firstEvent = await streams[0]!.next();
      expect(firstEvent).toMatchObject({ entityId: place.id, kind: "trip_place.planning_updated" });
      expect(JSON.stringify(firstEvent)).not.toMatch(/PRIVATE|HEALTH|@|secret|Private place|Private address|Never cross/);
      for (const stream of streams.slice(1)) expect(await stream.next()).toEqual(firstEvent);
      await streams[1]!.close();
      const current = parseTripPlaceResponse(await updated.json()).tripPlace;
      const secondUpdate = await planning(owner.cookie, trip.id, place.id, current.version, "stream-update-2", "Second private note");
      const nextPlace = parseTripPlaceResponse(await secondUpdate.json()).tripPlace;
      await planning(owner.cookie, trip.id, place.id, nextPlace.version, "stream-update-3", "Third private note");
      const secondEvent = await streams[0]!.next();
      const thirdEvent = await streams[0]!.next();
      expect(secondEvent!.tripVersion).toBeGreaterThan(firstEvent!.tripVersion);
      expect(thirdEvent!.tripVersion).toBeGreaterThan(secondEvent!.tripVersion);
      const resumed = await openEvents(members[1]!.cookie, trip.id, firstEvent!.id);
      try {
        expect(await resumed.next()).toEqual(secondEvent);
        expect(await resumed.next()).toEqual(thirdEvent);
      } finally { await resumed.close(); }
      expect(await streams[3]!.next()).toEqual(secondEvent);
      expect(await streams[3]!.next()).toEqual(thirdEvent);
      const removed = await app.request(`/api/trips/${trip.id}/members/${members[3]!.user.id}`, {
        method: "DELETE", headers: { cookie: owner.cookie, origin: "https://app.example.test", "idempotency-key": "revoke-stream" },
      });
      expect(removed.status).toBe(204);
      expect(await streams[3]!.next()).toBeNull();
      for (const path of ["events", "history", "version", "trip-places", "skeleton"]) {
        expect((await app.request(`/api/trips/${trip.id}/${path}`, { headers: { cookie: members[3]!.cookie, "Last-Event-ID": firstEvent!.id } })).status).toBe(404);
      }
      expect((await planning(members[3]!.cookie, trip.id, place.id, nextPlace.version + 1, "removed-save", "Denied")).status).toBe(404);
      expect((await history(owner.cookie, trip.id)).find((event) => event.id === firstEvent!.id)).toMatchObject({ actorId: members[3]!.user.id, actorDisplayName: "stream-four" });
    } finally { await Promise.all(streams.map((stream) => stream.close())); }
  }, 20_000);

  it("caps concurrent event streams per account and releases capacity when one closes", async () => {
    const owner = await login("stream-cap-owner@example.test");
    const trip = await createTrip(owner.cookie, "Bounded event streams");
    const checkpoint = (await history(owner.cookie, trip.id))[0]!.id;
    const streams = await Promise.all(
      Array.from({ length: 6 }, () => openEvents(owner.cookie, trip.id, checkpoint)),
    );
    try {
      const rejected = await app.request(`/api/trips/${trip.id}/events`, {
        headers: { cookie: owner.cookie, "Last-Event-ID": checkpoint },
      });
      expect(rejected.status).toBe(429);
      expect(await rejected.json()).toMatchObject({ error: { code: "rate_limited" } });
      let remainingIdleReads = streams.length;
      const idleReads = Promise.withResolvers<void>();
      afterReadObserver = () => {
        remainingIdleReads -= 1;
        if (remainingIdleReads === 0) idleReads.resolve();
      };
      const callsAfterOpening = identityAuthenticateCalls;
      await idleReads.promise;
      expect(identityAuthenticateCalls).toBe(callsAfterOpening);

      await streams.pop()!.close();
      const replacement = await openEvents(owner.cookie, trip.id, checkpoint);
      await replacement.close();
    } finally {
      afterReadObserver = null;
      await Promise.all(streams.map((stream) => stream.close()));
    }
  }, 15_000);

  async function list(cookie: string, tripId: string) {
    const response = await app.request(`/api/trips/${tripId}/trip-places`, {
      headers: { cookie },
    });
    expect(response.status).toBe(200);
    return parseTripPlaceListResponse(await response.json()).tripPlaces;
  }

  async function setVote(
    cookie: string,
    tripId: string,
    tripPlaceId: string,
    voted: boolean,
    key: string,
  ) {
    return app.request(
      `/api/trips/${tripId}/trip-places/${tripPlaceId}/vote`,
      {
        method: "PUT",
        headers: {
          cookie,
          "content-type": "application/json",
          "idempotency-key": key,
          origin: "https://app.example.test",
        },
        body: json({ voted }),
      },
    );
  }

  function removePlace(cookie: string, tripId: string, place: TripPlaceDto, key: string) {
    return app.request(`/api/trips/${tripId}/trip-places/${place.id}/remove`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "idempotency-key": key, origin: "https://app.example.test" },
      body: json({ expectedVersion: place.version }),
    });
  }

  it("refuses re-adding an archived travel-only identity without restoring its wishlist row", async () => {
    const owner = await login("owner@example.test");
    const trip = await createTrip(owner.cookie, "Archived travel place");
    const created = await addProvider(owner.cookie, trip.id, "travel-original", "Original contribution");
    expect(created.status).toBe(201);
    const place = parseTripPlaceResponse(await created.json()).tripPlace;
    const row = await database.selectFrom("trip_places").select("legacy_place_id")
      .where("id", "=", place.id).executeTakeFirstOrThrow();
    // A retained provider identity can be archived by migration 016; it remains addressable
    // by a later search result, but explicit intake must not unarchive its travel-only row.
    await database.updateTable("places").set({ travel_only: true }).where("id", "=", row.legacy_place_id).execute();
    await database.updateTable("trip_places").set({ archived_at: new Date("2026-10-01T00:00:00Z") })
      .where("id", "=", place.id).execute();
    const before = await database.selectFrom("trip_place_contributions").selectAll()
      .where("trip_place_id", "=", place.id).execute();
    const rejected = await addProvider(owner.cookie, trip.id, "travel-readd", "Must not be saved");
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ error: { code: "travel_place" } });
    expect(await list(owner.cookie, trip.id)).toEqual([]);
    expect(await database.selectFrom("trip_place_contributions").selectAll()
      .where("trip_place_id", "=", place.id).execute()).toEqual(before);
    const skeleton = await app.request(`/api/trips/${trip.id}/skeleton`, { headers: { cookie: owner.cookie } });
    expect(parseTripSkeletonResponse(await skeleton.json()).skeleton.places.find((entry) => entry.id === row.legacy_place_id)?.name).toBe(place.name);
  });

  it("normalizes active travel mirrors from a retained release without deleting contributions or formal content", async () => {
    const owner = await login("owner@example.test");
    const trip = await createTrip(owner.cookie, "Travel mirror after redeploy");
    // Votes need two active members.
    const second = await login("second@example.test");
    await addMember(trip.id, second.user.id);
    const skeletonResponse = await app.request(`/api/trips/${trip.id}/skeleton`, { headers: { cookie: owner.cookie } });
    const before = parseTripSkeletonResponse(await skeletonResponse.json()).skeleton;
    const airport = before.places.find((place) => place.type === "airport")!;
    // Simulate a retained release, whose reconciliation does not know about the flag.
    await database.updateTable("places").set({ travel_only: false }).where("id", "=", airport.id).execute();
    const mirrored = (await list(owner.cookie, trip.id)).find((place) => place.name === airport.name)!;
    const ordinaryResponse = await addProvider(owner.cookie, trip.id, "ordinary-redeploy", "Keep this wishlist place");
    const ordinary = parseTripPlaceResponse(await ordinaryResponse.json()).tripPlace;
    for (const place of [mirrored, ordinary]) {
      expect((await setVote(owner.cookie, trip.id, place.id, true, `redeploy-vote-${place.id}`)).status).toBe(200);
      await database.insertInto("trip_place_desired_days").values({
        trip_id: trip.id, trip_place_id: place.id, trip_day_id: trip.days[0]!.id,
      }).execute();
      await database.insertInto("trip_place_excluded_days").values({
        trip_id: trip.id, trip_place_id: place.id, trip_day_id: trip.days[1]!.id,
      }).execute();
    }
    const contributions = await database.selectFrom("trip_place_contributions").selectAll()
      .where("trip_place_id", "=", mirrored.id).execute();
    await database.updateTable("places").set({ travel_only: true }).where("id", "=", airport.id).execute();
    expect((await list(owner.cookie, trip.id)).map((place) => place.id)).toEqual([ordinary.id]);
    for (const table of ["trip_place_desired_days", "trip_place_excluded_days", "trip_place_day_assignments", "trip_place_votes"] as const) {
      expect(await database.selectFrom(table).selectAll().where("trip_place_id", "=", mirrored.id).execute(), table).toEqual([]);
      expect(await database.selectFrom(table).select("trip_place_id").where("trip_place_id", "=", ordinary.id).execute(), table)
        .toEqual([{ trip_place_id: ordinary.id }]);
    }
    expect(await database.selectFrom("trip_place_contributions").selectAll().where("trip_place_id", "=", mirrored.id).execute()).toEqual(contributions);
    const archived = await database.selectFrom("trip_places").selectAll().where("id", "=", mirrored.id).executeTakeFirstOrThrow();
    expect(archived.archived_at).not.toBeNull();
    expect((await list(owner.cookie, trip.id)).map((place) => place.id)).toEqual([ordinary.id]);
    expect(await database.selectFrom("trip_places").selectAll().where("id", "=", mirrored.id).executeTakeFirstOrThrow()).toEqual(archived);
    const afterResponse = await app.request(`/api/trips/${trip.id}/skeleton`, { headers: { cookie: owner.cookie } });
    const after = parseTripSkeletonResponse(await afterResponse.json()).skeleton;
    expect(after.items).toEqual(before.items);
    expect(after.places).toContainEqual(airport);
  });

  it("replays wishlist intake when the trip path UUID uses different casing", async () => {
    const owner = await login("owner@example.test");
    const trip = await createTrip(owner.cookie, "Canonical idempotency trip");
    const first = await addManual(
      owner.cookie,
      trip.id,
      "case-variant-add",
      "One family cafe",
      "Kyoto",
    );
    const replay = await addManual(
      owner.cookie,
      trip.id.toUpperCase(),
      "case-variant-add",
      "One family cafe",
      "Kyoto",
    );

    expect(replay.status).toBe(201);
    expect(parseTripPlaceResponse(await replay.json()).tripPlace)
      .toEqual(parseTripPlaceResponse(await first.json()).tripPlace);
    expect(await database.selectFrom("trip_places").select("id")
      .where("trip_id", "=", trip.id).execute()).toHaveLength(1);
    expect(await database.selectFrom("change_events").select("id")
      .where("trip_id", "=", trip.id)
      .where("event_type", "=", "trip_place.created")
      .execute()).toHaveLength(1);
  });

  it.each(["search", "google-maps-url"] as const)("refuses duplicate %s intake without another contribution and allows re-add after removal", async (method) => {
    const owner = await login("owner@example.test");
    const second = await login("second@example.test");
    const third = await login("third@example.test");
    const fourth = await login("fourth@example.test");
    const trip = await createTrip(owner.cookie, "Shared Kyoto places");
    await addMember(trip.id, second.user.id);
    await addMember(trip.id, third.user.id);
    await addMember(trip.id, fourth.user.id);

    const firstResponse = await addProvider(
      owner.cookie,
      trip.id,
      "owner-add-kiyomizu",
      "Sunset if possible",
      method,
    );
    expect(firstResponse.status).toBe(201);
    const first = parseTripPlaceResponse(await firstResponse.json()).tripPlace;

    const replay = await addProvider(
      owner.cookie,
      trip.id,
      "owner-add-kiyomizu",
      "Sunset if possible",
    );
    expect(parseTripPlaceResponse(await replay.json()).tripPlace.id).toBe(first.id);

    expect(first).toMatchObject({ notes: "Sunset if possible", sourceUrl: provider.kyoto.sourceUrl });
    const contributions = await database.selectFrom("trip_place_contributions").selectAll()
      .where("trip_place_id", "=", first.id).execute();
    const secondResponse = await addProvider(
      second.cookie, trip.id, "second-add-kiyomizu", "Must not replace the note", method,
    );
    expect(secondResponse.status).toBe(409);
    expect(await secondResponse.json()).toMatchObject({ error: { code: "already_in_wishlist" } });
    expect(await database.selectFrom("trip_place_contributions").selectAll()
      .where("trip_place_id", "=", first.id).execute()).toEqual(contributions);
    expect(await list(owner.cookie, trip.id)).toEqual([first]);
    expect(await list(owner.cookie, trip.id)).toHaveLength(1);

    for (const actor of [owner, second, third, fourth]) {
      const response = await setVote(actor.cookie, trip.id, first.id, true, `vote-${actor.user.id}`);
      expect(response.status).toBe(200);
    }
    const read = (await list(owner.cookie, trip.id))[0]!;
    expect(read.voteCount).toBe(4);
    expect(read.voters.map((entry) => entry.memberUserId)).toEqual([
      owner.user.id, second.user.id, third.user.id, fourth.user.id,
    ]);
    expect(read.ownVote).toBe(true);
    await database.updateTable("trip_places").set({
      selected_for_itinerary: true,
      unplaced_from_date: "2026-10-22",
    }).where("id", "=", first.id).execute();
    expect((await removePlace(owner.cookie, trip.id, read, "remove-duplicate")).status).toBe(204);
    const readded = await addProvider(second.cookie, trip.id, "readd-kiyomizu", "Easy drop-off", method);
    expect(readded.status).toBe(201);
    const restored = parseTripPlaceResponse(await readded.json()).tripPlace;
    expect(restored).toMatchObject({
      id: first.id,
      notes: "Easy drop-off",
      voteCount: 0,
      assignedDayId: null,
      selectedForItinerary: false,
      unplacedFromDate: null,
    });
    expect((await list(owner.cookie, trip.id))[0]?.notes).toBe("Easy drop-off");
    const skeleton = await app.request(`/api/trips/${trip.id}/skeleton`, { headers: { cookie: owner.cookie } });
    expect(parseTripSkeletonResponse(await skeleton.json()).skeleton.places.find((place) => place.name === first.name)?.notes)
      .toBe("Easy drop-off");
  });

  it("serializes competing provider additions into one wishlist row and contribution", async () => {
    const owner = await login("owner@example.test");
    const second = await login("second@example.test");
    const trip = await createTrip(owner.cookie, "Concurrent provider intake");
    await addMember(trip.id, second.user.id);
    const results = await Promise.all([
      addProvider(owner.cookie, trip.id, "concurrent-owner", "Owner note"),
      addProvider(second.cookie, trip.id, "concurrent-second", "Second note", "google-maps-url"),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([201, 409]);
    const winner = parseTripPlaceResponse(await results.find((response) => response.status === 201)!.json()).tripPlace;
    expect(await results.find((response) => response.status === 409)!.json())
      .toMatchObject({ error: { code: "already_in_wishlist" } });
    expect((await list(owner.cookie, trip.id)).map((place) => place.id)).toEqual([winner.id]);
    expect(await database.selectFrom("trip_place_contributions").select(["trip_place_id", "original_note"])
      .where("trip_id", "=", trip.id).execute()).toEqual([{ trip_place_id: winner.id, original_note: winner.notes }]);
  });

  it("coalesces concurrent replays before fetching provider place details", async () => {
    const owner = await login("owner@example.test");
    const trip = await createTrip(owner.cookie, "Concurrent idempotent provider intake");
    const releaseFirst = Promise.withResolvers<void>();
    const firstReached = Promise.withResolvers<void>();
    provider.detailGate = async (requestNumber) => {
      if (requestNumber !== 1) return;
      firstReached.resolve();
      await releaseFirst.promise;
    };

    const first = addProvider(owner.cookie, trip.id, "concurrent-replay", "Family note");
    await firstReached.promise;
    const replay = addProvider(owner.cookie, trip.id, "concurrent-replay", "Family note");
    // The second request joins the same in-process intake before either one opens the write
    // transaction; releasing the provider lets both observe the one remembered response.
    await Promise.resolve();
    releaseFirst.resolve();
    const responses = await Promise.all([first, replay]);
    provider.detailGate = null;

    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    const places = await Promise.all(
      responses.map(async (response) => parseTripPlaceResponse(await response.json()).tripPlace),
    );
    expect(places[1]).toEqual(places[0]);
    expect(provider.detailRequests).toHaveLength(1);
  });

  it("finishes Google and Wikimedia intake before opening the add-place transaction", async () => {
    const owner = await login("transaction-owner@example.test");
    const trip = await createTrip(owner.cookie, "Provider transaction boundary");
    const providerReached = Promise.withResolvers<void>();
    const releaseProvider = Promise.withResolvers<void>();
    provider.detailGate = async () => {
      providerReached.resolve();
      await releaseProvider.promise;
    };

    const response = addProvider(owner.cookie, trip.id, "outside-transaction", "No pooled wait");
    await providerReached.promise;
    const pool = new Pool({ connectionString: databaseUrl });
    const activity = await pool.query<{ count: string }>(`
      select count(*)::text as count
      from pg_stat_activity
      where datname = current_database()
        and state = 'idle in transaction'
        and query like '%mutation_requests%'
    `);
    releaseProvider.resolve();
    await pool.end();
    provider.detailGate = null;

    expect(activity.rows[0]?.count).toBe("0");
    expect((await response).status).toBe(201);
  });

  it("lists newest first whatever the votes, ignores removed members, and keeps voting for a single member", async () => {
    const owner = await login("owner@example.test");
    const second = await login("second@example.test");
    const third = await login("third@example.test");
    const trip = await createTrip(owner.cookie, "Vote ordering trip");
    await addMember(trip.id, second.user.id);
    await addMember(trip.id, third.user.id);
    const places = [];
    for (const name of ["Zero", "One", "Two", "Tie"]) {
      places.push(parseTripPlaceResponse(await (await addManual(owner.cookie, trip.id, `add-${name}`, name, name)).json()).tripPlace);
    }
    const [zero, one, two, tie] = places as [TripPlaceDto, TripPlaceDto, TripPlaceDto, TripPlaceDto];
    // Establish a deterministic creation order independently of clock precision.
    for (const [index, place] of places.entries()) {
      await database.updateTable("trip_places").set({ created_at: new Date(now().getTime() + index) }).where("id", "=", place.id).execute();
    }
    for (const [actor, place] of [[owner, one], [owner, two], [second, two], [owner, tie], [third, zero]] as const) {
      expect((await setVote(actor.cookie, trip.id, place.id, true, `${actor.user.id}-${place.id}`)).status).toBe(200);
    }
    const remove = (memberId: string) => app.request(`/api/trips/${trip.id}/members/${memberId}`, {
      method: "DELETE",
      headers: { cookie: owner.cookie, "idempotency-key": `remove-${memberId}`, origin: "https://app.example.test" },
    });
    expect((await remove(third.user.id)).status).toBe(204);
    expect((await list(owner.cookie, trip.id)).map((place) => [place.id, place.voteCount]))
      // Votes never reorder the list (owner decision): newest added first.
      .toEqual([[tie.id, 1], [two.id, 2], [one.id, 1], [zero.id, 0]]);
    const impersonated = await app.request(`/api/trips/${trip.id}/trip-places/${one.id}/vote`, {
      method: "PUT",
      headers: { cookie: owner.cookie, "content-type": "application/json", "idempotency-key": "cannot-vote-for-another", origin: "https://app.example.test" },
      body: json({ voted: true, memberUserId: second.user.id }),
    });
    expect(impersonated.status).toBe(200);
    expect(parseTripPlaceResponse(await impersonated.json()).tripPlace.voters.map((member) => member.memberUserId)).toEqual([owner.user.id]);
    expect((await setVote(owner.cookie, trip.id, one.id, true, "repeat-set")).status).toBe(200);
    expect((await setVote(owner.cookie, trip.id, one.id, false, "remove-vote")).status).toBe(200);
    expect((await setVote(owner.cookie, trip.id, one.id, false, "repeat-remove")).status).toBe(200);
    expect((await list(owner.cookie, trip.id)).find((place) => place.id === one.id)).toMatchObject({ voteCount: 0, ownVote: false });
    expect((await remove(second.user.id)).status).toBe(204);
    // A solo traveller can still vote (owner decision 2026-10-14).
    expect((await setVote(owner.cookie, trip.id, two.id, true, `single-true`)).status).toBe(200);
    const solo = await list(owner.cookie, trip.id);
    expect(solo.every((place) => place.votingAvailable)).toBe(true);
    expect(solo.find((place) => place.id === two.id)).toMatchObject({ voteCount: 1, ownVote: true });
    expect(solo.map((place) => place.voteCount)).toEqual([...solo.map((place) => place.voteCount)].sort((a, b) => b - a));
    expect((await setVote(owner.cookie, trip.id, two.id, false, `single-false`)).status).toBe(200);
    expect((await list(owner.cookie, trip.id)).find((place) => place.id === two.id)).toMatchObject({ voteCount: 0, ownVote: false });
  });

  it("lets an editor merge two unscheduled places and unions votes without duplication", async () => {
    const owner = await login("owner@example.test");
    const second = await login("second@example.test");
    const trip = await createTrip(owner.cookie, "Vote merge trip");
    await addMember(trip.id, second.user.id);
    const source = parseTripPlaceResponse(await (await addManual(owner.cookie, trip.id, "union-source", "Cafe", "North")).json()).tripPlace;
    const target = parseTripPlaceResponse(await (await addManual(owner.cookie, trip.id, "union-target", "Cafe", "South")).json()).tripPlace;
    for (const [actor, place] of [[owner, source], [second, source], [owner, target]] as const) {
      expect((await setVote(actor.cookie, trip.id, place.id, true, `union-${actor.user.id}-${place.id}`)).status).toBe(200);
    }
    const current = await list(owner.cookie, trip.id);
    const selfMerge = await app.request(`/api/trips/${trip.id}/trip-places/${source.id}/merge`, {
      method: "POST",
      headers: { cookie: second.cookie, "content-type": "application/json", "idempotency-key": "union-self-merge", origin: "https://app.example.test" },
      body: json({
        targetTripPlaceId: source.id.toUpperCase(),
        expectedSourceVersion: current.find((place) => place.id === source.id)!.version,
        expectedTargetVersion: current.find((place) => place.id === source.id)!.version,
      }),
    });
    expect(selfMerge.status).toBe(400);
    expect(await selfMerge.json()).toMatchObject({ error: { code: "validation_error" } });
    const merged = await app.request(`/api/trips/${trip.id}/trip-places/${source.id}/merge`, {
      method: "POST",
      headers: { cookie: second.cookie, "content-type": "application/json", "idempotency-key": "union-merge", origin: "https://app.example.test" },
      body: json({
        targetTripPlaceId: target.id.toUpperCase(),
        expectedSourceVersion: current.find((place) => place.id === source.id)!.version,
        expectedTargetVersion: current.find((place) => place.id === target.id)!.version,
      }),
    });
    expect(merged.status).toBe(200);
    const place = parseTripPlaceResponse(await merged.json()).tripPlace;
    expect(place.voteCount).toBe(2);
    expect(place.voters.map((member) => member.memberUserId)).toEqual([owner.user.id, second.user.id]);
    expect(await database.selectFrom("trip_place_votes").selectAll().where("trip_place_id", "=", source.id).execute()).toEqual([]);
  });

  it("replays old stored wishlist responses with source URLs and empty vote defaults", async () => {
    const owner = await login("owner@example.test");
    const trip = await createTrip(owner.cookie, "Old vote reply trip");
    const first = await addManual(owner.cookie, trip.id, "old-add", "Old cafe", "Kyoto");
    expect(first.status).toBe(201);
    const place = parseTripPlaceResponse(await first.json()).tripPlace;
    await sql`
      update mutation_requests
      set response = (response - 'sourceUrl' - 'voters' - 'voteCount' - 'ownVote' - 'votingAvailable')
        || '{"preferences":[],"preferenceConflict":false,"contributions":[{"sourceUrl":"https://example.test/original"}]}'::jsonb
      where actor_id = ${owner.user.id} and operation = ${`tp:add:${trip.id}`} and idempotency_key = 'old-add'
    `.execute(database);
    const replay = await addManual(owner.cookie, trip.id, "old-add", "Old cafe", "Kyoto");
    expect(replay.status).toBe(201);
    expect(parseTripPlaceResponse(await replay.json()).tripPlace).toMatchObject({
      id: place.id, voters: [], voteCount: 0, ownVote: false, votingAvailable: false,
      sourceUrl: "https://example.test/original",
    });
    const assignments = { assignments: [{ tripPlaceId: place.id, tripDayId: trip.days[0]!.id, expectedVersion: place.version }] };
    const request = {
      method: "PUT",
      headers: { cookie: owner.cookie, "content-type": "application/json", "idempotency-key": "old-assignment", origin: "https://app.example.test" },
      body: json(assignments),
    };
    const firstAssignment = await app.request(`/api/trips/${trip.id}/trip-place-day-assignments`, request);
    expect(firstAssignment.status).toBe(200);
    const historical = await firstAssignment.json() as { tripPlaces: Array<Record<string, unknown>> };
    await database.updateTable("mutation_requests").set({
      response: {
        tripPlaces: historical.tripPlaces.map((entry) => {
          const {
            sourceUrl: _sourceUrl,
            voters: _voters,
            voteCount: _voteCount,
            ownVote: _ownVote,
            votingAvailable: _votingAvailable,
            ...stored
          } = entry;
          return stored;
        }),
      },
    })
      .where("actor_id", "=", owner.user.id)
      .where("operation", "=", `tp:day-assignments:${trip.id}`)
      .where("idempotency_key", "=", "old-assignment")
      .execute();
    const replayList = await app.request(`/api/trips/${trip.id}/trip-place-day-assignments`, request);
    expect(replayList.status).toBe(200);
    expect(parseTripPlaceListResponse(await replayList.json()).tripPlaces[0]).toMatchObject({
      id: place.id, assignedDayId: trip.days[0]!.id, voters: [], voteCount: 0, ownVote: false, votingAvailable: false,
      sourceUrl: null,
    });
  });


  it("presents retained Place edits as member facts without falsifying provider freshness", async () => {
    const owner = await login("owner@example.test");
    const trip = await createTrip(owner.cookie, "Provider fact override trip");
    const created = parseTripPlaceResponse(
      await (await addProvider(
        owner.cookie,
        trip.id,
        "provider-place-before-legacy-edit",
        "Original provider contribution",
      )).json(),
    ).tripPlace;
    const legacy = await database.selectFrom("trip_places")
      .select("legacy_place_id")
      .where("id", "=", created.id)
      .executeTakeFirstOrThrow();

    await database.updateTable("places").set({
      name: "Member corrected temple name",
      address: "Member corrected address",
      version: sql`version + 1`,
      updated_at: new Date("2026-09-30T12:00:00.000Z"),
    }).where("id", "=", legacy.legacy_place_id).execute();

    expect((await list(owner.cookie, trip.id))[0]).toMatchObject({
      name: "Member corrected temple name",
      address: "Member corrected address",
      provider: "google",
      providerPlaceId: provider.kyoto.providerPlaceId,
      providerObservedAt: null,
      providerExpiresAt: null,
      factsSource: "member",
    });
  });

  it("localizes and ranks place search, scopes region bias, and marks active provider identities", async () => {
    const owner = await login("search-owner@example.test");
    const trip = await createTrip(owner.cookie, "Localized provider search");
    const search = async (query: string) => app.request(`/api/trips/${trip.id}/trip-places/search`, {
      method: "POST",
      headers: { cookie: owner.cookie, "content-type": "application/json", origin: "https://app.example.test" },
      body: json({ query }),
    });

    const initial = await search("Kiyomizu Cafe");
    expect(initial.status).toBe(200);
    const initialCandidates = parseProviderCandidatesResponse(await initial.json()).candidates;
    expect(initialCandidates.map((candidate) => candidate.name)).toEqual(["Kiyomizu Cafe", "Kiyomizu-dera"]);
    expect(initialCandidates[0]).toMatchObject({
      alreadyInWishlist: false,
      typeLabel: "咖啡店",
      photo: {
        source: "google",
        id: `google:${provider.branch.providerPlaceId}:0:ab695b0da15727f7`,
        thumbnailUrl: expect.stringContaining(`/api/trips/${trip.id}/google-place-photos/${provider.branch.providerPlaceId}?index=0&photo=ab695b0da15727f7&resource=controlled&maxWidth=192&exp=`),
      },
    });
    expect(provider.searchRequests.at(-1)).toEqual({
      query: "Kiyomizu Cafe",
      options: { languageCode: "zh-TW", regionCode: "JP", pageSize: 3 },
    });

    expect((await addProvider(owner.cookie, trip.id, "localized-confirm", "想去")).status).toBe(201);
    expect(provider.detailRequests.at(-1)).toEqual({
      providerPlaceId: provider.kyoto.providerPlaceId,
      options: { languageCode: "zh-TW", regionCode: "JP" },
    });
    const active = parseProviderCandidatesResponse(await (await search("Kiyomizu-dera")).json()).candidates;
    expect(active.find((candidate) => candidate.providerPlaceId === provider.kyoto.providerPlaceId)?.alreadyInWishlist).toBe(true);

    await database.insertInto("trip_country_stops").values({
      trip_id: trip.id,
      country_code: "TW",
      position: 1,
      time_zone: "Asia/Taipei",
    }).execute();
    expect((await search("Kiyomizu-dera")).status).toBe(200);
    expect(provider.searchRequests.at(-1)?.options).toEqual({ languageCode: "zh-TW", pageSize: 3 });
  });

  it("resolves approved URL intake and keeps same Place data isolated across trips", async () => {
    const owner = await login("owner@example.test");
    const firstTrip = await createTrip(owner.cookie, "First provider trip");
    const secondTrip = await createTrip(owner.cookie, "Second provider trip");
    const resolved = await app.request(
      `/api/trips/${firstTrip.id}/trip-places/resolve-url`,
      {
        method: "POST",
        headers: {
          cookie: owner.cookie,
          "content-type": "application/json",
          origin: "https://app.example.test",
        },
        body: json({ url: "https://maps.app.goo.gl/controlled" }),
      },
    );
    expect(resolved.status).toBe(200);
    expect(parseProviderCandidatesResponse(await resolved.json())).toMatchObject({
      candidates: [{
        providerPlaceId: provider.kyoto.providerPlaceId,
        typeLabel: "佛寺",
        photo: {
          id: `google:${provider.kyoto.providerPlaceId}:0:ab695b0da15727f7`,
          thumbnailUrl: expect.stringContaining(`/api/trips/${firstTrip.id}/google-place-photos/${provider.kyoto.providerPlaceId}?index=0&photo=ab695b0da15727f7&resource=controlled&maxWidth=192&exp=`),
        },
      }],
      attribution: "Google Maps",
    });
    expect(provider.detailRequests.at(-1)).toEqual({
      providerPlaceId: provider.kyoto.providerPlaceId,
      options: { languageCode: "zh-TW", regionCode: "JP" },
    });

    const first = parseTripPlaceResponse(
      await (await addProvider(owner.cookie, firstTrip.id, "first-trip-place", "First trip note")).json(),
    ).tripPlace;
    const manualTargetResponse = await addManual(
      owner.cookie,
      firstTrip.id,
      "first-trip-manual-target",
      "Manual merged target",
      "First trip address",
    );
    const manualTarget = parseTripPlaceResponse(
      await manualTargetResponse.json(),
    ).tripPlace;
    const merged = await app.request(
      `/api/trips/${firstTrip.id}/trip-places/${first.id}/merge`,
      {
        method: "POST",
        headers: {
          cookie: owner.cookie,
          "content-type": "application/json",
          "idempotency-key": "merge-provider-into-manual",
          origin: "https://app.example.test",
        },
        body: json({
          targetTripPlaceId: manualTarget.id,
          expectedSourceVersion: first.version,
          expectedTargetVersion: manualTarget.version,
        }),
      },
    );
    expect(merged.status).toBe(200);
    const second = parseTripPlaceResponse(
      await (await addProvider(owner.cookie, secondTrip.id, "second-trip-place", "Second trip note")).json(),
    ).tripPlace;
    expect(first.placeId).toBe(second.placeId);
    expect(first.id).not.toBe(second.id);
    expect((await list(owner.cookie, firstTrip.id))[0]?.notes).toBe("First trip note");
    expect((await list(owner.cookie, secondTrip.id))[0]?.notes).toBe("Second trip note");
  });

  it("keeps legacy day data during migration and absorbs rollback-era preferred-day writes", async () => {
    const owner = await login("owner@example.test");
    const trip = await createTrip(owner.cookie, "Day assignment migration trip");
    const first = parseTripPlaceResponse(
      await (await addManual(
        owner.cookie,
        trip.id,
        "migration-first",
        "Migration first",
        "Kyoto north",
      )).json(),
    ).tripPlace;
    const second = parseTripPlaceResponse(
      await (await addManual(
        owner.cookie,
        trip.id,
        "migration-second",
        "Migration second",
        "Kyoto south",
      )).json(),
    ).tripPlace;

    // Later migrations that change these tables come off first and go back on last.
    await removeDayVersionMigration(database as Kysely<unknown>);
    await removeDayOrderMigration(database as Kysely<unknown>);
    await removeDayAssignmentMigration(database as Kysely<unknown>);
    await database.insertInto("trip_place_desired_days").values([
      {
        trip_id: trip.id,
        trip_place_id: first.id,
        trip_day_id: trip.days[0]!.id,
      },
      {
        trip_id: trip.id,
        trip_place_id: second.id,
        trip_day_id: trip.days[1]!.id,
      },
      {
        trip_id: trip.id,
        trip_place_id: second.id,
        trip_day_id: trip.days[2]!.id,
      },
    ]).execute();
    await database.insertInto("trip_place_excluded_days").values({
      trip_id: trip.id,
      trip_place_id: first.id,
      trip_day_id: trip.days[6]!.id,
    }).execute();

    await applyDayAssignmentMigration(database as Kysely<unknown>);
    await applyDayOrderMigration(database as Kysely<unknown>);
    await applyDayVersionMigration(database as Kysely<unknown>);

    expect(await database.selectFrom("trip_place_desired_days").selectAll()
      .where("trip_id", "=", trip.id).execute()).toHaveLength(3);
    expect(await database.selectFrom("trip_place_excluded_days").selectAll()
      .where("trip_id", "=", trip.id).execute()).toHaveLength(1);
    expect(await database.selectFrom("trip_place_day_assignments")
      .select(["trip_place_id", "trip_day_id"])
      .where("trip_id", "=", trip.id)
      .execute()).toEqual([{
        trip_place_id: first.id,
        trip_day_id: trip.days[0]!.id,
      }]);

    await database.deleteFrom("trip_place_desired_days")
      .where("trip_place_id", "=", first.id)
      .execute();
    await database.insertInto("trip_place_desired_days").values({
      trip_id: trip.id,
      trip_place_id: first.id,
      trip_day_id: trip.days[3]!.id,
    }).execute();
    expect(await database.selectFrom("trip_place_day_assignments")
      .select("trip_day_id")
      .where("trip_place_id", "=", first.id)
      .executeTakeFirst()).toEqual({ trip_day_id: trip.days[3]!.id });
  });

  it("assigns wishlist places to trip days and merges only compatible assignments with current versions", async () => {
    const owner = await login("owner@example.test");
    const trip = await createTrip(owner.cookie, "Duplicate review trip");
    const otherTrip = await createTrip(owner.cookie, "Other days trip");
    const manual = async (key: string, address: string) => {
      const response = await app.request(`/api/trips/${trip.id}/trip-places`, {
        method: "POST",
        headers: {
          cookie: owner.cookie,
          "content-type": "application/json",
          "idempotency-key": key,
          origin: "https://app.example.test",
        },
        body: json({
          method: "manual",
          name: "Family Cafe",
          type: "restaurant",
          address,
          latitude: null,
          longitude: null,
          timeZone: null,
          sourceUrl: null,
          originalNote: key,
        }),
      });
      expect(response.status).toBe(201);
      return parseTripPlaceResponse(await response.json()).tripPlace;
    };
    const first = await manual("manual-first", "Kyoto station north");
    const second = await manual("manual-second", "Kyoto station south");
    const duplicateRead = await list(owner.cookie, trip.id);
    expect(duplicateRead).toHaveLength(2);
    expect(duplicateRead.every((entry) => entry.status === "possible-duplicate")).toBe(true);

    const invalidAssignment = await app.request(
      `/api/trips/${trip.id}/trip-place-day-assignments`,
      {
        method: "PUT",
        headers: {
          cookie: owner.cookie,
          "content-type": "application/json",
          "idempotency-key": "cross-trip-day",
          origin: "https://app.example.test",
        },
        body: json({
          assignments: [{
            tripPlaceId: first.id,
            tripDayId: otherTrip.days[0]!.id,
            expectedVersion: first.version,
          }],
        }),
      },
    );
    expect(invalidAssignment.status).toBe(400);

    const staleMerge = await app.request(
      `/api/trips/${trip.id}/trip-places/${second.id}/merge`,
      {
        method: "POST",
        headers: {
          cookie: owner.cookie,
          "content-type": "application/json",
          "idempotency-key": "stale-merge",
          origin: "https://app.example.test",
        },
        body: json({
          targetTripPlaceId: first.id,
          expectedSourceVersion: second.version + 1,
          expectedTargetVersion: first.version,
        }),
      },
    );
    expect(staleMerge.status).toBe(409);
    expect(await list(owner.cookie, trip.id)).toHaveLength(2);

    const planning = async (
      place: ReturnType<typeof parseTripPlaceResponse>["tripPlace"],
      key: string,
      notes: string,
    ) => {
      const response = await app.request(
        `/api/trips/${trip.id}/trip-places/${place.id}/planning`,
        {
          method: "PATCH",
          headers: {
            cookie: owner.cookie,
            "content-type": "application/json",
            "idempotency-key": key,
            origin: "https://app.example.test",
          },
          body: json({
            expectedVersion: place.version,
            durationMinutes: null,
            budgetAmountMinor: null,
            budgetCurrency: null,
            notes,
          }),
        },
      );
      expect(response.status).toBe(200);
      return parseTripPlaceResponse(await response.json()).tripPlace;
    };
    const beforePlanning = await list(owner.cookie, trip.id);
    const plannedSource = await planning(
      beforePlanning.find((entry) => entry.id === second.id)!,
      "plan-merge-source",
      "Source planning note",
    );
    const plannedTarget = await planning(
      beforePlanning.find((entry) => entry.id === first.id)!,
      "plan-merge-target",
      "Target planning note",
    );
    const assigned = await app.request(
      `/api/trips/${trip.id}/trip-place-day-assignments`,
      {
        method: "PUT",
        headers: {
          cookie: owner.cookie,
          "content-type": "application/json",
          "idempotency-key": "assign-different-days",
          origin: "https://app.example.test",
        },
        body: json({
          assignments: [
            {
              tripPlaceId: plannedSource.id,
              tripDayId: trip.days[0]!.id,
              expectedVersion: plannedSource.version,
            },
            {
              tripPlaceId: plannedTarget.id,
              tripDayId: trip.days[1]!.id,
              expectedVersion: plannedTarget.version,
            },
          ],
        }),
      },
    );
    expect(assigned.status).toBe(200);
    const assignedPlaces = parseTripPlaceListResponse(await assigned.json()).tripPlaces;
    const assignedSource = assignedPlaces.find((entry) => entry.id === plannedSource.id)!;
    const assignedTarget = assignedPlaces.find((entry) => entry.id === plannedTarget.id)!;
    expect(assignedSource.assignedDayId).toBe(trip.days[0]!.id);
    expect(assignedTarget.assignedDayId).toBe(trip.days[1]!.id);
    expect(await database.selectFrom("trip_place_desired_days")
      .select(["trip_place_id", "trip_day_id"])
      .where("trip_place_id", "in", [plannedSource.id, plannedTarget.id])
      .execute()).toEqual(expect.arrayContaining([
        {
          trip_place_id: plannedSource.id,
          trip_day_id: trip.days[0]!.id,
        },
        {
          trip_place_id: plannedTarget.id,
          trip_day_id: trip.days[1]!.id,
        },
      ]));
    const replayedAssignment = await app.request(
      `/api/trips/${trip.id}/trip-place-day-assignments`,
      {
        method: "PUT",
        headers: {
          cookie: owner.cookie,
          "content-type": "application/json",
          "idempotency-key": "assign-different-days",
          origin: "https://app.example.test",
        },
        body: json({
          assignments: [
            {
              tripPlaceId: plannedSource.id,
              tripDayId: trip.days[0]!.id,
              expectedVersion: plannedSource.version,
            },
            {
              tripPlaceId: plannedTarget.id,
              tripDayId: trip.days[1]!.id,
              expectedVersion: plannedTarget.version,
            },
          ],
        }),
      },
    );
    expect(replayedAssignment.status).toBe(200);
    expect(parseTripPlaceListResponse(await replayedAssignment.json()).tripPlaces)
      .toEqual(assignedPlaces);

    const conflictingMerge = await app.request(
      `/api/trips/${trip.id}/trip-places/${assignedSource.id}/merge`,
      {
        method: "POST",
        headers: {
          cookie: owner.cookie,
          "content-type": "application/json",
          "idempotency-key": "conflicting-day-merge",
          origin: "https://app.example.test",
        },
        body: json({
          targetTripPlaceId: assignedTarget.id,
          expectedSourceVersion: assignedSource.version,
          expectedTargetVersion: assignedTarget.version,
        }),
      },
    );
    expect(conflictingMerge.status).toBe(409);
    expect(await list(owner.cookie, trip.id)).toHaveLength(2);

    const crossDay = await app.request(
      `/api/trips/${trip.id}/trip-place-day-assignments`,
      {
        method: "PUT",
        headers: {
          cookie: owner.cookie,
          "content-type": "application/json",
          "idempotency-key": "cross-day-without-removal",
          origin: "https://app.example.test",
        },
        body: json({
          assignments: [{
            tripPlaceId: assignedTarget.id,
            tripDayId: trip.days[0]!.id,
            expectedVersion: assignedTarget.version,
          }],
        }),
      },
    );
    expect(crossDay.status).toBe(409);
    expect((await list(owner.cookie, trip.id)).find((entry) => entry.id === assignedTarget.id))
      .toMatchObject({ assignedDayId: trip.days[1]!.id, version: assignedTarget.version });
    // The same day spelled with uppercase UUIDs is still the same day.
    const sameDayUppercase = await app.request(
      `/api/trips/${trip.id}/trip-place-day-assignments`,
      {
        method: "PUT",
        headers: {
          cookie: owner.cookie,
          "content-type": "application/json",
          "idempotency-key": "same-day-uppercase",
          origin: "https://app.example.test",
        },
        body: json({
          assignments: [{
            tripPlaceId: assignedTarget.id.toUpperCase(),
            tripDayId: trip.days[1]!.id.toUpperCase(),
            expectedVersion: assignedTarget.version,
          }],
        }),
      },
    );
    expect(sameDayUppercase.status).toBe(200);
    expect(parseTripPlaceListResponse(await sameDayUppercase.json()).tripPlaces
      .find((entry) => entry.id === assignedTarget.id)?.assignedDayId).toBe(trip.days[1]!.id);

    const unassigned = await app.request(
      `/api/trips/${trip.id}/trip-place-day-assignments`,
      {
        method: "PUT",
        headers: {
          cookie: owner.cookie,
          "content-type": "application/json",
          "idempotency-key": "unassign-merge-source",
          origin: "https://app.example.test",
        },
        body: json({
          assignments: [{
            tripPlaceId: assignedSource.id,
            tripDayId: null,
            expectedVersion: assignedSource.version,
          }],
        }),
      },
    );
    expect(unassigned.status).toBe(200);
    expect(parseTripPlaceListResponse(await unassigned.json()).tripPlaces
      .find((entry) => entry.id === assignedSource.id)?.assignedDayId).toBeNull();
    expect(await database.selectFrom("trip_place_desired_days")
      .select("trip_day_id")
      .where("trip_place_id", "=", assignedSource.id)
      .execute()).toEqual([]);

    const current = await list(owner.cookie, trip.id);
    const source = current.find((entry) => entry.id === second.id)!;
    const target = current.find((entry) => entry.id === first.id)!;
    const merged = await app.request(
      `/api/trips/${trip.id}/trip-places/${source.id}/merge`,
      {
        method: "POST",
        headers: {
          cookie: owner.cookie,
          "content-type": "application/json",
          "idempotency-key": "current-merge",
          origin: "https://app.example.test",
        },
        body: json({
          targetTripPlaceId: target.id,
          expectedSourceVersion: source.version,
          expectedTargetVersion: target.version,
        }),
      },
    );
    expect(merged.status).toBe(200);
    const mergedPlace = parseTripPlaceResponse(await merged.json()).tripPlace;
    expect(await database.selectFrom("trip_place_contributions").select("id")
      .where("trip_place_id", "=", mergedPlace.id).execute()).toHaveLength(2);
    expect(mergedPlace.notes).toBe("Target planning note\n\nSource planning note");
    expect(mergedPlace.assignedDayId).toBe(trip.days[1]!.id);
    expect(await list(owner.cookie, trip.id)).toHaveLength(1);
    expect(await database.selectFrom("trip_place_desired_days")
      .select(["trip_place_id", "trip_day_id"])
      .where("trip_place_id", "in", [source.id, target.id])
      .execute()).toEqual([{
        trip_place_id: target.id,
        trip_day_id: trip.days[1]!.id,
      }]);

    const skeletonResponse = await app.request(`/api/trips/${trip.id}/skeleton`, {
      headers: { cookie: owner.cookie },
    });
    expect(skeletonResponse.status).toBe(200);
    const survivingLegacy = parseTripSkeletonResponse(
      await skeletonResponse.json(),
    ).skeleton.places.find((place) => place.address === "Kyoto station north")!;
    expect(survivingLegacy.notes).toBe("Target planning note\n\nSource planning note");
    const unrelatedEdit = await app.request(
      `/api/trips/${trip.id}/places/${survivingLegacy.id}`,
      {
        method: "PATCH",
        headers: {
          cookie: owner.cookie,
          "content-type": "application/json",
          "idempotency-key": "edit-address-after-merge",
          origin: "https://app.example.test",
        },
        body: json({
          expectedVersion: survivingLegacy.version,
          name: survivingLegacy.name,
          type: survivingLegacy.type,
          address: "Kyoto station north updated",
          latitude: survivingLegacy.latitude,
          longitude: survivingLegacy.longitude,
          timeZone: survivingLegacy.timeZone,
          sourceUrl: survivingLegacy.sourceUrl,
          notes: survivingLegacy.notes,
        }),
      },
    );
    expect(unrelatedEdit.status).toBe(200);
    expect(parsePlaceResponse(await unrelatedEdit.json()).place.notes)
      .toBe("Target planning note\n\nSource planning note");
    expect((await list(owner.cookie, trip.id))[0]?.notes)
      .toBe("Target planning note\n\nSource planning note");
  });





  it("rejects merging an unscheduled day assignment into a scheduled place", async () => {
    const owner = await login("owner@example.test");
    const editor = await login("scheduled-merge-editor@example.test");
    const trip = await createTrip(owner.cookie, "Scheduled merge conflict trip");
    await addMember(trip.id, editor.user.id);
    const source = parseTripPlaceResponse(
      await (await addManual(
        owner.cookie,
        trip.id,
        "scheduled-merge-source",
        "Scheduled merge cafe",
        "Assignment source",
      )).json(),
    ).tripPlace;
    const target = parseTripPlaceResponse(
      await (await addManual(
        owner.cookie,
        trip.id,
        "scheduled-merge-target",
        "Scheduled merge cafe",
        "Timed target",
      )).json(),
    ).tripPlace;
    const unscheduledSource = parseTripPlaceResponse(
      await (await addManual(
        owner.cookie,
        trip.id,
        "scheduled-merge-unscheduled-source",
        "Scheduled merge cafe",
        "Unscheduled source",
      )).json(),
    ).tripPlace;
    const assignment = await app.request(
      `/api/trips/${trip.id}/trip-place-day-assignments`,
      {
        method: "PUT",
        headers: {
          cookie: owner.cookie,
          "content-type": "application/json",
          "idempotency-key": "assign-before-scheduled-merge",
          origin: "https://app.example.test",
        },
        body: json({
          assignments: [{
            tripPlaceId: source.id,
            tripDayId: trip.days[0]!.id,
            expectedVersion: source.version,
          }],
        }),
      },
    );
    expect(assignment.status).toBe(200);
    const assignedSource = parseTripPlaceListResponse(
      await assignment.json(),
    ).tripPlaces.find((place) => place.id === source.id)!;
    const sourceOnlyEditorMerge = await app.request(
      `/api/trips/${trip.id}/trip-places/${assignedSource.id}/merge`,
      {
        method: "POST",
        headers: {
          cookie: editor.cookie,
          "content-type": "application/json",
          "idempotency-key": "editor-scheduled-source-merge",
          origin: "https://app.example.test",
        },
        body: json({
          targetTripPlaceId: target.id,
          expectedSourceVersion: assignedSource.version,
          expectedTargetVersion: target.version,
        }),
      },
    );
    expect(sourceOnlyEditorMerge.status).toBe(403);
    expect(await sourceOnlyEditorMerge.json()).toEqual({
      error: { code: "forbidden", message: "Only the trip owner can do that" },
    });
    const skeletonResponse = await app.request(`/api/trips/${trip.id}/skeleton`, {
      headers: { cookie: owner.cookie },
    });
    const skeleton = parseTripSkeletonResponse(await skeletonResponse.json()).skeleton;
    const targetPlace = skeleton.places.find((place) => place.address === "Timed target")!;
    const fixture = skeleton.items.find((item) => item.title === "FIXTURE-OUT")!;
    const timedItem = await app.request(`/api/trips/${trip.id}/items/${fixture.id}`, {
      method: "PATCH",
      headers: {
        cookie: owner.cookie,
        "content-type": "application/json",
        "idempotency-key": "schedule-merge-target",
        origin: "https://app.example.test",
      },
      body: json({
        type: "activity",
        title: "Timed target activity",
        notes: null,
        sourceUrl: null,
        money: null,
        participantMemberIds: null,
        endpoints: [{
          role: "start",
          countryStopId: trip.countryStops[0]!.id,
          placeId: targetPlace.id,
          localDateTime: "2026-10-21T10:00",
          timeZone: "Asia/Tokyo",
        }],
        details: { durationMinutes: 60, bookedBy: null, confirmationStatus: "unknown" },
        expectedVersion: fixture.version,
      }),
    });
    expect(timedItem.status).toBe(200);
    const currentTarget = (await list(owner.cookie, trip.id))
      .find((place) => place.id === target.id)!;
    expect(currentTarget.scheduled).toBe(true);
    const mergeInput = {
      targetTripPlaceId: currentTarget.id,
      expectedSourceVersion: assignedSource.version,
      expectedTargetVersion: currentTarget.version,
    };
    const targetOnlyMergeInput = {
      targetTripPlaceId: currentTarget.id,
      expectedSourceVersion: unscheduledSource.version,
      expectedTargetVersion: currentTarget.version,
    };
    const beforeEditorMerge = await list(owner.cookie, trip.id);
    const beforeEditorMergeHistory = await history(owner.cookie, trip.id);
    const editorMerge = await app.request(
      `/api/trips/${trip.id}/trip-places/${unscheduledSource.id}/merge`,
      {
        method: "POST",
        headers: {
          cookie: editor.cookie,
          "content-type": "application/json",
          "idempotency-key": "editor-scheduled-target-merge",
          origin: "https://app.example.test",
        },
        body: json(targetOnlyMergeInput),
      },
    );
    expect(editorMerge.status).toBe(403);
    expect(await editorMerge.json()).toEqual({
      error: { code: "forbidden", message: "Only the trip owner can do that" },
    });
    expect(await list(owner.cookie, trip.id)).toEqual(beforeEditorMerge);
    expect(await history(owner.cookie, trip.id)).toEqual(beforeEditorMergeHistory);


    const merge = await app.request(
      `/api/trips/${trip.id}/trip-places/${assignedSource.id}/merge`,
      {
        method: "POST",
        headers: {
          cookie: owner.cookie,
          "content-type": "application/json",
          "idempotency-key": "reject-scheduled-assignment-merge",
          origin: "https://app.example.test",
        },
        body: json(mergeInput),
      },
    );
    expect(merge.status).toBe(409);
    expect(await merge.json()).toMatchObject({
      error: {
        code: "conflict",
        message: "A scheduled place cannot be merged with an unscheduled day assignment",
      },
    });
    expect((await list(owner.cookie, trip.id))
      .find((place) => place.id === source.id)?.assignedDayId).toBe(trip.days[0]!.id);
  });

  it("lets only the owner remove a scheduled wishlist place without changing formal itinerary content", async () => {
    const owner = await login("owner@example.test");
    const second = await login("second@example.test");
    const outsider = await login("outsider@example.test");
    const trip = await createTrip(owner.cookie, "Remove scheduled wishlist place");
    await addMember(trip.id, second.user.id);
    const place = parseTripPlaceResponse(
      await (await addManual(owner.cookie, trip.id, "remove-place", "Voted cafe", "Kyoto")).json(),
    ).tripPlace;
    expect((await setVote(owner.cookie, trip.id, place.id, true, "owner-vote-before-remove")).status).toBe(200);
    expect((await setVote(second.cookie, trip.id, place.id, true, "second-vote-before-remove")).status).toBe(200);
    const skeletonResponse = await app.request(`/api/trips/${trip.id}/skeleton`, { headers: { cookie: owner.cookie } });
    const skeleton = parseTripSkeletonResponse(await skeletonResponse.json()).skeleton;
    const legacy = skeleton.places.find((entry) => entry.name === place.name)!;
    const fixture = skeleton.items.find((item) => item.title === "FIXTURE-OUT")!;
    const activity = await app.request(`/api/trips/${trip.id}/items/${fixture.id}`, {
      method: "PATCH",
      headers: { cookie: owner.cookie, "content-type": "application/json", "idempotency-key": "activity-before-remove", origin: "https://app.example.test" },
      body: json({
        type: "activity", title: "Keep my booking", notes: "Booking stays", sourceUrl: null,
        money: null, participantMemberIds: null,
        endpoints: [{ role: "start", countryStopId: trip.countryStops[0]!.id, placeId: legacy.id,
          localDateTime: "2026-10-21T10:00", timeZone: "Asia/Tokyo" }],
        details: { durationMinutes: 60, bookedBy: null, confirmationStatus: "unknown" },
        expectedVersion: fixture.version,
      }),
    });
    expect(activity.status).toBe(200);
    // A timed place cannot be assigned through the API, so seed legacy day rows directly
    // (migration 007's trigger derives an assignment) to prove removal clears all of them.
    await database.insertInto("trip_place_desired_days").values({
      trip_id: trip.id, trip_place_id: place.id, trip_day_id: trip.days[0]!.id,
    }).execute();
    await database.insertInto("trip_place_excluded_days").values({
      trip_id: trip.id, trip_place_id: place.id, trip_day_id: trip.days[1]!.id,
    }).execute();
    const beforeResponse = await app.request(`/api/trips/${trip.id}/skeleton`, { headers: { cookie: owner.cookie } });
    const before = parseTripSkeletonResponse(await beforeResponse.json()).skeleton;
    const current = (await list(owner.cookie, trip.id))[0]!;
    expect(current.scheduled).toBe(true);
    const missingKey = await app.request(`/api/trips/${trip.id}/trip-places/${place.id}/remove`, {
      method: "POST",
      headers: { cookie: second.cookie, "content-type": "application/json", origin: "https://app.example.test" },
      body: json({ expectedVersion: current.version }),
    });
    expect(missingKey.status).toBe(400);
    expect((await removePlace(outsider.cookie, trip.id, current, "outsider-remove")).status).toBe(404);
    const stale = await removePlace(second.cookie, trip.id, place, "stale-remove");
    expect(stale.status).toBe(403);
    expect(await stale.json()).toEqual({
      error: { code: "forbidden", message: "Only the trip owner can do that" },
    });
    const endpointRefused = await app.request(`/api/trips/${trip.id}/places/${legacy.id}`, {
      method: "DELETE",
      headers: { cookie: second.cookie, "content-type": "application/json", "idempotency-key": "delete-in-use", origin: "https://app.example.test" },
      body: json({ expectedVersion: legacy.version }),
    });
    expect(endpointRefused.status).toBe(403);
    expect(await endpointRefused.json()).toEqual({
      error: { code: "forbidden", message: "Only the trip owner can do that" },
    });
    const ownerEndpointRefused = await app.request(`/api/trips/${trip.id}/places/${legacy.id}`, {
      method: "DELETE",
      headers: { cookie: owner.cookie, "content-type": "application/json", "idempotency-key": "owner-delete-in-use", origin: "https://app.example.test" },
      body: json({ expectedVersion: legacy.version }),
    });
    expect(ownerEndpointRefused.status).toBe(409);
    expect(await ownerEndpointRefused.json()).toMatchObject({ error: { code: "place_in_use" } });
    const beforeEditorRemoval = await history(owner.cookie, trip.id);
    const editorRemoval = await removePlace(second.cookie, trip.id, current, "remove-scheduled");
    expect(editorRemoval.status).toBe(403);
    expect(await editorRemoval.json()).toEqual({
      error: { code: "forbidden", message: "Only the trip owner can do that" },
    });
    const editorReplay = await removePlace(second.cookie, trip.id, current, "remove-scheduled");
    expect(editorReplay.status).toBe(403);
    expect(await editorReplay.json()).toEqual({
      error: { code: "forbidden", message: "Only the trip owner can do that" },
    });
    expect(await history(owner.cookie, trip.id)).toEqual(beforeEditorRemoval);
    expect(await list(owner.cookie, trip.id)).toEqual([current]);
    expect((await removePlace(owner.cookie, trip.id, current, "remove-scheduled")).status).toBe(204);
    const crossActorReplay = await removePlace(second.cookie, trip.id, current, "remove-scheduled");
    expect(crossActorReplay.status).toBe(403);
    expect(await crossActorReplay.json()).toEqual({
      error: { code: "forbidden", message: "Only the trip owner can do that" },
    });
    expect((await removePlace(owner.cookie, trip.id, current, "remove-scheduled")).status).toBe(204);
    expect(await list(owner.cookie, trip.id)).toEqual([]);
    for (const table of ["trip_place_votes", "trip_place_day_assignments", "trip_place_desired_days", "trip_place_excluded_days"] as const) {
      expect(await database.selectFrom(table).selectAll().where("trip_place_id", "=", place.id).execute()).toEqual([]);
    }
    const archived = await database.selectFrom("trip_places").select("archived_at").where("id", "=", place.id).executeTakeFirstOrThrow();
    expect(archived.archived_at).not.toBeNull();
    const afterResponse = await app.request(`/api/trips/${trip.id}/skeleton`, { headers: { cookie: owner.cookie } });
    const after = parseTripSkeletonResponse(await afterResponse.json()).skeleton;
    expect(after.places).toEqual(before.places);
    expect(after.items).toEqual(before.items);
    expect(after.days).toEqual(before.days);
    expect(await database.selectFrom("change_events").select("actor_id")
      .where("target_id", "=", place.id).where("event_type", "=", "trip_place.removed").execute())
      .toEqual([{ actor_id: owner.user.id }]);
  });
  it("rejects a merge that would make planning notes impossible to edit", async () => {
    const owner = await login("owner@example.test");
    const trip = await createTrip(owner.cookie, "Planning note boundary trip");
    const firstResponse = await addManual(
      owner.cookie,
      trip.id,
      "boundary-first",
      "Boundary Cafe",
      "Boundary north",
    );
    const secondResponse = await addManual(
      owner.cookie,
      trip.id,
      "boundary-second",
      "Boundary Cafe",
      "Boundary south",
    );
    const first = parseTripPlaceResponse(await firstResponse.json()).tripPlace;
    const second = parseTripPlaceResponse(await secondResponse.json()).tripPlace;
    const saveNote = async (place: typeof first, key: string, notes: string) => {
      const response = await app.request(
        `/api/trips/${trip.id}/trip-places/${place.id}/planning`,
        {
          method: "PATCH",
          headers: {
            cookie: owner.cookie,
            "content-type": "application/json",
            "idempotency-key": key,
            origin: "https://app.example.test",
          },
          body: json({
            expectedVersion: place.version,
            durationMinutes: null,
            budgetAmountMinor: null,
            budgetCurrency: null,
            notes,
          }),
        },
      );
      expect(response.status).toBe(200);
      return parseTripPlaceResponse(await response.json()).tripPlace;
    };
    const firstWithNote = await saveNote(first, "boundary-first-note", "a".repeat(6_000));
    const secondWithNote = await saveNote(second, "boundary-second-note", "b".repeat(6_000));

    const merge = await app.request(
      `/api/trips/${trip.id}/trip-places/${first.id}/merge`,
      {
        method: "POST",
        headers: {
          cookie: owner.cookie,
          "content-type": "application/json",
          "idempotency-key": "boundary-merge",
          origin: "https://app.example.test",
        },
        body: json({
          targetTripPlaceId: second.id,
          expectedSourceVersion: firstWithNote.version,
          expectedTargetVersion: secondWithNote.version,
        }),
      },
    );
    expect(merge.status).toBe(409);
    const unchanged = await list(owner.cookie, trip.id);
    expect(unchanged).toHaveLength(2);
    expect(unchanged.find((place) => place.id === first.id)?.notes)
      .toBe("a".repeat(6_000));
    expect(unchanged.find((place) => place.id === second.id)?.notes)
      .toBe("b".repeat(6_000));
  });

  it("serializes merge with retained Place edits before either projection is locked", async () => {
    const owner = await login("owner@example.test");
    const trip = await createTrip(owner.cookie, "Concurrent projection trip");
    const firstResponse = await addManual(
      owner.cookie,
      trip.id,
      "concurrent-first",
      "Concurrent Cafe",
      "Concurrent north",
    );
    const secondResponse = await addManual(
      owner.cookie,
      trip.id,
      "concurrent-second",
      "Concurrent Cafe",
      "Concurrent south",
    );
    expect(firstResponse.status).toBe(201);
    expect(secondResponse.status).toBe(201);
    const first = parseTripPlaceResponse(await firstResponse.json()).tripPlace;
    const second = parseTripPlaceResponse(await secondResponse.json()).tripPlace;
    const current = await list(owner.cookie, trip.id);
    const source = current.find((place) => place.id === first.id)!;
    const target = current.find((place) => place.id === second.id)!;
    const skeletonResponse = await app.request(`/api/trips/${trip.id}/skeleton`, {
      headers: { cookie: owner.cookie },
    });
    const targetLegacy = parseTripSkeletonResponse(
      await skeletonResponse.json(),
    ).skeleton.places.find((place) => place.address === target.address)!;

    await sql`
      create or replace function issue22_block_contribution_move()
      returns trigger
      language plpgsql
      as $$
      begin
        perform pg_advisory_xact_lock(220022);
        return new;
      end
      $$
    `.execute(database);
    await sql`
      create trigger issue22_block_contribution_move
      before update of trip_place_id on trip_place_contributions
      for each row execute function issue22_block_contribution_move()
    `.execute(database);

    const gatePool = new Pool({ connectionString: databaseUrl });
    const gate = await gatePool.connect();
    let gateOpen = false;

    try {
      await gate.query("begin");
      await gate.query("select pg_advisory_xact_lock(220022)");
      const mergePromise = app.request(
        `/api/trips/${trip.id}/trip-places/${source.id}/merge`,
        {
          method: "POST",
          headers: {
            cookie: owner.cookie,
            "content-type": "application/json",
            "idempotency-key": "concurrent-merge",
            origin: "https://app.example.test",
          },
          body: json({
            targetTripPlaceId: target.id,
            expectedSourceVersion: source.version,
            expectedTargetVersion: target.version,
          }),
        },
      );
      await waitForDatabaseLock(gatePool, "advisory");
      const editPromise = app.request(
        `/api/trips/${trip.id}/places/${targetLegacy.id}`,
        {
          method: "PATCH",
          headers: {
            cookie: owner.cookie,
            "content-type": "application/json",
            "idempotency-key": "concurrent-legacy-edit",
            origin: "https://app.example.test",
          },
          body: json({
            expectedVersion: targetLegacy.version,
            name: targetLegacy.name,
            type: targetLegacy.type,
            address: "Concurrent target edited",
            latitude: targetLegacy.latitude,
            longitude: targetLegacy.longitude,
            timeZone: targetLegacy.timeZone,
            sourceUrl: targetLegacy.sourceUrl,
            notes: targetLegacy.notes,
          }),
        },
      );
      await waitForDatabaseLock(gatePool, "row");
      await gate.query("commit");
      gateOpen = true;
      const [merge, edit] = await Promise.all([mergePromise, editPromise]);
      expect(merge.status).toBe(200);
      expect(edit.status).toBe(409);
    } finally {
      if (!gateOpen) await gate.query("rollback");
      gate.release();
      await gatePool.end();
      await sql`
        drop trigger if exists issue22_block_contribution_move
        on trip_place_contributions
      `.execute(database);
      await sql`
        drop function if exists issue22_block_contribution_move()
      `.execute(database);
    }
  });

  it("serializes vote events with merge before locking a candidate", async () => {
    const owner = await login("owner@example.test");
    const trip = await createTrip(owner.cookie, "Concurrent vote trip");
    const member = await login("voter@example.test");
    await addMember(trip.id, member.user.id);
    const firstResponse = await addManual(
      owner.cookie,
      trip.id,
      "vote-first",
      "Vote Cafe",
      "Vote north",
    );
    const secondResponse = await addManual(
      owner.cookie,
      trip.id,
      "vote-second",
      "Vote Cafe",
      "Vote south",
    );
    const first = parseTripPlaceResponse(await firstResponse.json()).tripPlace;
    const second = parseTripPlaceResponse(await secondResponse.json()).tripPlace;
    const current = await list(owner.cookie, trip.id);
    const source = current.find((place) => place.id === first.id)!;
    const target = current.find((place) => place.id === second.id)!;

    await sql`
      create or replace function issue22_block_vote_event()
      returns trigger
      language plpgsql
      as $$
      begin
        perform pg_advisory_xact_lock(220023);
        return new;
      end
      $$
    `.execute(database);
    await sql`
      create trigger issue22_block_vote_event
      before insert on change_events
      for each row execute function issue22_block_vote_event()
    `.execute(database);

    const gatePool = new Pool({ connectionString: databaseUrl });
    const gate = await gatePool.connect();
    let gateOpen = false;

    try {
      await gate.query("begin");
      await gate.query("select pg_advisory_xact_lock(220023)");
      const votePromise = setVote(owner.cookie, trip.id, target.id, true, "concurrent-vote");
      await waitForDatabaseLock(gatePool, "advisory");
      const mergePromise = app.request(
        `/api/trips/${trip.id}/trip-places/${source.id}/merge`,
        {
          method: "POST",
          headers: {
            cookie: owner.cookie,
            "content-type": "application/json",
            "idempotency-key": "vote-concurrent-merge",
            origin: "https://app.example.test",
          },
          body: json({
            targetTripPlaceId: target.id,
            expectedSourceVersion: source.version,
            expectedTargetVersion: target.version,
          }),
        },
      );
      await waitForDatabaseLock(gatePool, "row");
      await gate.query("commit");
      gateOpen = true;
      const [vote, merge] = await Promise.all([
        votePromise,
        mergePromise,
      ]);
      expect(vote.status).toBe(200);
      expect(merge.status).toBe(409);
    } finally {
      if (!gateOpen) await gate.query("rollback");
      gate.release();
      await gatePool.end();
      await sql`
        drop trigger if exists issue22_block_vote_event
        on change_events
      `.execute(database);
      await sql`
        drop function if exists issue22_block_vote_event()
      `.execute(database);
    }
  });

  it("serializes retained Place edits before vote membership checks", async () => {
    const owner = await login("owner@example.test");
    const trip = await createTrip(owner.cookie, "Concurrent membership trip");
    const member = await login("voter@example.test");
    await addMember(trip.id, member.user.id);
    const placeResponse = await addManual(
      owner.cookie,
      trip.id,
      "membership-place",
      "Membership Cafe",
      "Membership address",
    );
    const place = parseTripPlaceResponse(await placeResponse.json()).tripPlace;
    const skeletonResponse = await app.request(`/api/trips/${trip.id}/skeleton`, {
      headers: { cookie: owner.cookie },
    });
    const legacy = parseTripSkeletonResponse(
      await skeletonResponse.json(),
    ).skeleton.places.find((candidate) => candidate.name === place.name)!;

    await sql`
      create or replace function issue22_block_vote_insert()
      returns trigger
      language plpgsql
      as $$
      begin
        perform pg_advisory_xact_lock(220024);
        return new;
      end
      $$
    `.execute(database);
    await sql`
      create trigger issue22_block_vote_insert
      before insert on trip_place_votes
      for each row execute function issue22_block_vote_insert()
    `.execute(database);

    const gatePool = new Pool({ connectionString: databaseUrl });
    const gate = await gatePool.connect();
    let gateOpen = false;
    try {
      await gate.query("begin");
      await gate.query("select pg_advisory_xact_lock(220024)");
      const votePromise = setVote(owner.cookie, trip.id, place.id, true, "membership-vote");
      await waitForDatabaseLock(gatePool, "advisory");
      const editPromise = app.request(
        `/api/trips/${trip.id}/places/${legacy.id}`,
        {
          method: "PATCH",
          headers: {
            cookie: owner.cookie,
            "content-type": "application/json",
            "idempotency-key": "membership-legacy-edit",
            origin: "https://app.example.test",
          },
          body: json({
            expectedVersion: legacy.version,
            name: legacy.name,
            type: legacy.type,
            address: "Membership address updated",
            latitude: legacy.latitude,
            longitude: legacy.longitude,
            timeZone: legacy.timeZone,
            sourceUrl: legacy.sourceUrl,
            notes: legacy.notes,
          }),
        },
      );
      await waitForDatabaseLock(gatePool, "row");
      await gate.query("commit");
      gateOpen = true;
      const [vote, edit] = await Promise.all([
        votePromise,
        editPromise,
      ]);
      expect(vote.status).toBe(200);
      expect(edit.status).toBe(200);
    } finally {
      if (!gateOpen) await gate.query("rollback");
      gate.release();
      await gatePool.end();
      await sql`
        drop trigger if exists issue22_block_vote_insert
        on trip_place_votes
      `.execute(database);
      await sql`
        drop function if exists issue22_block_vote_insert()
      `.execute(database);
    }
  });

  it("serializes invitation reacceptance with member removal", async () => {
    const owner = await login("owner@example.test");
    const editor = await login("reaccepted-editor@example.test");
    const trip = await createTrip(owner.cookie, "Concurrent membership lifecycle");
    await database.insertInto("trip_members").values({
      trip_id: trip.id,
      user_id: editor.user.id,
      role: "editor",
      removed_at: now(),
    }).execute();
    const inviteToken = "reaccept-editor-token";
    await database.insertInto("invites").values({
      trip_id: trip.id,
      email: editor.user.email,
      role: "editor",
      token_hash: hashToken(inviteToken),
      expires_at: new Date("2026-10-05T12:00:00.000Z"),
      accepted_at: null,
      accepted_by: null,
      revoked_at: null,
      invited_by: owner.user.id,
    }).execute();

    await sql`
      create or replace function issue22_block_invite_acceptance_event()
      returns trigger
      language plpgsql
      as $$
      begin
        perform pg_advisory_xact_lock(220025);
        return new;
      end
      $$
    `.execute(database);
    await sql`
      create trigger issue22_block_invite_acceptance_event
      before insert on change_events
      for each row execute function issue22_block_invite_acceptance_event()
    `.execute(database);

    const gatePool = new Pool({ connectionString: databaseUrl });
    const gate = await gatePool.connect();
    let gateOpen = false;
    try {
      await gate.query("begin");
      await gate.query("select pg_advisory_xact_lock(220025)");
      const acceptancePromise = app.request("/api/invites/accept", {
        method: "POST",
        headers: {
          cookie: editor.cookie,
          "content-type": "application/json",
          "idempotency-key": "concurrent-reaccept",
          origin: "https://app.example.test",
        },
        body: json({ token: inviteToken }),
      });
      await waitForDatabaseLock(gatePool, "advisory");
      const removalPromise = app.request(
        `/api/trips/${trip.id}/members/${editor.user.id}`,
        {
          method: "DELETE",
          headers: {
            cookie: owner.cookie,
            "idempotency-key": "concurrent-remove-reaccepted",
            origin: "https://app.example.test",
          },
        },
      );
      await waitForDatabaseLock(gatePool, "row");
      await gate.query("commit");
      gateOpen = true;
      const [acceptance, removal] = await Promise.all([
        acceptancePromise,
        removalPromise,
      ]);
      expect(acceptance.status).toBe(200);
      expect(removal.status).toBe(204);
    } finally {
      if (!gateOpen) await gate.query("rollback");
      gate.release();
      await gatePool.end();
      await sql`
        drop trigger if exists issue22_block_invite_acceptance_event
        on change_events
      `.execute(database);
      await sql`
        drop function if exists issue22_block_invite_acceptance_event()
      `.execute(database);
    }
  });

  it("reconciles Places written by a retained release after rollback", async () => {
    const owner = await login("owner@example.test");
    const trip = await createTrip(owner.cookie, "Rollback compatibility trip");
    const legacy = await database.insertInto("places").values({
      trip_id: trip.id,
      name: "Rollback meeting point",
      place_type: "other",
      address: "Original address",
      latitude: null,
      longitude: null,
      time_zone: null,
      source_url: "https://example.test/original",
      notes: "Original rollback note",
      created_by: owner.user.id,
    }).returning("id").executeTakeFirstOrThrow();

    await database.updateTable("places").set({
      name: "Rollback meeting point updated",
      address: "Updated address",
      notes: "Updated shared note",
      source_url: "https://example.test/updated",
      version: sql`version + 1`,
      updated_at: new Date("2026-09-29T12:00:00.000Z"),
    }).where("id", "=", legacy.id).execute();

    const updated = (await list(owner.cookie, trip.id))[0]!;
    expect(updated).toMatchObject({
      id: legacy.id,
      placeId: legacy.id,
      name: "Rollback meeting point updated",
      address: "Updated address",
      notes: "Updated shared note",
      factsSource: "member",
      sourceUrl: "https://example.test/original",
    });

    await database.updateTable("places").set({
      source_url: "https://example.test/source-only-change",
      version: sql`version + 1`,
      updated_at: new Date("2026-09-30T12:00:00.000Z"),
    }).where("id", "=", legacy.id).execute();
    const afterSourceOnlyChange = (await list(owner.cookie, trip.id))[0]!;
    const planning = await app.request(
      `/api/trips/${trip.id}/trip-places/${legacy.id}/planning`,
      {
        method: "PATCH",
        headers: {
          cookie: owner.cookie,
          "content-type": "application/json",
          "idempotency-key": "planning-after-source-only-rollback-write",
          origin: "https://app.example.test",
        },
        body: json({
          expectedVersion: afterSourceOnlyChange.version,
          durationMinutes: null,
          budgetAmountMinor: null,
          budgetCurrency: null,
          notes: "Current planning note",
        }),
      },
    );
    expect(planning.status).toBe(200);
    expect(parseTripPlaceResponse(await planning.json()).tripPlace.notes).toBe("Current planning note");
    expect((await list(owner.cookie, trip.id))[0]?.notes).toBe("Current planning note");
    const [legacyAfterPlanning, tripPlaceAfterPlanning] = await Promise.all([
      database.selectFrom("places").select(["notes", "version"])
        .where("id", "=", legacy.id).executeTakeFirstOrThrow(),
      database.selectFrom("trip_places").select("legacy_place_version")
        .where("id", "=", legacy.id).executeTakeFirstOrThrow(),
    ]);
    expect(legacyAfterPlanning.notes).toBe("Current planning note");
    expect(tripPlaceAfterPlanning.legacy_place_version).toBe(legacyAfterPlanning.version);

    await database.deleteFrom("places").where("id", "=", legacy.id).execute();
    expect(await list(owner.cookie, trip.id)).toEqual([]);
  });

  it("allows an editor to delete an unscheduled place despite another member's contribution and votes", async () => {
    const owner = await login("owner@example.test");
    const second = await login("second@example.test");
    const trip = await createTrip(owner.cookie, "Voted deletion trip");
    await addMember(trip.id, second.user.id);
    const place = parseTripPlaceResponse(
      await (await addProvider(owner.cookie, trip.id, "delete-owner", "Owner source")).json(),
    ).tripPlace;
    expect((await setVote(owner.cookie, trip.id, place.id, true, "delete-own-vote")).status).toBe(200);
    // Historical contributions remain internal, but no longer veto another member's deletion.
    await database.insertInto("trip_place_contributions").values({
      trip_id: trip.id, trip_place_id: place.id, member_user_id: second.user.id,
      intake_method: "search", original_note: "Second member's historical source",
      source_url: provider.kyoto.sourceUrl, provider_observed_at: now(), withdrawn_at: null,
    }).execute();
    const deletePlace = async (key: string) => {
      const response = await app.request(`/api/trips/${trip.id}/skeleton`, { headers: { cookie: owner.cookie } });
      const legacy = parseTripSkeletonResponse(await response.json()).skeleton.places.find((candidate) => candidate.name === place.name)!;
      return app.request(`/api/trips/${trip.id}/places/${legacy.id}`, {
        method: "DELETE",
        headers: { cookie: second.cookie, "content-type": "application/json", "idempotency-key": key, origin: "https://app.example.test" },
        body: json({ expectedVersion: legacy.version }),
      });
    };
    expect((await deletePlace("delete-voted")).status).toBe(204);
    expect(await list(owner.cookie, trip.id)).toEqual([]);
    expect(await database.selectFrom("trip_place_votes").selectAll().where("trip_place_id", "=", place.id).execute()).toEqual([]);
  });

  it("requires the owner when legacy Place deletion would cascade a day assignment", async () => {
    const owner = await login("legacy-delete-owner@example.test");
    const editor = await login("legacy-delete-editor@example.test");
    const trip = await createTrip(owner.cookie, "Legacy scheduled deletion");
    await addMember(trip.id, editor.user.id);
    const place = parseTripPlaceResponse(
      await (await addManual(owner.cookie, trip.id, "legacy-delete-scheduled", "Scheduled cafe", "Kyoto")).json(),
    ).tripPlace;
    const assigned = await app.request(`/api/trips/${trip.id}/trip-place-day-assignments`, {
      method: "PUT",
      headers: {
        cookie: owner.cookie,
        "content-type": "application/json",
        "idempotency-key": "legacy-delete-assign",
        origin: "https://app.example.test",
      },
      body: json({
        assignments: [{
          tripPlaceId: place.id,
          tripDayId: trip.days[0]!.id,
          expectedVersion: place.version,
        }],
      }),
    });
    expect(assigned.status).toBe(200);
    const assignedPlace = parseTripPlaceListResponse(await assigned.json()).tripPlaces
      .find((candidate) => candidate.id === place.id)!;
    const skeleton = parseTripSkeletonResponse(await (await app.request(
      `/api/trips/${trip.id}/skeleton`,
      { headers: { cookie: owner.cookie } },
    )).json()).skeleton;
    const legacy = skeleton.places.find((candidate) => candidate.name === place.name)!;
    const removeLegacy = (cookie: string, key: string) => app.request(
      `/api/trips/${trip.id}/places/${legacy.id}`,
      {
        method: "DELETE",
        headers: {
          cookie,
          "content-type": "application/json",
          "idempotency-key": key,
          origin: "https://app.example.test",
        },
        body: json({ expectedVersion: legacy.version }),
      },
    );
    const beforePlaces = await list(owner.cookie, trip.id);
    const beforeHistory = await history(owner.cookie, trip.id);
    const denied = await removeLegacy(editor.cookie, "legacy-delete-editor");
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({
      error: { code: "forbidden", message: "Only the trip owner can do that" },
    });
    expect(await list(owner.cookie, trip.id)).toEqual(beforePlaces);
    expect(await history(owner.cookie, trip.id)).toEqual(beforeHistory);
    expect((await list(owner.cookie, trip.id)).find((candidate) => candidate.id === place.id))
      .toEqual(assignedPlace);

    expect((await removeLegacy(owner.cookie, "legacy-delete-owner")).status).toBe(204);
    expect(await list(owner.cookie, trip.id)).toEqual([]);
    expect(await database.selectFrom("trip_place_day_assignments")
      .selectAll().where("trip_place_id", "=", place.id).execute()).toEqual([]);
  });



  it("keeps manual intake and removal available during provider failure", async () => {
    const owner = await login("owner@example.test");
    const second = await login("second@example.test");
    const trip = await createTrip(owner.cookie, "Provider outage trip");
    await addMember(trip.id, second.user.id);
    const first = parseTripPlaceResponse(
      await (await addProvider(owner.cookie, trip.id, "outage-owner", "Owner note")).json(),
    ).tripPlace;
    provider.unavailable = true;
    const gatePool = new Pool({ connectionString: databaseUrl });
    const gate = await gatePool.connect();
    let gateOpen = false;
    let failedSearch: Response;
    try {
      await gate.query("begin");
      await gate.query("select id from trips where id = $1 for update", [trip.id]);
      const failedSearchPromise = app.request(
        `/api/trips/${trip.id}/trip-places/search`,
        {
          method: "POST",
          headers: {
            cookie: owner.cookie,
            "content-type": "application/json",
            origin: "https://app.example.test",
          },
          body: json({ query: "temple" }),
        },
      );
      await waitForDatabaseLock(gatePool, "row");
      const beforeRelease = await database.selectFrom("trip_places")
        .select("provider_unavailable")
        .where("id", "=", first.id)
        .executeTakeFirstOrThrow();
      expect(beforeRelease.provider_unavailable).toBe(false);
      await gate.query("commit");
      gateOpen = true;
      failedSearch = await failedSearchPromise;
    } finally {
      if (!gateOpen) await gate.query("rollback");
      gate.release();
      await gatePool.end();
    }
    expect(failedSearch!.status).toBe(503);
    expect((await list(owner.cookie, trip.id))[0]?.status).toBe("provider-unavailable");

    const manual = await app.request(`/api/trips/${trip.id}/trip-places`, {
      method: "POST",
      headers: {
        cookie: owner.cookie,
        "content-type": "application/json",
        "idempotency-key": "manual-during-outage",
        origin: "https://app.example.test",
      },
      body: json({
        method: "manual",
        name: "Private family address",
        type: "other",
        address: null,
        latitude: null,
        longitude: null,
        timeZone: null,
        sourceUrl: null,
        originalNote: "Ask the host for directions",
      }),
    });
    expect(manual.status).toBe(201);
    const manualPlace = parseTripPlaceResponse(await manual.json()).tripPlace;
    expect(manualPlace.status).toBe("needs-location");

    const current = (await list(owner.cookie, trip.id)).find((entry) => entry.id === first.id)!;
    expect((await removePlace(second.cookie, trip.id, current, "remove-during-outage")).status).toBe(204);
    expect((await list(owner.cookie, trip.id)).map((entry) => entry.id)).toEqual([manualPlace.id]);
    expect((await removePlace(second.cookie, trip.id, manualPlace, "remove-manual")).status).toBe(204);
    expect((await removePlace(second.cookie, trip.id, manualPlace, "remove-manual")).status).toBe(204);
    expect(await list(owner.cookie, trip.id)).toEqual([]);
  });


  it("replaces an exact stop slot, keeps the root across a chain, and restores that root on undo", async () => {
    const owner = await login("stop-replacement-chain@example.test");
    const trip = await createTrip(owner.cookie, "Stop replacement chain");
    const dayId = trip.days[0]!.id;
    const before = await addLocatedManualPlace(owner.cookie, trip.id, "replace-before", "Before", 35, 135.769);
    const original = await addLocatedManualPlace(owner.cookie, trip.id, "replace-original", "Original stop", 35, 135.77);
    const after = await addLocatedManualPlace(owner.cookie, trip.id, "replace-after", "After", 35, 135.771);
    await assignToDay(owner.cookie, trip.id, dayId, [before, original, after], "replace-assign");
    const initial = parseDayRouteResponse(await (await dayRoute(owner.cookie, trip.id, dayId, "current")).json()).route;
    expect((await saveDay(
      owner.cookie,
      trip.id,
      dayId,
      "place-order",
      "replace-order",
      initial.version,
      [before.id, original.id, after.id],
    )).status).toBe(200);

    const firstCandidate = nearbyCandidate("NearbyCandidateOne", "First nearby");
    const secondCandidate = nearbyCandidate("NearbyCandidateTwo", "Second nearby", {
      latitude: 35.0003,
      longitude: 135.7703,
    });
    provider.extraPlaces.set(firstCandidate.providerPlaceId, firstCandidate);
    provider.extraPlaces.set(secondCandidate.providerPlaceId, secondCandidate);

    const firstVersion = parseDayRouteResponse(
      await (await dayRoute(owner.cookie, trip.id, dayId, "current")).json(),
    ).route.version;
    const firstList = await replaceStop(
      owner.cookie,
      trip.id,
      dayId,
      original.id,
      firstCandidate.providerPlaceId,
      firstVersion,
      "replace-first",
    );
    const firstReplacement = firstList.find((place) => place.providerPlaceId === firstCandidate.providerPlaceId)!;
    expect(firstReplacement).toMatchObject({
      assignedDayId: dayId,
      dayPosition: 1,
      replacedStop: {
        originalTripPlaceId: original.id,
        originalName: original.name,
      },
    });
    expect(firstList.find((place) => place.id === original.id)).toMatchObject({
      assignedDayId: null,
      dayPosition: null,
      selectedForItinerary: false,
      unplacedFromDate: null,
    });
    expect(parseDayRouteResponse(
      await (await dayRoute(owner.cookie, trip.id, dayId, "current")).json(),
    ).route.orderedTripPlaceIds).toEqual([before.id, firstReplacement.id, after.id]);

    const secondVersion = parseDayRouteResponse(
      await (await dayRoute(owner.cookie, trip.id, dayId, "current")).json(),
    ).route.version;
    const secondList = await replaceStop(
      owner.cookie,
      trip.id,
      dayId,
      firstReplacement.id,
      secondCandidate.providerPlaceId,
      secondVersion,
      "replace-second",
    );
    const secondReplacement = secondList.find((place) => place.providerPlaceId === secondCandidate.providerPlaceId)!;
    expect(secondReplacement).toMatchObject({
      assignedDayId: dayId,
      dayPosition: 1,
      replacedStop: {
        originalTripPlaceId: original.id,
        originalName: original.name,
      },
    });
    expect(secondList.find((place) => place.id === firstReplacement.id)).toMatchObject({
      assignedDayId: null,
      selectedForItinerary: false,
      unplacedFromDate: null,
    });

    const relationId = secondReplacement.replacedStop!.replacementId;
    const undoneResponse = await app.request(`/api/trips/${trip.id}/stop-replacements/${relationId}/undo`, {
      method: "POST",
      headers: {
        cookie: owner.cookie,
        "content-type": "application/json",
        "idempotency-key": "replace-undo",
        origin: "https://app.example.test",
      },
      body: json({}),
    });
    expect(undoneResponse.status, await undoneResponse.clone().text()).toBe(200);
    const undone = parseTripPlaceListResponse(await undoneResponse.json()).tripPlaces;
    expect(undone.find((place) => place.id === original.id)).toMatchObject({
      assignedDayId: dayId,
      dayPosition: 1,
      replacedStop: null,
    });
    expect(undone.find((place) => place.id === secondReplacement.id)).toMatchObject({
      assignedDayId: null,
      selectedForItinerary: false,
      unplacedFromDate: null,
    });
  });

  it("supersedes a stale replacement relation after its replacement leaves and returns to the day", async () => {
    const owner = await login("stop-replacement-stale@example.test");
    const trip = await createTrip(owner.cookie, "Stale stop replacement");
    const dayId = trip.days[0]!.id;
    const original = await addLocatedManualPlace(owner.cookie, trip.id, "stale-original", "Stale original", 35, 135.77);
    const assigned = await assignToDay(owner.cookie, trip.id, dayId, [original], "stale-assign");
    const currentOriginal = assigned.find((place) => place.id === original.id)!;
    const candidate = nearbyCandidate("NearbyStaleCandidate", "Stale candidate");
    provider.extraPlaces.set(candidate.providerPlaceId, candidate);
    const version = parseDayRouteResponse(
      await (await dayRoute(owner.cookie, trip.id, dayId, "current")).json(),
    ).route.version;
    const replaced = await replaceStop(
      owner.cookie,
      trip.id,
      dayId,
      currentOriginal.id,
      candidate.providerPlaceId,
      version,
      "stale-replace",
    );
    const replacement = replaced.find((place) => place.providerPlaceId === candidate.providerPlaceId)!;
    const relationId = replacement.replacedStop!.replacementId;

    const unassigned = await assignToDay(owner.cookie, trip.id, null, [replacement], "stale-leave-day");
    const offDay = unassigned.find((place) => place.id === replacement.id)!;
    const returned = await assignToDay(owner.cookie, trip.id, dayId, [offDay], "stale-return-day");
    expect(returned.find((place) => place.id === replacement.id)).toMatchObject({
      assignedDayId: dayId,
      replacedStop: null,
    });

    const staleUndo = await app.request(`/api/trips/${trip.id}/stop-replacements/${relationId}/undo`, {
      method: "POST",
      headers: {
        cookie: owner.cookie,
        "content-type": "application/json",
        "idempotency-key": "stale-undo",
        origin: "https://app.example.test",
      },
      body: json({}),
    });
    expect(staleUndo.status).toBe(409);
  });

  it("filters and sorts nearby alternatives before returning them and authorizes before the provider call", async () => {
    const owner = await login("nearby-owner@example.test");
    const editor = await login("nearby-editor@example.test");
    const trip = await createTrip(owner.cookie, "Nearby alternatives");
    await addMember(trip.id, editor.user.id);
    const dayId = trip.days[0]!.id;
    const stop = await addLocatedManualPlace(owner.cookie, trip.id, "nearby-stop", "Nearby stop", 35, 135.77);
    await assignToDay(owner.cookie, trip.id, dayId, [stop], "nearby-stop-assign");

    const assignedCandidate = nearbyCandidate("NearbyAssignedPlace", "Already assigned");
    const archivedCandidate = nearbyCandidate("NearbyArchivedPlace", "Archived");
    const assignedPlace = await addProviderCandidate(
      owner.cookie,
      trip.id,
      "nearby-add-assigned",
      assignedCandidate,
    );
    const archivedPlace = await addProviderCandidate(
      owner.cookie,
      trip.id,
      "nearby-add-archived",
      archivedCandidate,
    );
    await assignToDay(owner.cookie, trip.id, trip.days[1]!.id, [assignedPlace], "nearby-assign-other-day");
    expect((await removePlace(owner.cookie, trip.id, archivedPlace, "nearby-archive")).status).toBe(204);

    const bestByReviews = nearbyCandidate("NearbyBestReviews", "Best by reviews");
    const sameRating = nearbyCandidate("NearbySameRating", "Same rating");
    const lowerRating = nearbyCandidate("NearbyLowerRating", "Lower rating");
    const nullRating = nearbyCandidate("NearbyNullRating", "Null rating");
    const wrongType = nearbyCandidate("NearbyWrongType", "Wrong type", { type: "activity" });
    provider.nearbyResults = [
      { candidate: nullRating, rating: null, userRatingCount: 99_999 },
      { candidate: lowerRating, rating: 4.5, userRatingCount: 2_000 },
      { candidate: sameRating, rating: 4.8, userRatingCount: 100 },
      { candidate: wrongType, rating: 5, userRatingCount: 10_000 },
      { candidate: assignedCandidate, rating: 5, userRatingCount: 9_000 },
      { candidate: archivedCandidate, rating: 5, userRatingCount: 8_000 },
      { candidate: bestByReviews, rating: 4.8, userRatingCount: 500 },
    ];

    const path = `/api/trips/${trip.id}/days/${dayId}/trip-places/${stop.id}/nearby-alternatives`;
    const forbidden = await app.request(path, {
      method: "POST",
      headers: { cookie: editor.cookie, origin: "https://app.example.test" },
    });
    expect(forbidden.status).toBe(403);
    expect(provider.nearbyRequests).toHaveLength(0);

    const response = await app.request(path, {
      method: "POST",
      headers: { cookie: owner.cookie, origin: "https://app.example.test" },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const result = parseNearbyAlternativesResponse(await response.json());
    expect(result.alternatives.map((alternative) => [
      alternative.name,
      alternative.rating,
      alternative.userRatingCount,
    ])).toEqual([
      ["Best by reviews", 4.8, 500],
      ["Same rating", 4.8, 100],
      ["Lower rating", 4.5, 2_000],
      ["Null rating", null, 99_999],
    ]);
    expect(provider.nearbyRequests).toHaveLength(1);
    expect(provider.nearbyRequests[0]).toMatchObject({
      latitude: 35,
      longitude: 135.77,
      languageCode: "zh-TW",
      regionCode: "JP",
    });
  });

  it("lets any member see nearby activities, reuses a stop's answer for the rest of the local day, and measures each venue", async () => {
    const owner = await login("activities-owner@example.test");
    const editor = await login("activities-editor@example.test");
    const outsider = await login("activities-outsider@example.test");
    const trip = await createTrip(owner.cookie, "Nearby activities");
    await addMember(trip.id, editor.user.id);
    const dayId = trip.days[0]!.id;
    const otherDayId = trip.days[1]!.id;
    const stop = await addLocatedManualPlace(owner.cookie, trip.id, "activities-stop", "Activities stop", 35, 135.77);
    const otherDayStop = await addLocatedManualPlace(owner.cookie, trip.id, "activities-other", "Other day stop", 35.1, 135.7);
    const unlocated = await addManualPlace(owner.cookie, trip.id, "activities-unlocated", "Unlocated stop");
    await assignToDay(owner.cookie, trip.id, dayId, [stop, unlocated], "activities-assign");
    await assignToDay(owner.cookie, trip.id, otherDayId, [otherDayStop], "activities-assign-other");

    const venue: FoundNearbyActivity = {
      title: "夜間參拜",
      description: "寺院晚上點燈開放參拜。",
      timeText: null,
      startsAt: "2026-10-21T18:00",
      endsAt: "2026-10-21T21:30",
      kind: "event",
      venueName: "測試寺",
      latitude: 35.005,
      longitude: 135.77,
      sourceUrl: "https://temple.example.jp/lightup",
      sourceTitle: "測試寺 夜間參拜",
    };
    const unplaced: FoundNearbyActivity = {
      ...venue,
      title: "和服租借",
      kind: "experience",
      startsAt: null,
      endsAt: null,
      venueName: null,
      latitude: null,
      longitude: null,
      sourceUrl: "https://kimono.example.jp/",
      sourceTitle: "kimono.example.jp",
    };
    const queries: NearbyActivityQuery[] = [];
    let failNext = false;
    const model: NearbyActivityModel = {
      available: true,
      find: async (query) => {
        queries.push(query);
        if (failNext) {
          failNext = false;
          throw new Error("provider down");
        }
        return [venue, unplaced];
      },
    };
    app = createApp({ ...appDependencies, nearbyActivities: new PostgresNearbyActivityModule({ database, model, now }) });
    const ask = (cookie: string, askedDayId: string, tripPlaceId: string) => app.request(
      `/api/trips/${trip.id}/days/${askedDayId}/trip-places/${tripPlaceId}/nearby-activities`,
      { method: "POST", headers: { cookie, origin: "https://app.example.test" } },
    );
    const denied = await ask(outsider.cookie, dayId, stop.id);
    expect(denied.status).toBe(404);
    expect(queries).toHaveLength(0);

    const notOnDay = await ask(owner.cookie, dayId, otherDayStop.id);
    expect(notOnDay.status).toBe(409);
    const missing = await ask(owner.cookie, dayId, randomUUID());
    expect(missing.status).toBe(404);
    const noCoordinates = await ask(owner.cookie, dayId, unlocated.id);
    expect(noCoordinates.status).toBe(422);
    expect(await noCoordinates.json()).toMatchObject({ error: { code: "activities_unsupported" } });
    expect(queries).toHaveLength(0);

    // An editor who cannot arrange the itinerary may still look: it changes nothing.
    const first = await ask(editor.cookie, dayId, stop.id);
    expect(first.status, await first.clone().text()).toBe(200);
    const firstResult = parseNearbyActivitiesResponse(await first.json());
    const firstFetchedAt = currentNow.toISOString();
    expect(firstResult).toMatchObject({ stopTripPlaceId: stop.id, date: "2026-10-21", fetchedAt: firstFetchedAt });
    expect(firstResult.activities.map((activity) => [activity.title, activity.straightLineMeters])).toEqual([
      ["夜間參拜", Math.round(straightLineMeters(
        { id: "stop", latitude: 35, longitude: 135.77 },
        { id: "venue", latitude: 35.005, longitude: 135.77 },
      ))],
      ["和服租借", null],
    ]);
    expect(firstResult.activities[0]!.straightLineMeters).toBeGreaterThan(500);
    expect(queries).toEqual([expect.objectContaining({
      stopName: "Activities stop",
      latitude: 35,
      longitude: 135.77,
      date: "2026-10-21",
      timeZone: "Asia/Tokyo",
      countryCode: "JP",
    })]);

    // 12:00Z is 21:00 in Tokyo: the answer is reused until local midnight (15:00Z), then asked again.
    currentNow = new Date("2026-09-28T14:59:00.000Z");
    const cached = await ask(owner.cookie, dayId, stop.id);
    expect(cached.status).toBe(200);
    expect(parseNearbyActivitiesResponse(await cached.json())).toEqual(firstResult);
    expect(queries).toHaveLength(1);

    currentNow = new Date("2026-09-28T15:01:00.000Z");
    const refreshed = await ask(owner.cookie, dayId, stop.id);
    expect(refreshed.status).toBe(200);
    expect(parseNearbyActivitiesResponse(await refreshed.json()).fetchedAt).toBe(currentNow.toISOString());
    expect(queries).toHaveLength(2);

    // A failed lookup is not cached: the next tap asks again.
    failNext = true;
    const failed = await ask(owner.cookie, otherDayId, otherDayStop.id);
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ error: { code: "provider_unavailable" } });
    const retried = await ask(owner.cookie, otherDayId, otherDayStop.id);
    expect(retried.status).toBe(200);
    expect(queries).toHaveLength(4);

    // Without an OpenAI key and model: a stored answer still shows, a new lookup is unavailable.
    app = createApp({
      ...appDependencies,
      nearbyActivities: new PostgresNearbyActivityModule({
        database,
        model: { available: false, find: async () => { throw new Error("never called"); } },
        now,
      }),
    });
    expect((await ask(owner.cookie, dayId, stop.id)).status).toBe(200);
    await database.deleteFrom("nearby_activity_results").execute();
    const unconfigured = await ask(owner.cookie, dayId, stop.id);
    expect(unconfigured.status).toBe(503);
    expect(await unconfigured.json()).toMatchObject({ error: { code: "activities_unavailable" } });
  });

  it("limits uncached nearby activity lookups per account", async () => {
    const owner = await login("activities-quota@example.test");
    const trip = await createTrip(owner.cookie, "Nearby activity quota");
    const dayId = trip.days[0]!.id;
    const stop = await addLocatedManualPlace(owner.cookie, trip.id, "activities-quota-stop", "Quota stop", 35, 135.77);
    await assignToDay(owner.cookie, trip.id, dayId, [stop], "activities-quota-assign");
    let calls = 0;
    app = createApp({
      ...appDependencies,
      nearbyActivities: new PostgresNearbyActivityModule({
        database,
        model: { available: true, find: async () => { calls += 1; return []; } },
        now,
      }),
    });
    const ask = () => app.request(
      `/api/trips/${trip.id}/days/${dayId}/trip-places/${stop.id}/nearby-activities`,
      { method: "POST", headers: { cookie: owner.cookie, origin: "https://app.example.test" } },
    );
    // Cache hits are free; only lookups that reach the provider count.
    for (let lookup = 0; lookup < 30; lookup += 1) {
      await database.deleteFrom("nearby_activity_results").execute();
      expect((await ask()).status).toBe(200);
      expect((await ask()).status).toBe(200);
    }
    expect(calls).toBe(30);
    await database.deleteFrom("nearby_activity_results").execute();
    const limited = await ask();
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: { code: "rate_limited" } });
    expect(calls).toBe(30);
  });

  it("selects Google for known non-Japan days, keeps NAVITIME for Japan, and fails closed without a country or key", async () => {
    const owner = await login("transit-provider-selection@example.test");
    const japan = await createTrip(owner.cookie, "Japan transit provider");
    const japanRoute = parseDayRouteResponse(await (await dayRoute(
      owner.cookie,
      japan.id,
      japan.days[1]!.id,
      "current",
    )).json()).route;
    expect(japanRoute).toMatchObject({
      transitProvider: "navitime",
      travelSource: "straight_line",
      routeShapesAvailable: true,
    });

    const france = await createTrip(owner.cookie, "France transit provider", {
      countryCodes: ["FR"],
      timeZone: "Europe/Paris",
    });
    const franceRoute = parseDayRouteResponse(await (await dayRoute(
      owner.cookie,
      france.id,
      france.days[1]!.id,
      "current",
    )).json()).route;
    expect(franceRoute).toMatchObject({
      transitProvider: "google_routes",
      travelSource: "straight_line",
      routeShapesAvailable: true,
    });

    const unknown = await createTrip(owner.cookie, "Unknown day country", {
      countryCodes: ["FR", "DE"],
      timeZone: "Europe/Paris",
    });
    await sql`
      update itinerary_endpoints
      set country_stop_id = null
      where itinerary_item_id in (
        select id from itinerary_items where trip_id = ${unknown.id}
      )
    `.execute(database);
    const unknownRoute = parseDayRouteResponse(await (await dayRoute(
      owner.cookie,
      unknown.id,
      unknown.days[0]!.id,
      "current",
    )).json()).route;
    expect(unknownRoute).toMatchObject({
      transitProvider: null,
      travelSource: "straight_line",
      routeShapesAvailable: false,
    });

    const unconfiguredGoogle = new GoogleRoutesProvider({
      apiKey: " ",
      reserveBudget: async () => ({ refund: async () => {} }),
    });
    app = createApp({
      ...appDependencies,
      dayPlans: new PostgresDayPlanModule({
        database,
        tripSkeleton,
        tripPlaces,
        navitime,
        googleRoutes: unconfiguredGoogle,
      }),
    });
    const noKeyRoute = parseDayRouteResponse(await (await dayRoute(
      owner.cookie,
      france.id,
      france.days[1]!.id,
      "current",
    )).json()).route;
    expect(noKeyRoute).toMatchObject({
      transitProvider: null,
      travelSource: "straight_line",
      routeShapesAvailable: false,
    });
  });

  it("prices every Google matrix element, rejects a changed budget before calling Google, orders by minutes, and never changes the NAVITIME cache", async () => {
    const owner = await login("google-transit-matrix@example.test");
    const trip = await createTrip(owner.cookie, "Google transit matrix", {
      countryCodes: ["FR"],
      timeZone: "Europe/Paris",
    });
    const day = trip.days[1]!;
    const first = await addLocatedManualPlace(
      owner.cookie, trip.id, "google-transit-first", "Google first", 48.85, 2.35, "Europe/Paris",
    );
    const second = await addLocatedManualPlace(
      owner.cookie, trip.id, "google-transit-second", "Google second", 48.86, 2.36, "Europe/Paris",
    );
    const third = await addLocatedManualPlace(
      owner.cookie, trip.id, "google-transit-third", "Google third", 48.87, 2.37, "Europe/Paris",
    );
    await assignToDay(owner.cookie, trip.id, day.id, [first, second, third], "google-transit-assign");
    await database.insertInto("transit_leg_cache").values({
      trip_id: trip.id,
      travel_date: day.date,
      from_lat: "48.850000",
      from_lon: "2.350000",
      to_lat: "48.860000",
      to_lon: "2.360000",
      minutes: 999,
      lines: JSON.stringify(["cache must be ignored"]),
      minutes_fetched_at: new Date(),
      shape_geojson: null,
      shape_fetched_at: null,
    }).execute();

    const cached = parseDayRouteResponse(await (await dayRoute(
      owner.cookie,
      trip.id,
      day.id,
      "suggested",
      undefined,
      "cached",
    )).json()).route;
    expect(cached).toMatchObject({
      transitProvider: "google_routes",
      travelSource: "straight_line",
      transitCallsNeeded: 6,
    });
    expect(googleMatrixRequests).toHaveLength(0);

    const changedBudget = await dayRoute(
      owner.cookie,
      trip.id,
      day.id,
      "suggested",
      undefined,
      "fetch",
      5,
    );
    expect(changedBudget.status).toBe(409);
    expect(await changedBudget.json()).toMatchObject({
      error: { code: "transit_calls_changed", transitCallsNeeded: 6 },
    });
    expect(googleMatrixRequests).toHaveLength(0);

    const fetched = parseDayRouteResponse(await (await dayRoute(
      owner.cookie,
      trip.id,
      day.id,
      "suggested",
      undefined,
      "fetch",
      cached.transitCallsNeeded,
    )).json()).route;
    expect(googleMatrixRequests.flat()).toHaveLength(6);
    expect(new Set(googleMatrixRequests.flat().map(({ fromId, toId }) => `${fromId}:${toId}`))).toEqual(new Set([
      `${first.id}:${second.id}`,
      `${first.id}:${third.id}`,
      `${second.id}:${first.id}`,
      `${second.id}:${third.id}`,
      `${third.id}:${first.id}`,
      `${third.id}:${second.id}`,
    ]));
    expect(fetched).toMatchObject({
      transitProvider: "google_routes",
      travelSource: "google_routes",
      transitCallsNeeded: 6,
      orderedTripPlaceIds: [third.id, second.id, first.id],
    });
    expect(await database.selectFrom("transit_leg_cache")
      .select("minutes")
      .where("trip_id", "=", trip.id)
      .execute()).toEqual([{ minutes: 999 }]);
  });

  it("keeps straight-line leg estimates when Google reports that a transit route is missing", async () => {
    const owner = await login("google-missing-route@example.test");
    const trip = await createTrip(owner.cookie, "Google missing route", {
      countryCodes: ["FR"],
      timeZone: "Europe/Paris",
    });
    const day = trip.days[1]!;
    const first = await addLocatedManualPlace(
      owner.cookie, trip.id, "google-missing-first", "Missing first", 48.85, 2.35, "Europe/Paris",
    );
    const second = await addLocatedManualPlace(
      owner.cookie, trip.id, "google-missing-second", "Missing second", 48.86, 2.36, "Europe/Paris",
    );
    await assignToDay(owner.cookie, trip.id, day.id, [first, second], "google-missing-assign");
    const missingRouteGoogle = new GoogleRoutesProvider({
      apiKey: "stub-google-routes-key",
      reserveBudget: async () => ({ refund: async () => {} }),
    });
    app = createApp({
      ...appDependencies,
      dayPlans: new PostgresDayPlanModule({
        database,
        tripSkeleton,
        tripPlaces,
        navitime,
        googleRoutes: missingRouteGoogle,
      }),
    });
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { destinations: unknown[] };
      return Response.json(body.destinations.map((_destination, destinationIndex) => ({
        originIndex: 0,
        destinationIndex,
        status: {},
        condition: "ROUTE_NOT_FOUND",
      })));
    });
    vi.stubGlobal("fetch", fetch);
    try {
      const route = parseDayRouteResponse(await (await dayRoute(
        owner.cookie,
        trip.id,
        day.id,
        "suggested",
        undefined,
        "fetch",
        2,
      )).json()).route;

      expect(fetch).toHaveBeenCalled();
      expect(route).toMatchObject({
        transitProvider: "google_routes",
        travelSource: "straight_line",
        travelNotice: "transit_unavailable",
        transitCallsNeeded: 2,
        totalMinutes: null,
      });
      expect(route.stops.map((stop) => stop.minutesFromPrevious)).toEqual([null, null]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("atomically refunds an aborted first Google reservation but keeps a sent request charged", async () => {
    const from = { id: "refund-from", latitude: 48.85, longitude: 2.35 };
    const to = { id: "refund-to", latitude: 48.86, longitude: 2.36 };
    const beforeFetchController = new AbortController();
    const beforeFetch = vi.fn();
    vi.stubGlobal("fetch", beforeFetch);
    try {
      const abortingProvider = new GoogleRoutesProvider({
        apiKey: "stub-google-routes-key",
        reserveBudget: async (cost) => {
          const reservation = await rateLimiter.reservePaidProvider("google_routes", cost);
          beforeFetchController.abort();
          return reservation;
        },
      });
      await rateLimiter.withPaidProviderIdentity("198.51.100.70", "refund-account", async () => {
        await expect(abortingProvider.shape(
          from, to, "2026-10-21", "Europe/Paris", beforeFetchController.signal,
        )).rejects.toMatchObject({ code: "transit_unavailable" });
      });
      expect(beforeFetch).not.toHaveBeenCalled();
      expect(await database.selectFrom("rate_limit_windows")
        .select(["scope", "request_count"])
        .where("scope", "like", "paid_provider:google_routes:%")
        .execute()).toEqual([]);

      const sentFetch = vi.fn(async () => {
        throw new DOMException("Aborted", "AbortError");
      });
      vi.stubGlobal("fetch", sentFetch);
      const sentProvider = new GoogleRoutesProvider({
        apiKey: "stub-google-routes-key",
        reserveBudget: (cost) => rateLimiter.reservePaidProvider("google_routes", cost),
      });
      await rateLimiter.withPaidProviderIdentity("198.51.100.70", "refund-account", async () => {
        await expect(sentProvider.shape(
          from, to, "2026-10-21", "Europe/Paris", new AbortController().signal,
        )).rejects.toMatchObject({ code: "transit_unavailable" });
      });
      expect(sentFetch).toHaveBeenCalledOnce();
      expect(await database.selectFrom("rate_limit_windows")
        .select(["scope", "request_count"])
        .where("scope", "like", "paid_provider:google_routes:%")
        .orderBy("scope")
        .execute()).toEqual([
        { scope: "paid_provider:google_routes:account", request_count: 1 },
        { scope: "paid_provider:google_routes:global", request_count: 1 },
        { scope: "paid_provider:google_routes:ip", request_count: 1 },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses no transit provider calls for cached reads, fetches only missing legs, and reuses the seven-day cache", async () => {
    const owner = await login("transit-cache@example.test");
    const trip = await createTrip(owner.cookie, "Transit cache");
    const dayId = trip.days[1]!.id;
    const first = await addLocatedManualPlace(owner.cookie, trip.id, "transit-first", "Transit first", 35, 135.77);
    const second = await addLocatedManualPlace(owner.cookie, trip.id, "transit-second", "Transit second", 35.01, 135.78);
    await assignToDay(owner.cookie, trip.id, dayId, [first, second], "transit-assign-two");

    const cached = parseDayRouteResponse(await (await dayRoute(
      owner.cookie,
      trip.id,
      dayId,
      "suggested",
      undefined,
      "cached",
    )).json()).route;
    expect(cached.transitCallsNeeded).toBe(2);
    expect(transitRequests).toHaveLength(0);

    const changedBudget = await dayRoute(
      owner.cookie,
      trip.id,
      dayId,
      "suggested",
      undefined,
      "fetch",
      1,
    );
    expect(changedBudget.status).toBe(409);
    expect(await changedBudget.json()).toMatchObject({
      error: { code: "transit_calls_changed", transitCallsNeeded: 2 },
    });
    expect(transitRequests).toHaveLength(0);

    const fetched = parseDayRouteResponse(await (await dayRoute(
      owner.cookie,
      trip.id,
      dayId,
      "suggested",
      undefined,
      "fetch",
      cached.transitCallsNeeded,
    )).json()).route;
    expect(transitRequests).toHaveLength(2);
    expect(fetched).toMatchObject({
      travelSource: "navitime",
      transitCallsNeeded: 0,
    });

    const afterFirstFetch = transitRequests.length;
    const repeated = parseDayRouteResponse(await (await dayRoute(
      owner.cookie,
      trip.id,
      dayId,
      "suggested",
      undefined,
      "fetch",
      0,
    )).json()).route;
    expect(transitRequests).toHaveLength(afterFirstFetch);
    expect(repeated.transitCacheDays).toBe(7);
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1_000;
    const cacheRows = await database.selectFrom("transit_leg_cache")
      .select(["from_lat", "from_lon", "to_lat", "to_lon"])
      .where("trip_id", "=", trip.id)
      .execute();
    expect(cacheRows).toHaveLength(2);
    await database.updateTable("transit_leg_cache")
      .set({ minutes_fetched_at: new Date(Date.now() - sevenDaysMs + 60_000) })
      .where("trip_id", "=", trip.id)
      .execute();
    const withinSevenDays = parseDayRouteResponse(await (await dayRoute(
      owner.cookie,
      trip.id,
      dayId,
      "suggested",
      undefined,
      "cached",
    )).json()).route;
    expect(withinSevenDays.transitCallsNeeded).toBe(0);
    expect(transitRequests).toHaveLength(afterFirstFetch);

    const expiredLeg = cacheRows[0]!;
    await database.updateTable("transit_leg_cache")
      .set({ minutes_fetched_at: new Date(Date.now() - sevenDaysMs - 60_000) })
      .where("trip_id", "=", trip.id)
      .where("from_lat", "=", expiredLeg.from_lat)
      .where("from_lon", "=", expiredLeg.from_lon)
      .where("to_lat", "=", expiredLeg.to_lat)
      .where("to_lon", "=", expiredLeg.to_lon)
      .execute();
    const afterExpiry = parseDayRouteResponse(await (await dayRoute(
      owner.cookie,
      trip.id,
      dayId,
      "suggested",
      undefined,
      "cached",
    )).json()).route;
    expect(afterExpiry.transitCallsNeeded).toBe(1);
    expect(transitRequests).toHaveLength(afterFirstFetch);
    await dayRoute(
      owner.cookie,
      trip.id,
      dayId,
      "suggested",
      undefined,
      "fetch",
      1,
    );
    expect(transitRequests).toHaveLength(afterFirstFetch + 1);
    const afterExpiryFetch = transitRequests.length;

    const third = await addLocatedManualPlace(owner.cookie, trip.id, "transit-third", "Transit third", 35.02, 135.79);
    await assignToDay(owner.cookie, trip.id, dayId, [third], "transit-assign-third");
    const partiallyCached = parseDayRouteResponse(await (await dayRoute(
      owner.cookie,
      trip.id,
      dayId,
      "suggested",
      undefined,
      "cached",
    )).json()).route;
    expect(partiallyCached.transitCallsNeeded).toBe(4);
    expect(transitRequests).toHaveLength(afterExpiryFetch);

    await dayRoute(
      owner.cookie,
      trip.id,
      dayId,
      "suggested",
      undefined,
      "fetch",
      partiallyCached.transitCallsNeeded,
    );
    expect(transitRequests).toHaveLength(afterExpiryFetch + 4);
    const requestedPairs = new Set(transitRequests.slice(afterExpiryFetch).map(({ fromId, toId }) => `${fromId}:${toId}`));
    expect(requestedPairs).toEqual(new Set([
      `${first.id}:${third.id}`,
      `${second.id}:${third.id}`,
      `${third.id}:${first.id}`,
      `${third.id}:${second.id}`,
    ]));
  });
  it("names booked lodging without coordinates in the day route while leaving its legs unknown", async () => {
    const owner = await login("unlocated-lodging-route@example.test");
    const trip = await createTrip(owner.cookie, "Unlocated lodging route");
    const lodging = await app.request(`/api/trips/${trip.id}/lodgings`, {
      method: "POST",
      headers: {
        cookie: owner.cookie,
        "content-type": "application/json",
        "idempotency-key": "unlocated-lodging",
        origin: "https://app.example.test",
      },
      body: json({
        hotel: {
          name: "Hotel Without A Pin",
          address: "Kyoto",
          latitude: null,
          longitude: null,
          timeZone: "Asia/Tokyo",
          sourceUrl: null,
        },
        countryStopId: trip.countryStops[0]!.id,
        checkInLocalDateTime: "2026-10-21T15:00",
        checkOutLocalDateTime: "2026-10-23T10:00",
        expectedTripVersion: trip.version,
      }),
    });
    expect(lodging.status, await lodging.clone().text()).toBe(201);

    const response = await dayRoute(
      owner.cookie,
      trip.id,
      trip.days[1]!.id,
      "current",
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const route = parseDayRouteResponse(await response.json()).route;
    expect(route.startsAt).toMatchObject({
      name: "Hotel Without A Pin",
      latitude: null,
      longitude: null,
    });
    expect(route.endsAt).toMatchObject({
      name: "Hotel Without A Pin",
      latitude: null,
      longitude: null,
    });
    expect(route.stops).toEqual([]);
    expect(route.metersToEnd).toBeNull();
    expect(route.totalMeters).toBe(0);
  });

  it("gives the day route the day load's start, fixed time, stays and straight-line legs, with stations as zero-minute transfers", async () => {
    const owner = await login("route-timing@example.test");
    const trip = await createTrip(owner.cookie, "Route timing");
    const headers = (key: string) => ({ cookie: owner.cookie, "content-type": "application/json", "idempotency-key": key, origin: "https://app.example.test" });
    const lodging = await app.request(`/api/trips/${trip.id}/lodgings`, {
      method: "POST",
      headers: headers("route-timing-lodging"),
      body: json({
        hotel: { name: "Kyoto Hotel", address: "Kyoto", latitude: 35.0, longitude: 135.76, timeZone: "Asia/Tokyo", sourceUrl: null },
        countryStopId: trip.countryStops[0]!.id,
        checkInLocalDateTime: "2026-10-22T15:00",
        checkOutLocalDateTime: "2026-10-24T10:00",
        expectedTripVersion: trip.version,
      }),
    });
    expect(lodging.status, await lodging.clone().text()).toBe(201);
    const visited = await addLocatedManualPlace(owner.cookie, trip.id, "route-timing-member", "Member stay", 35.01, 135.77);
    const defaulted = await addLocatedManualPlace(owner.cookie, trip.id, "route-timing-default", "Default stay", 35.02, 135.78);
    const stationResponse = await app.request(`/api/trips/${trip.id}/trip-places`, {
      method: "POST",
      headers: headers("route-timing-station"),
      body: json({ method: "manual", name: "Kyoto Station", type: "station", address: "Kyoto Station address",
        latitude: 34.985, longitude: 135.758, timeZone: "Asia/Tokyo", sourceUrl: null, originalNote: null }),
    });
    expect(stationResponse.status, await stationResponse.clone().text()).toBe(201);
    const station = parseTripPlaceResponse(await stationResponse.json()).tripPlace;
    // A member-entered stay of 90 minutes (the helper also sets notes and a budget).
    expect((await planning(owner.cookie, trip.id, visited.id, visited.version, "route-timing-stay", "member stay")).status).toBe(200);
    const dayId = trip.days[2]!.id;
    await assignToDay(owner.cookie, trip.id, dayId, (await list(owner.cookie, trip.id))
      .filter((place) => [visited.id, defaulted.id, station.id].includes(place.id)), "route-timing-assign");
    const planningModule = new PostgresPlanningSettingsModule({ database });
    await planningModule.putOverride(owner.user.id, trip.id, dayId, "route-timing-override", {
      expectedVersion: 0, values: { ...EMPTY_PLANNING_OVERRIDE, dayStart: "10:30" },
    });

    // Apply an explicit order so the saved route and the day load walk the same sequence.
    const unordered = parseDayRouteResponse(await (await dayRoute(owner.cookie, trip.id, dayId, "current")).json()).route;
    const ordered = await saveDay(owner.cookie, trip.id, dayId, "place-order", "route-timing-order", unordered.version,
      [visited.id, station.id, defaulted.id]);
    expect(ordered.status, await ordered.clone().text()).toBe(200);

    const response = await dayRoute(owner.cookie, trip.id, dayId, "current");
    expect(response.status, await response.clone().text()).toBe(200);
    const route = parseDayRouteResponse(await response.json()).route;
    const planningLoad = await planningModule.getLoad(owner.user.id, trip.id);
    const load = planningLoad.days.find((day) => day.dayId === dayId)!;
    const loadEstimates = planningLoad.estimates;

    expect(route.dayStartMinute).toBe(10 * 60 + 30);
    expect(route.fixedMinutes).toBe(load.fixedOccupancyMinutes);
    const byId = new Map(route.stops.map((stop) => [stop.tripPlaceId, stop]));
    expect(byId.get(visited.id)).toMatchObject({ stayMinutes: 90, stayEstimated: false });
    expect(byId.get(defaulted.id)).toMatchObject({ stayMinutes: loadEstimates[defaulted.id]!.visitMinutes, stayEstimated: true });
    expect(byId.get(station.id)).toMatchObject({ stayMinutes: 0, stayEstimated: false });
    // Every leg, start and end included, carries the day load's own straight-line minutes.
    const loadLegs = new Map(load.legs.map((leg) => [`${leg.fromId}:${leg.toId}`, leg.travelMinutes]));
    const points = [route.startsAt!.placeId, ...route.stops.map((stop) => stop.tripPlaceId), route.endsAt!.placeId];
    expect(route.orderedTripPlaceIds).toEqual([visited.id, station.id, defaulted.id]);
    expect(load.route.map((node) => node.id)).toEqual(points);
    const routeLegs = [...route.stops.map((stop) => stop.estimatedMoveMinutesFromPrevious), route.estimatedMoveMinutesToEnd];
    expect(routeLegs.every((minutes) => typeof minutes === "number")).toBe(true);
    expect(routeLegs).toEqual(points.slice(1).map((to, index) => loadLegs.get(`${points[index]}:${to}`)));
  });

  it("starts an arrival day's route clock an hour after the plane lands, like the day load", async () => {
    const owner = await login("route-arrival@example.test");
    const flights = tripFlights("2026-10-21", "2026-10-27", "Asia/Tokyo");
    const created = await app.request("/api/trips", {
      method: "POST",
      headers: { cookie: owner.cookie, "content-type": "application/json", "idempotency-key": "create-route-arrival", origin: "https://app.example.test" },
      body: json({
        name: "Route arrival", startDate: "2026-10-21", endDate: "2026-10-27", countryCodes: ["JP"],
        flights: { ...flights, outbound: { ...flights.outbound, departureLocalDateTime: "2026-10-21T11:00", arrivalLocalDateTime: "2026-10-21T14:00" } },
      }),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const trip = parseTripResponse(await created.json()).trip;
    const place = await addLocatedManualPlace(owner.cookie, trip.id, "route-arrival-place", "After landing", 35.01, 135.77);
    await assignToDay(owner.cookie, trip.id, trip.days[0]!.id, [place], "route-arrival-assign");

    const response = await dayRoute(owner.cookie, trip.id, trip.days[0]!.id, "current");
    expect(response.status, await response.clone().text()).toBe(200);
    const route = parseDayRouteResponse(await response.json()).route;
    // Landing 14:00 + the one-hour arrival buffer, not the 09:00 setting.
    expect(route.dayStartMinute).toBe(15 * 60);
    expect(route.fixedMinutes).toBe(0);
  });

  it("lets editors preview routes but hides every day and save mutation from non-schedulers", async () => {
    const owner = await login("route-permission-owner@example.test");
    const editor = await login("route-permission-editor@example.test");
    const outsider = await login("route-permission-outsider@example.test");
    const trip = await createTrip(owner.cookie, "Route permissions");
    await addMember(trip.id, editor.user.id);
    const first = await addManualPlace(owner.cookie, trip.id, "route-permission-first", "First");
    const second = await addManualPlace(owner.cookie, trip.id, "route-permission-second", "Second");
    const dayId = trip.days[0]!.id;
    await assignToDay(owner.cookie, trip.id, dayId, [first, second], "route-permission-assign");
    const currentResponse = await dayRoute(owner.cookie, trip.id, dayId, "current");
    expect(currentResponse.status).toBe(200);
    const current = parseDayRouteResponse(await currentResponse.json()).route;
    const beforePlaces = await list(owner.cookie, trip.id);
    const beforeEvents = await history(owner.cookie, trip.id);

    const preview = await dayRoute(editor.cookie, trip.id, dayId, "suggested");
    expect(preview.status, await preview.clone().text()).toBe(200);
    expect(parseDayRouteResponse(await preview.json()).route.orderedTripPlaceIds)
      .toEqual(current.orderedTripPlaceIds);
    expect((await dayRoute(outsider.cookie, trip.id, dayId, "current")).status).toBe(404);

    for (const endpoint of ["place-order", "arrangement"] as const) {
      expect((await saveDay(
        outsider.cookie,
        trip.id,
        dayId,
        endpoint,
        `route-outsider-${endpoint}`,
        current.version,
        current.orderedTripPlaceIds,
      )).status).toBe(404);
      const forbidden = await saveDay(
        editor.cookie,
        trip.id,
        dayId,
        endpoint,
        `route-editor-${endpoint}`,
        current.version,
        current.orderedTripPlaceIds,
      );
      expect(forbidden.status).toBe(403);
      expect(await forbidden.json()).toMatchObject({ error: { code: "forbidden" } });
    }

    expect(await list(owner.cookie, trip.id)).toEqual(beforePlaces);
    expect(await history(owner.cookie, trip.id)).toEqual(beforeEvents);
  });

  it("rejects duplicate, case-duplicate, foreign and unassigned custom route IDs", async () => {
    const owner = await login("route-custom-validation@example.test");
    const trip = await createTrip(owner.cookie, "Custom route validation");
    const otherTrip = await createTrip(owner.cookie, "Foreign custom route");
    const assigned = await addManualPlace(owner.cookie, trip.id, "custom-assigned", "Assigned");
    const unassigned = await addManualPlace(owner.cookie, trip.id, "custom-unassigned", "Unassigned");
    const foreign = await addManualPlace(owner.cookie, otherTrip.id, "custom-foreign", "Foreign");
    const dayId = trip.days[0]!.id;
    await assignToDay(owner.cookie, trip.id, dayId, [assigned], "custom-validation-assign");

    for (const [name, ids] of [
      ["duplicate", [assigned.id, assigned.id]],
      ["case duplicate", [assigned.id, assigned.id.toUpperCase()]],
      ["foreign", [foreign.id]],
      ["unassigned", [unassigned.id]],
    ] as const) {
      const response = await dayRoute(owner.cookie, trip.id, dayId, "custom", [...ids]);
      expect(response.status, name).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "validation_error" } });
    }
  });

  it("accepts 100 route places and rejects 101 at preview and both save boundaries", async () => {
    const owner = await login("route-boundary@example.test");
    const trip = await createTrip(owner.cookie, "Route boundary");
    const dayId = trip.days[0]!.id;
    const places: TripPlaceDto[] = [];
    for (let index = 0; index < 101; index += 1) {
      places.push(await addManualPlace(
        owner.cookie,
        trip.id,
        `route-boundary-place-${index}`,
        `Boundary ${String(index).padStart(3, "0")}`,
      ));
    }
    await assignToDay(owner.cookie, trip.id, dayId, places.slice(0, 100), "route-boundary-first-100");
    await assignToDay(owner.cookie, trip.id, dayId, places.slice(100), "route-boundary-last");
    const ids = places.map((place) => place.id);

    const hundred = await dayRoute(owner.cookie, trip.id, dayId, "custom", ids.slice(0, 100));
    expect(hundred.status, await hundred.clone().text()).toBe(200);
    const route = parseDayRouteResponse(await hundred.json()).route;
    expect(route.orderedTripPlaceIds).toHaveLength(100);
    expect((await dayRoute(owner.cookie, trip.id, dayId, "custom", ids)).status).toBe(400);

    const ordered = await saveDay(
      owner.cookie,
      trip.id,
      dayId,
      "place-order",
      "route-boundary-order-100",
      route.version,
      ids.slice(0, 100),
    );
    expect(ordered.status, await ordered.clone().text()).toBe(200);
    const orderedBody = await ordered.json() as { version: number };
    expect((await saveDay(
      owner.cookie,
      trip.id,
      dayId,
      "place-order",
      "route-boundary-order-101",
      orderedBody.version,
      ids,
    )).status).toBe(400);

    const arranged = await saveDay(
      owner.cookie,
      trip.id,
      dayId,
      "arrangement",
      "route-boundary-arrange-100",
      orderedBody.version,
      ids.slice(0, 100),
    );
    expect(arranged.status, await arranged.clone().text()).toBe(200);
    expect((await saveDay(
      owner.cookie,
      trip.id,
      dayId,
      "arrangement",
      "route-boundary-arrange-101",
      orderedBody.version,
      ids,
    )).status).toBe(400);
  });

  it("returns a current-version conflict when a custom route snapshot races an unassignment", async () => {
    const owner = await login("route-version-race@example.test");
    const trip = await createTrip(owner.cookie, "Route version race");
    const place = await addManualPlace(owner.cookie, trip.id, "route-race-place", "Racing place");
    const dayId = trip.days[0]!.id;
    await assignToDay(owner.cookie, trip.id, dayId, [place], "route-race-assign");
    const eventsBefore = await database.selectFrom("change_events").select("id")
      .where("trip_id", "=", trip.id).execute();
    const originalList = tripPlaces.list;
    let raced = false;
    tripPlaces.list = async (userId, listedTripId) => {
      if (!raced) {
        raced = true;
        await database.deleteFrom("trip_place_desired_days")
          .where("trip_id", "=", trip.id)
          .where("trip_place_id", "=", place.id)
          .execute();
      }
      return originalList.call(tripPlaces, userId, listedTripId);
    };
    let response: Response;
    try {
      response = await dayRoute(owner.cookie, trip.id, dayId, "custom", [place.id]);
    } finally {
      tripPlaces.list = originalList;
    }
    const currentVersion = (await database.selectFrom("trip_days").select("version")
      .where("id", "=", dayId).executeTakeFirstOrThrow()).version;
    expect(response!.status).toBe(409);
    expect(await response!.json()).toMatchObject({
      error: { code: "conflict", currentVersion },
    });
    expect(await database.selectFrom("change_events").select("id")
      .where("trip_id", "=", trip.id).execute()).toEqual(eventsBefore);
  });

  it("replays both day saves idempotently and applies arrangement subset and empty-list semantics", async () => {
    const owner = await login("route-save-replay@example.test");
    const trip = await createTrip(owner.cookie, "Route save replay");
    const dayId = trip.days[0]!.id;
    const first = await addManualPlace(owner.cookie, trip.id, "route-replay-first", "First replay");
    const second = await addManualPlace(owner.cookie, trip.id, "route-replay-second", "Second replay");
    const third = await addManualPlace(owner.cookie, trip.id, "route-replay-third", "Third replay");
    await assignToDay(owner.cookie, trip.id, dayId, [first, second, third], "route-replay-assign");
    const version = parseDayRouteResponse(
      await (await dayRoute(owner.cookie, trip.id, dayId, "current")).json(),
    ).route.version;
    const orderedIds = [third.id, first.id, second.id];
    const orderKey = "route-replay-order";
    const firstOrder = await saveDay(
      owner.cookie,
      trip.id,
      dayId,
      "place-order",
      orderKey,
      version,
      orderedIds,
    );
    expect(firstOrder.status).toBe(200);
    const firstOrderBody = await firstOrder.json();
    const orderedEvents = await database.selectFrom("change_events").select("id")
      .where("trip_id", "=", trip.id)
      .where("event_type", "=", "trip_day.places_ordered")
      .execute();
    const replayedOrder = await saveDay(
      owner.cookie,
      trip.id,
      dayId,
      "place-order",
      orderKey,
      version,
      orderedIds,
    );
    expect(replayedOrder.status).toBe(200);
    expect(await replayedOrder.json()).toEqual(firstOrderBody);
    expect(await database.selectFrom("change_events").select("id")
      .where("trip_id", "=", trip.id)
      .where("event_type", "=", "trip_day.places_ordered")
      .execute()).toEqual(orderedEvents);

    const subsetVersion = parseDayRouteResponse(
      await (await dayRoute(owner.cookie, trip.id, dayId, "current")).json(),
    ).route.version;
    const arrangementKey = "route-replay-subset";
    const subset = await saveDay(
      owner.cookie,
      trip.id,
      dayId,
      "arrangement",
      arrangementKey,
      subsetVersion,
      [second.id],
    );
    expect(subset.status).toBe(200);
    const subsetBody = await subset.json();
    const subsetPlaces = parseTripPlaceListResponse(subsetBody).tripPlaces;
    expect(subsetPlaces.find((place) => place.id === second.id)).toMatchObject({
      assignedDayId: dayId,
      dayPosition: 0,
    });
    for (const omitted of [first.id, third.id]) {
      expect(subsetPlaces.find((place) => place.id === omitted)).toMatchObject({
        assignedDayId: null,
        dayPosition: null,
      });
    }
    const subsetEvents = await database.selectFrom("change_events").select("id")
      .where("trip_id", "=", trip.id)
      .where("event_type", "=", "trip_day.places_ordered")
      .execute();
    const replayedSubset = await saveDay(
      owner.cookie,
      trip.id,
      dayId,
      "arrangement",
      arrangementKey,
      subsetVersion,
      [second.id],
    );
    expect(replayedSubset.status).toBe(200);
    expect(await replayedSubset.json()).toEqual(subsetBody);
    expect(await database.selectFrom("change_events").select("id")
      .where("trip_id", "=", trip.id)
      .where("event_type", "=", "trip_day.places_ordered")
      .execute()).toEqual(subsetEvents);

    const emptyVersion = parseDayRouteResponse(
      await (await dayRoute(owner.cookie, trip.id, dayId, "current")).json(),
    ).route.version;
    const emptied = await saveDay(
      owner.cookie,
      trip.id,
      dayId,
      "arrangement",
      "route-replay-empty",
      emptyVersion,
      [],
    );
    expect(emptied.status).toBe(200);
    expect(parseTripPlaceListResponse(await emptied.json()).tripPlaces
      .every((place) => place.assignedDayId === null && place.dayPosition === null)).toBe(true);
  });

  it("keeps every retired planning mutation endpoint at 404 without recording a write", async () => {
    const owner = await login("removed-planning-routes@example.test");
    const trip = await createTrip(owner.cookie, "Removed planning routes");
    const dayId = trip.days[0]!.id;
    const before = {
      events: await database.selectFrom("change_events").select("id").where("trip_id", "=", trip.id).execute(),
      items: await database.selectFrom("itinerary_items").select("id").where("trip_id", "=", trip.id).execute(),
      mutations: await database.selectFrom("mutation_requests")
        .select(["actor_id", "operation", "idempotency_key"])
        .where("actor_id", "=", owner.user.id).execute(),
      places: await database.selectFrom("places").select("id").where("trip_id", "=", trip.id).execute(),
    };
    const retired = [
      ["POST", `/api/trips/${trip.id}/places`],
      ["POST", `/api/trips/${trip.id}/items`],
      ["POST", `/api/trips/${trip.id}/days/${dayId}/timetable`],
      ["PUT", `/api/trips/${trip.id}/days/${dayId}/window`],
      ["PUT", `/api/trips/${trip.id}/day-defaults`],
      ["POST", `/api/trips/${trip.id}/trip-plan`],
      ["POST", "/api/session/rapidapi-keys"],
    ] as const;
    for (const [method, path] of retired) {
      const response = await app.request(path, {
        method,
        headers: {
          cookie: owner.cookie,
          "content-type": "application/json",
          "idempotency-key": `removed-${path}`,
          origin: "https://app.example.test",
        },
        body: json({}),
      });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
    expect({
      events: await database.selectFrom("change_events").select("id").where("trip_id", "=", trip.id).execute(),
      items: await database.selectFrom("itinerary_items").select("id").where("trip_id", "=", trip.id).execute(),
      mutations: await database.selectFrom("mutation_requests")
        .select(["actor_id", "operation", "idempotency_key"])
        .where("actor_id", "=", owner.user.id).execute(),
      places: await database.selectFrom("places").select("id").where("trip_id", "=", trip.id).execute(),
    }).toEqual(before);
  });
});
