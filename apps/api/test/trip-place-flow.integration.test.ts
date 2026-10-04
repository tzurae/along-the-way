import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import { Pool } from "pg";
import type { Hono } from "hono";
import {
  parseProviderCandidatesResponse,
  parseTripPlaceListResponse,
  parseTripPlaceResponse,
  type ProviderPlaceCandidateDto,
} from "@along-the-way/contracts/trip-places";
import {
  parseDayTimetableResponse,
  parseDayWindowResponse,
  parseTripPlanResponse,
} from "@along-the-way/contracts/day-plans";
import type {
  RouteMode,
  RouteObservation,
  RouteObservationProvider,
  RouteObservationQuery,
} from "@along-the-way/contracts/planning-observations";
import { parseTripResponse } from "@along-the-way/contracts/private-trips";
import {
  parseItineraryItemResponse,
  parsePlaceResponse,
  parseTripSkeletonResponse,
} from "@along-the-way/contracts/trip-skeleton";

import { createApp } from "../src/app";
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
import { seedDatabase } from "../src/database/seed";
import type { PlaceHoursLookup, PlaceOpeningHours } from "../src/planning/opening-hours";
import { PostgresDayPlanModule } from "../src/planning/postgres-day-plan-module";
import type { EmailSender } from "../src/private-trips/email-sender";
import { PostgresEmailWorker } from "../src/private-trips/postgres-email-worker";
import { PostgresIdentityAccessModule } from "../src/private-trips/postgres-identity-access-module";
import { PostgresRateLimiter } from "../src/private-trips/postgres-rate-limiter";
import { PostgresReadinessProbe } from "../src/private-trips/postgres-readiness-probe";
import { PostgresTripWorkspaceModule } from "../src/private-trips/postgres-trip-workspace-module";
import { hashToken, TokenIssuer } from "../src/private-trips/token-issuer";
import { PostgresTripSkeletonModule } from "../src/trip-skeleton/postgres-trip-skeleton-module";
import {
  ProviderUnavailableError,
  type PlaceProvider,
} from "../src/trip-places/google-places-provider";
import { PostgresTripPlaceModule } from "../src/trip-places/postgres-trip-place-module";
import { unrelatedDiscoveryModule } from "./discovery-test-support";

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
  readonly kyoto: ProviderPlaceCandidateDto = {
    provider: "google",
    providerPlaceId: "ChIJ-Kyoto-Temple-1234",
    name: "Kiyomizu-dera",
    type: "activity",
    address: "1-294 Kiyomizu, Kyoto",
    latitude: 34.9948561,
    longitude: 135.7850463,
    timeZone: null,
    sourceUrl: "https://www.google.com/maps/place/?query_place_id=ChIJ-Kyoto-Temple-1234",
    attribution: "Google Maps",
    observedAt: "2026-09-28T12:00:00.000Z",
    expiresAt: "2026-10-28T12:00:00.000Z",
  };
  readonly branch: ProviderPlaceCandidateDto = {
    ...this.kyoto,
    providerPlaceId: "ChIJ-Kyoto-Temple-Branch-5678",
    name: "Kiyomizu Cafe",
    type: "restaurant",
    address: "1-295 Kiyomizu, Kyoto",
    sourceUrl: "https://www.google.com/maps/place/?query_place_id=ChIJ-Kyoto-Temple-Branch-5678",
  };

  async search(query: string) {
    if (this.unavailable) throw new ProviderUnavailableError();
    return query.toLocaleLowerCase().includes("cafe")
      ? [this.branch]
      : [this.kyoto, this.branch];
  }

  async getPlace(providerPlaceId: string) {
    if (this.unavailable) throw new ProviderUnavailableError();
    const place = [this.kyoto, this.branch].find(
      (candidate) => candidate.providerPlaceId === providerPlaceId,
    );
    if (!place) throw new ProviderUnavailableError("Place is unavailable");
    return place;
  }
}

/** Answers by unordered place pair; unlisted pairs walk 10 minutes and have no transit. */
class ControlledRouteProvider implements RouteObservationProvider {
  readonly queries: RouteObservationQuery[] = [];
  readonly walking = new Map<string, number | null>();
  readonly transit = new Map<string, number>();

  static pair(left: string, right: string) {
    return [left, right].sort().join("|");
  }

  async observe(query: RouteObservationQuery): Promise<RouteObservation[]> {
    this.queries.push(query);
    const pair = ControlledRouteProvider.pair(query.origin.placeId, query.destination.placeId);
    const walking = this.walking.has(pair) ? this.walking.get(pair)! : 10;
    return [
      this.observation(query, "walking", walking),
      this.observation(query, "transit", this.transit.get(pair) ?? null),
    ];
  }

  private observation(query: RouteObservationQuery, mode: RouteMode, minutes: number | null): RouteObservation {
    const source = {
      originPlaceId: query.origin.placeId,
      destinationPlaceId: query.destination.placeId,
      requestedDepartureTime: query.departureTime,
      mode,
      provider: "controlled",
      attribution: "Controlled routes",
      observedAt: "2026-09-28T12:00:00.000Z",
      expiresAt: "2026-09-28T12:05:00.000Z",
    };
    return minutes === null
      ? { ...source, status: "unavailable", reason: "no_route", durationMinutes: null, distanceMeters: null, walkingLegMinutes: null }
      : {
          ...source,
          status: "available",
          durationMinutes: minutes,
          distanceMeters: minutes * 80,
          walkingLegMinutes: null,
          manualChecks: mode === "transit" ? ["transit_duration_estimated"] : [],
          warnings: [],
        };
  }
}

/** Answers opening hours by Google place ID; unlisted places fail like an unavailable provider. */
class ControlledHoursLookup implements PlaceHoursLookup {
  readonly calls: string[] = [];
  readonly hours = new Map<string, PlaceOpeningHours>();

  async openingHours(providerPlaceId: string) {
    this.calls.push(providerPlaceId);
    const hours = this.hours.get(providerPlaceId);
    if (!hours) throw new ProviderUnavailableError();
    return hours;
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
  let routes: ControlledRouteProvider;
  let hours: ControlledHoursLookup;
  const now = () => new Date("2026-09-28T12:00:00.000Z");

  beforeAll(async () => {
    database = createDatabase(databaseUrl);
    await runMigrations(database);
  });

  beforeEach(async () => {
    await sql`
      truncate table
        trip_place_duplicate_suggestions,
        trip_place_day_assignments,
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
    provider = new ControlledProvider();
    routes = new ControlledRouteProvider();
    hours = new ControlledHoursLookup();
    let sessionNumber = 0;
    const tokenIssuer = new TokenIssuer("trip-place-integration-secret-at-least-32-bytes");
    const identityAccess = new PostgresIdentityAccessModule({
      database,
      tokenIssuer,
      now,
      randomSessionToken: () => `trip-place-session-${++sessionNumber}`,
    });
    worker = new PostgresEmailWorker({
      database,
      emailSender: email,
      siteAddress: "https://app.example.test",
      tokenIssuer,
      now,
    });
    const tripPlaces = new PostgresTripPlaceModule({
      database,
      provider,
      now,
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
    const tripSkeleton = new PostgresTripSkeletonModule({ database, now });
    app = createApp({
      dayPlans: new PostgresDayPlanModule({
        database,
        tripSkeleton,
        tripPlaces,
        routeProviders: [routes],
        placeHours: hours,
        now,
      }),
      discovery: unrelatedDiscoveryModule,
      identityAccess,
      rateLimiter: new PostgresRateLimiter(
        database,
        "trip-place-rate-secret-at-least-32-bytes",
        now,
      ),
      readiness: new PostgresReadinessProbe(database, now),
      siteAddress: "https://app.example.test",
      tripPlaces,
      tripSkeleton,
      tripWorkspace: new PostgresTripWorkspaceModule({ database, now }),
    });
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
      body: json({ token }),
    });
    expect(consumed.status).toBe(200);
    const user = await database.selectFrom("users").select(["id", "email"])
      .where("email", "=", address).executeTakeFirstOrThrow();
    return { cookie: sessionCookie(consumed), user };
  }

  async function createTrip(cookie: string, name: string) {
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
        countryCodes: ["JP"],
      }),
    });
    expect(response.status).toBe(201);
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
        method: "search",
        providerPlaceId: provider.kyoto.providerPlaceId,
        sourceUrl: provider.kyoto.sourceUrl,
        originalNote: note,
      }),
    });
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

  async function list(cookie: string, tripId: string) {
    const response = await app.request(`/api/trips/${tripId}/trip-places`, {
      headers: { cookie },
    });
    expect(response.status).toBe(200);
    return parseTripPlaceListResponse(await response.json()).tripPlaces;
  }

  async function setPreference(
    cookie: string,
    tripId: string,
    tripPlaceId: string,
    level: string,
    expectedVersion: number | null,
    key: string,
  ) {
    return app.request(
      `/api/trips/${tripId}/trip-places/${tripPlaceId}/preference`,
      {
        method: "PUT",
        headers: {
          cookie,
          "content-type": "application/json",
          "idempotency-key": key,
          origin: "https://app.example.test",
        },
        body: json({ level, expectedVersion }),
      },
    );
  }

  it("deduplicates provider identity while preserving every member contribution and preference", async () => {
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


    provider.kyoto.address = "Updated Kiyomizu address";
    provider.kyoto.latitude = 34.995;
    provider.kyoto.longitude = 135.786;
    provider.kyoto.observedAt = "2026-09-29T12:00:00.000Z";
    provider.kyoto.expiresAt = "2026-10-29T12:00:00.000Z";
    const secondResponse = await addProvider(
      second.cookie,
      trip.id,
      "second-add-kiyomizu",
      "Need an easy taxi drop-off",
    );
    expect(secondResponse.status).toBe(201);
    const afterBoth = parseTripPlaceResponse(await secondResponse.json()).tripPlace;
    expect(afterBoth.id).toBe(first.id);
    expect(afterBoth.contributions.map((entry) => entry.originalNote)).toEqual([
      "Sunset if possible",
      "Need an easy taxi drop-off",
    ]);
    expect(afterBoth).toMatchObject({
      address: "Updated Kiyomizu address",
      latitude: 34.995,
      longitude: 135.786,
      providerObservedAt: "2026-09-29T12:00:00.000Z",
    });
    expect(await list(owner.cookie, trip.id)).toHaveLength(1);

    for (const [actor, level, key] of [
      [owner, "must", "owner-must"],
      [second, "dislike", "second-dislike"],
      [third, "want", "third-want"],
      [fourth, "optional", "fourth-optional"],
    ] as const) {
      const response = await setPreference(
        actor.cookie,
        trip.id,
        first.id,
        level,
        null,
        key,
      );
      expect(response.status).toBe(200);
    }
    const read = (await list(owner.cookie, trip.id))[0]!;
    expect(read.preferences).toHaveLength(4);
    expect(read.preferences.map((entry) => entry.level)).toEqual([
      "must",
      "dislike",
      "want",
      "optional",
    ]);
    expect(read.preferenceConflict).toBe(true);
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
      candidates: [{ providerPlaceId: provider.kyoto.providerPlaceId }],
      attribution: "Google Maps",
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
    expect((await list(owner.cookie, firstTrip.id))[0]?.contributions
      .find((entry) => entry.originalNote === "First trip note")).toBeDefined();
    expect((await list(owner.cookie, secondTrip.id))[0]?.contributions[0]?.originalNote).toBe("Second trip note");
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
    expect(mergedPlace.contributions).toHaveLength(2);
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

  it("drafts a day around fixed items, opening hours and the night's lodging without changing the itinerary", async () => {
    const owner = await login("owner@example.test");
    const trip = await createTrip(owner.cookie, "Day plan trip");
    const otherTrip = await createTrip(owner.cookie, "Other day plan trip");
    const send = (method: string, path: string, key: string | null, payload?: unknown, cookie = owner.cookie) =>
      app.request(path, {
        method,
        headers: {
          cookie,
          "content-type": "application/json",
          origin: "https://app.example.test",
          ...(key ? { "idempotency-key": key } : {}),
        },
        body: payload === undefined ? undefined : json(payload),
      });
    const skeleton = async () => {
      const response = await app.request(`/api/trips/${trip.id}/skeleton`, { headers: { cookie: owner.cookie } });
      return parseTripSkeletonResponse(await response.json()).skeleton;
    };
    const skeletonPlace = async (key: string, name: string, type: string, latitude: number, longitude: number) => {
      const response = await send("POST", `/api/trips/${trip.id}/places`, key, {
        name,
        type,
        address: null,
        latitude,
        longitude,
        timeZone: "Asia/Tokyo",
        sourceUrl: null,
        notes: null,
        expectedTripVersion: (await skeleton()).tripVersion,
      });
      expect(response.status).toBe(201);
      return parsePlaceResponse(await response.json()).place;
    };
    const hotel = await skeletonPlace("day-hotel", "Kyoto Station Hotel", "lodging", 34.9858, 135.7588);
    const gion = await skeletonPlace("day-gion", "Gion Kappo", "restaurant", 35.0037, 135.7788);
    const at = (placeId: string, role: "start" | "end", localDateTime: string) => ({
      role,
      countryStopId: trip.countryStops[0]!.id,
      placeId,
      localDateTime,
      timeZone: "Asia/Tokyo",
    });
    const item = async (key: string, payload: Record<string, unknown>) => {
      const response = await send("POST", `/api/trips/${trip.id}/items`, key, {
        expectedTripVersion: (await skeleton()).tripVersion,
        participantMemberIds: null,
        notes: null,
        sourceUrl: null,
        money: null,
        constraints: [],
        ...payload,
      });
      expect(response.status).toBe(201);
      return parseItineraryItemResponse(await response.json()).item;
    };
    // The hotel covers the night of day two; lunch must be reached 15 minutes early.
    await item("day-stay", {
      type: "lodging",
      title: "Kyoto stay",
      endpoints: [at(hotel.id, "start", "2026-10-21T15:00"), at(hotel.id, "end", "2026-10-23T10:00")],
      details: { bookedBy: null, confirmationCode: null },
    });
    const lunch = await item("day-lunch", {
      type: "reservation",
      title: "Lunch at Gion Kappo",
      endpoints: [at(gion.id, "start", "2026-10-22T12:00")],
      details: { durationMinutes: 60, bookedBy: null, confirmationStatus: null },
      constraints: [{ type: "minimum_buffer", status: "confirmed", minimumBufferMinutes: 15 }],
    });

    const searched = async (key: string, candidate: ProviderPlaceCandidateDto) => {
      const response = await send("POST", `/api/trips/${trip.id}/trip-places`, key, {
        method: "search",
        providerPlaceId: candidate.providerPlaceId,
        sourceUrl: candidate.sourceUrl,
        originalNote: null,
      });
      expect(response.status).toBe(201);
      return parseTripPlaceResponse(await response.json()).tripPlace;
    };
    const manual = async (key: string, name: string, latitude: number | null, longitude: number | null) => {
      const response = await send("POST", `/api/trips/${trip.id}/trip-places`, key, {
        method: "manual",
        name,
        type: "activity",
        address: null,
        latitude,
        longitude,
        timeZone: latitude === null ? null : "Asia/Tokyo",
        sourceUrl: null,
        originalNote: null,
      });
      expect(response.status).toBe(201);
      return parseTripPlaceResponse(await response.json()).tripPlace;
    };
    const kiyomizu = await searched("day-kiyomizu", provider.kyoto);
    const cafe = await searched("day-cafe", provider.branch);
    const unsizedTofukuji = await manual("day-tofukuji", "Tofuku-ji", 34.9767, 135.7738);
    const fushimi = await manual("day-fushimi", "Fushimi Inari", 34.9671, 135.7727);
    const hidden = await manual("day-hidden", "Hidden cafe", null, null);
    const arashiyama = await manual("day-arashiyama", "Arashiyama", 35.0094, 135.6668);
    const sized = await send(
      "PATCH",
      `/api/trips/${trip.id}/trip-places/${unsizedTofukuji.id}/planning`,
      "day-tofukuji-stay",
      { expectedVersion: unsizedTofukuji.version, durationMinutes: 45, budgetAmountMinor: null, budgetCurrency: null, notes: null },
    );
    expect(sized.status).toBe(200);
    const tofukuji = parseTripPlaceResponse(await sized.json()).tripPlace;
    const dayTwo = trip.days[1]!.id;
    const assign = (key: string, entries: Array<{ id: string; version: number; day: string | null }>) =>
      send("PUT", `/api/trips/${trip.id}/trip-place-day-assignments`, key, {
        assignments: entries.map((entry) => ({
          tripPlaceId: entry.id,
          tripDayId: entry.day,
          expectedVersion: entry.version,
        })),
      });
    expect((await assign("day-assign", [
      ...[kiyomizu, cafe, tofukuji, fushimi, hidden].map((entry) => ({ ...entry, day: dayTwo })),
      { ...arashiyama, day: trip.days[2]!.id },
    ])).status).toBe(200);
    const orderPath = `/api/trips/${trip.id}/days/${dayTwo}/place-order`;
    const currentOrder = [kiyomizu.id, cafe.id, tofukuji.id, fushimi.id];
    expect((await send("PUT", orderPath, "day-order", { orderedTripPlaceIds: currentOrder })).status).toBe(200);

    // Hotel ↔ Kiyomizu takes the train; Fushimi has no known route to anywhere; others walk 10 minutes.
    routes.walking.set(ControlledRouteProvider.pair(hotel.id, kiyomizu.id), 40);
    routes.transit.set(ControlledRouteProvider.pair(hotel.id, kiyomizu.id), 18);
    for (const other of [hotel.id, gion.id, kiyomizu.id, cafe.id, tofukuji.id]) {
      routes.walking.set(ControlledRouteProvider.pair(fushimi.id, other), null);
    }
    const daily = (open: number, close: number) => Array.from({ length: 7 }, (_, day) => ({
      open: { day, hour: Math.floor(open / 60), minute: open % 60, date: null },
      close: { day, hour: Math.floor(close / 60), minute: close % 60, date: null },
    }));
    hours.hours.set(provider.kyoto.providerPlaceId, {
      businessStatus: "operational",
      regular: daily(9 * 60 + 30, 17 * 60),
      current: null,
    });
    // 2026-10-22 is a Thursday; the cafe opens only on Mondays.
    hours.hours.set(provider.branch.providerPlaceId, {
      businessStatus: "operational",
      regular: daily(11 * 60, 20 * 60).filter((period) => period.open.day === 1),
      current: null,
    });

    const timetablePath = `/api/trips/${trip.id}/days/${dayTwo}/timetable`;
    const draft = async (order: "current" | "suggested", cookie = owner.cookie) => {
      const response = await send("POST", timetablePath, null, { order }, cookie);
      expect(response.status).toBe(200);
      return parseDayTimetableResponse(await response.json()).timetable;
    };
    expect((await send("POST", `/api/trips/${trip.id}/days/${otherTrip.days[1]!.id}/timetable`, null, {
      order: "current",
    })).status).toBe(404);
    expect((await send("POST", timetablePath, null, { order: "fastest" })).status).toBe(400);
    const before = await skeleton();

    const first = await draft("current");
    expect(first.window).toEqual({ startMinute: 9 * 60, endMinute: 19 * 60 });
    expect(first.lodging).toEqual({ placeId: hotel.id, name: "Kyoto Station Hotel" });
    expect(first.orderedTripPlaceIds).toEqual(currentOrder);
    expect(first.rows).toEqual([
      { kind: "start", name: "Kyoto Station Hotel", departMinute: 540 },
      // Arrives 09:18 by train and waits for the 09:30 opening; the stay is the activity default.
      {
        kind: "visit",
        tripPlaceId: kiyomizu.id,
        name: "Kiyomizu-dera",
        travel: expect.objectContaining({ mode: "transit", durationMinutes: 18, walkingMinutes: 40 }),
        arriveMinute: 558,
        waitMinutes: 12,
        startMinute: 570,
        endMinute: 660,
        stayMinutes: 90,
        stayEstimated: true,
        hours: "listed",
      },
      {
        kind: "fixed",
        itemId: lunch.id,
        title: "Lunch at Gion Kappo",
        itemType: "reservation",
        travel: expect.objectContaining({ fromName: "Kiyomizu-dera", toName: "Gion Kappo", durationMinutes: 10 }),
        startMinute: 720,
        endMinute: 780,
        startsBeforeDay: false,
        endsAfterDay: false,
        bufferMinutes: 15,
      },
      // Tofuku-ji would end at 11:55, past the 11:45 lunch buffer, so it moves after lunch.
      {
        kind: "visit",
        tripPlaceId: tofukuji.id,
        name: "Tofuku-ji",
        travel: expect.objectContaining({ fromName: "Gion Kappo", durationMinutes: 10 }),
        arriveMinute: 790,
        waitMinutes: 0,
        startMinute: 790,
        endMinute: 835,
        stayMinutes: 45,
        stayEstimated: false,
        hours: "unknown",
      },
      {
        kind: "return",
        name: "Kyoto Station Hotel",
        travel: expect.objectContaining({ fromName: "Tofuku-ji", durationMinutes: 10 }),
        arriveMinute: 845,
      },
    ]);
    // An unknown route is never treated as zero minutes: Fushimi stays out of the day.
    expect(first.unscheduled).toEqual([
      { tripPlaceId: cafe.id, name: "Kiyomizu Cafe", reason: "closed_that_day" },
      { tripPlaceId: fushimi.id, name: "Fushimi Inari", reason: "travel_unknown" },
      { tripPlaceId: hidden.id, name: "Hidden cafe", reason: "no_location" },
    ]);
    expect(first.load).toEqual({ busyMinutes: 90 + 18 + 60 + 10 + 45 + 10 + 10, windowMinutes: 600, level: "relaxed" });
    // One opening-hours lookup per Google place; every route as if leaving at the day's start.
    expect([...hours.calls].sort()).toEqual([provider.branch.providerPlaceId, provider.kyoto.providerPlaceId].sort());
    expect(new Set(routes.queries.map((query) => query.departureTime))).toEqual(new Set(["2026-10-22T09:00:00+09:00"]));

    expect(await draft("current")).toEqual(first);
    expect(await skeleton()).toMatchObject({ tripVersion: before.tripVersion, items: before.items });

    // Another member shortens the day; everyone's next draft uses the saved window.
    const second = await login("second@example.test");
    await addMember(trip.id, second.user.id);
    const windowPath = `/api/trips/${trip.id}/days/${dayTwo}/window`;
    expect((await send("PUT", windowPath, "day-window-empty", { startMinute: 600, endMinute: 600 })).status).toBe(400);
    const changed = await send("PUT", windowPath, "day-window", { startMinute: 540, endMinute: 810 }, second.cookie);
    expect(changed.status).toBe(200);
    expect(parseDayWindowResponse(await changed.json()).window).toEqual({ startMinute: 540, endMinute: 810 });
    const shortened = await draft("current");
    expect(shortened.window).toEqual({ startMinute: 540, endMinute: 810 });
    expect(shortened.rows.map((row) => row.kind)).toEqual(["start", "visit", "fixed"]);
    expect(shortened.unscheduled).toContainEqual({ tripPlaceId: tofukuji.id, name: "Tofuku-ji", reason: "not_enough_time" });
    expect((await draft("current", second.cookie)).window).toEqual({ startMinute: 540, endMinute: 810 });

    // The suggested order is drafted in that order and, once used, becomes the day's order.
    const suggested = await draft("suggested");
    expect(suggested.order).toBe("suggested");
    expect([...suggested.orderedTripPlaceIds].sort()).toEqual([...currentOrder].sort());
    const visited = suggested.rows.flatMap((row) => row.kind === "visit" ? [row.tripPlaceId] : []);
    expect(visited).toEqual(suggested.orderedTripPlaceIds.filter((id) => visited.includes(id)));
    const applied = await send("PUT", orderPath, "day-order-suggested", {
      orderedTripPlaceIds: suggested.orderedTripPlaceIds,
    });
    expect(applied.status).toBe(200);
    expect((await draft("current")).orderedTripPlaceIds).toEqual(suggested.orderedTripPlaceIds);
    const positions = async () => new Map(
      (await list(owner.cookie, trip.id)).map((entry) => [entry.id, entry.dayPosition]),
    );
    const afterApply = await positions();
    suggested.orderedTripPlaceIds.forEach((id, index) => expect(afterApply.get(id)).toBe(index));
    expect(afterApply.get(hidden.id)).toBeNull();

    // A retried request returns the first answer and does not apply a second order.
    const replay = await send("PUT", orderPath, "day-order-suggested", {
      orderedTripPlaceIds: [...suggested.orderedTripPlaceIds].reverse(),
    });
    expect(replay.status).toBe(200);
    expect(await positions()).toEqual(afterApply);
    // An order naming a place planned for another day is stale and changes nothing.
    const stale = await send("PUT", orderPath, "day-order-stale", {
      orderedTripPlaceIds: [arashiyama.id, ...suggested.orderedTripPlaceIds],
    });
    expect(stale.status).toBe(409);
    expect(await positions()).toEqual(afterApply);

    // Moving a place off the day drops its position, so it never sorts ahead on its next day.
    const current = (await list(owner.cookie, trip.id)).find((entry) => entry.id === tofukuji.id)!;
    expect((await assign("day-unassign", [{ ...current, day: null }])).status).toBe(200);
    const moved = (await list(owner.cookie, trip.id)).find((entry) => entry.id === tofukuji.id)!;
    expect((await assign("day-reassign", [{ ...moved, day: trip.days[2]!.id }])).status).toBe(200);
    expect((await positions()).get(tofukuji.id)).toBeNull();
  });

  it("adds unplanned wishlist places to nearby days around kept places and a friend's dinner", async () => {
    const owner = await login("owner@example.test");
    const trip = await createTrip(owner.cookie, "Trip plan trip");
    const send = (method: string, path: string, key: string | null, payload?: unknown) =>
      app.request(path, {
        method,
        headers: {
          cookie: owner.cookie,
          "content-type": "application/json",
          origin: "https://app.example.test",
          ...(key ? { "idempotency-key": key } : {}),
        },
        body: payload === undefined ? undefined : json(payload),
      });
    const skeleton = async () => {
      const response = await app.request(`/api/trips/${trip.id}/skeleton`, { headers: { cookie: owner.cookie } });
      return parseTripSkeletonResponse(await response.json()).skeleton;
    };
    const skeletonPlace = async (key: string, name: string, type: string, latitude: number | null, longitude: number | null) => {
      const response = await send("POST", `/api/trips/${trip.id}/places`, key, {
        name,
        type,
        address: null,
        latitude,
        longitude,
        timeZone: "Asia/Tokyo",
        sourceUrl: null,
        notes: null,
        expectedTripVersion: (await skeleton()).tripVersion,
      });
      expect(response.status).toBe(201);
      return parsePlaceResponse(await response.json()).place;
    };
    const at = (placeId: string, role: "start" | "end", localDateTime: string) => ({
      role,
      countryStopId: trip.countryStops[0]!.id,
      placeId,
      localDateTime,
      timeZone: "Asia/Tokyo",
    });
    const item = async (key: string, payload: Record<string, unknown>) => {
      const response = await send("POST", `/api/trips/${trip.id}/items`, key, {
        expectedTripVersion: (await skeleton()).tripVersion,
        participantMemberIds: null,
        notes: null,
        sourceUrl: null,
        money: null,
        constraints: [],
        ...payload,
      });
      expect(response.status).toBe(201);
      return parseItineraryItemResponse(await response.json()).item;
    };
    // The hotel covers the nights of the 21st and 22nd; on the 22nd a friend picks a restaurant
    // that has no map location yet.
    const hotel = await skeletonPlace("plan-hotel", "Kyoto Station Hotel", "lodging", 34.9858, 135.7588);
    const friendsPick = await skeletonPlace("plan-friend", "Friend's pick", "restaurant", null, null);
    await item("plan-stay", {
      type: "lodging",
      title: "Kyoto stay",
      endpoints: [at(hotel.id, "start", "2026-10-21T15:00"), at(hotel.id, "end", "2026-10-23T10:00")],
      details: { bookedBy: null, confirmationCode: null },
    });
    const dinner = await item("plan-dinner", {
      type: "meal",
      title: "Dinner with Ken",
      endpoints: [at(friendsPick.id, "start", "2026-10-22T18:00")],
      details: { durationMinutes: 120, bookedBy: null, confirmationStatus: null },
    });

    const manual = async (key: string, name: string, latitude: number | null, longitude: number | null) => {
      const response = await send("POST", `/api/trips/${trip.id}/trip-places`, key, {
        method: "manual",
        name,
        type: "activity",
        address: null,
        latitude,
        longitude,
        timeZone: latitude === null ? null : "Asia/Tokyo",
        sourceUrl: null,
        originalNote: null,
      });
      expect(response.status).toBe(201);
      return parseTripPlaceResponse(await response.json()).tripPlace;
    };
    const tofukuji = await manual("plan-tofukuji", "Tofuku-ji", 34.976, 135.7738);
    const kiyomizuResponse = await send("POST", `/api/trips/${trip.id}/trip-places`, "plan-kiyomizu", {
      method: "search",
      providerPlaceId: provider.kyoto.providerPlaceId,
      sourceUrl: provider.kyoto.sourceUrl,
      originalNote: null,
    });
    expect(kiyomizuResponse.status).toBe(201);
    const kiyomizu = parseTripPlaceResponse(await kiyomizuResponse.json()).tripPlace;
    const komyoin = await manual("plan-komyoin", "Komyo-in", 34.9746, 135.7727);
    const ine = await manual("plan-ine", "Ine Funaya", 35.6757, 135.2875);
    const hidden = await manual("plan-hidden", "Hidden cafe", null, null);
    // Tofuku-ji was put on the 23rd by hand and must stay there, first.
    const dayOf = (date: string) => trip.days.find((day) => day.date === date)!.id;
    expect((await send("PUT", `/api/trips/${trip.id}/trip-place-day-assignments`, "plan-assign", {
      assignments: [{ tripPlaceId: tofukuji.id, tripDayId: dayOf("2026-10-23"), expectedVersion: tofukuji.version }],
    })).status).toBe(200);
    // Kiyomizu-dera is closed on Wednesdays (the 21st) and Fridays (the 23rd).
    hours.hours.set(provider.kyoto.providerPlaceId, {
      businessStatus: "operational",
      regular: [0, 1, 2, 4, 6].map((day) => ({
        open: { day, hour: 9, minute: 0, date: null },
        close: { day, hour: 17, minute: 0, date: null },
      })),
      current: null,
    });

    const draft = async () => {
      const response = await send("POST", `/api/trips/${trip.id}/trip-plan`, null);
      expect(response.status).toBe(200);
      return parseTripPlanResponse(await response.json()).plan;
    };
    const before = await skeleton();
    const plan = await draft();
    const byDate = new Map(plan.days.map((day) => [day.timetable.date, day]));

    expect([...byDate.keys()]).toEqual(["2026-10-22", "2026-10-23", "2026-10-24"]);
    // Kiyomizu goes to the nearest open day; the dinner keeps its time, reached in an estimated 30 minutes.
    expect(byDate.get("2026-10-22")).toMatchObject({
      addedTripPlaceIds: [kiyomizu.id],
      orderedTripPlaceIds: [kiyomizu.id],
    });
    expect(byDate.get("2026-10-22")!.timetable.rows).toEqual([
      { kind: "start", name: "Kyoto Station Hotel", departMinute: 540 },
      expect.objectContaining({ kind: "visit", tripPlaceId: kiyomizu.id, startMinute: 550, endMinute: 640 }),
      expect.objectContaining({
        kind: "fixed",
        itemId: dinner.id,
        startMinute: 18 * 60,
        endMinute: 20 * 60,
        travel: expect.objectContaining({ fromName: "Kiyomizu-dera", durationMinutes: 30, estimated: true, mode: null }),
      }),
    ]);
    // Komyo-in joins Tofuku-ji, which stays first; Ine, 90 km away, gets the first day without places it fits.
    expect(byDate.get("2026-10-23")).toMatchObject({
      addedTripPlaceIds: [komyoin.id],
      orderedTripPlaceIds: [tofukuji.id, komyoin.id],
    });
    expect(byDate.get("2026-10-24")).toMatchObject({ addedTripPlaceIds: [ine.id] });
    expect(plan.unplaced).toEqual([{ tripPlaceId: hidden.id, name: "Hidden cafe", reason: "no_location", date: null }]);
    expect(await draft()).toEqual(plan);
    expect(await skeleton()).toMatchObject({ tripVersion: before.tripVersion, items: before.items });

    const apply = (key: string, chosen: typeof plan) => send("POST", `/api/trips/${trip.id}/trip-plan/apply`, key, {
      basis: chosen.basis,
      days: chosen.days.map((day) => ({ tripDayId: day.timetable.dayId, orderedTripPlaceIds: day.orderedTripPlaceIds })),
    });
    const placement = async () => new Map((await list(owner.cookie, trip.id))
      .map((entry) => [entry.id, [entry.assignedDayId, entry.dayPosition]]));

    // A change after the draft makes the plan stale; nothing is written.
    const beforeChange = await placement();
    const edited = await send("PATCH", `/api/trips/${trip.id}/trip-places/${ine.id}/planning`, "plan-ine-stay", {
      expectedVersion: ine.version,
      durationMinutes: 120,
      budgetAmountMinor: null,
      budgetCurrency: null,
      notes: null,
    });
    expect(edited.status).toBe(200);
    expect((await apply("plan-stale", plan)).status).toBe(409);
    expect(await placement()).toEqual(beforeChange);

    // Moving the dinner changes a day the plan checked, without touching the trip version.
    const beforeMove = await draft();
    const moved = await send("PATCH", `/api/trips/${trip.id}/items/${dinner.id}`, "plan-move-dinner", {
      type: "meal",
      title: "Dinner with Ken",
      participantMemberIds: null,
      notes: null,
      sourceUrl: null,
      money: null,
      endpoints: [at(friendsPick.id, "start", "2026-10-22T10:00")],
      details: { durationMinutes: 120, bookedBy: null, confirmationStatus: null },
      expectedVersion: dinner.version,
    });
    expect(moved.status).toBe(200);
    expect((await skeleton()).tripVersion).toBe(before.tripVersion);
    expect((await apply("plan-stale-dinner", beforeMove)).status).toBe(409);
    expect(await placement()).toEqual(beforeChange);

    const fresh = await draft();
    expect(fresh.basis).not.toBe(beforeMove.basis);
    const used = await apply("plan-use", fresh);
    expect(used.status).toBe(200);
    const afterUse = await placement();
    expect(afterUse.get(tofukuji.id)).toEqual([dayOf("2026-10-23"), 0]);
    expect(afterUse.get(komyoin.id)).toEqual([dayOf("2026-10-23"), 1]);
    expect(afterUse.get(kiyomizu.id)).toEqual([dayOf("2026-10-22"), 0]);
    expect(afterUse.get(ine.id)).toEqual([dayOf("2026-10-24"), 0]);
    expect(afterUse.get(hidden.id)).toEqual([null, null]);
    expect((await skeleton()).tripVersion).toBe(before.tripVersion);
    // A retry with the same key answers again without writing twice.
    expect((await apply("plan-use", fresh)).status).toBe(200);
    expect(await placement()).toEqual(afterUse);
    // Nothing is left to add except the place without a location.
    expect(await draft()).toMatchObject({ days: [], unplaced: [{ tripPlaceId: hidden.id, reason: "no_location" }] });
  });

  it("rejects merging an unscheduled day assignment into a scheduled place", async () => {
    const owner = await login("owner@example.test");
    const trip = await createTrip(owner.cookie, "Scheduled merge conflict trip");
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
    const skeletonResponse = await app.request(`/api/trips/${trip.id}/skeleton`, {
      headers: { cookie: owner.cookie },
    });
    const skeleton = parseTripSkeletonResponse(await skeletonResponse.json()).skeleton;
    const targetPlace = skeleton.places.find((place) => place.address === "Timed target")!;
    const timedItem = await app.request(`/api/trips/${trip.id}/items`, {
      method: "POST",
      headers: {
        cookie: owner.cookie,
        "content-type": "application/json",
        "idempotency-key": "schedule-merge-target",
        origin: "https://app.example.test",
      },
      body: json({
        expectedTripVersion: skeleton.tripVersion,
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
        details: {
          durationMinutes: 60,
          bookedBy: null,
          confirmationStatus: "unknown",
        },
        constraints: [],
      }),
    });
    expect(timedItem.status).toBe(201);
    const currentTarget = (await list(owner.cookie, trip.id))
      .find((place) => place.id === target.id)!;
    expect(currentTarget.scheduled).toBe(true);

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
        body: json({
          targetTripPlaceId: currentTarget.id,
          expectedSourceVersion: assignedSource.version,
          expectedTargetVersion: currentTarget.version,
        }),
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

  it("serializes preference events with merge before locking a candidate", async () => {
    const owner = await login("owner@example.test");
    const trip = await createTrip(owner.cookie, "Concurrent preference trip");
    const firstResponse = await addManual(
      owner.cookie,
      trip.id,
      "preference-first",
      "Preference Cafe",
      "Preference north",
    );
    const secondResponse = await addManual(
      owner.cookie,
      trip.id,
      "preference-second",
      "Preference Cafe",
      "Preference south",
    );
    const first = parseTripPlaceResponse(await firstResponse.json()).tripPlace;
    const second = parseTripPlaceResponse(await secondResponse.json()).tripPlace;
    const current = await list(owner.cookie, trip.id);
    const source = current.find((place) => place.id === first.id)!;
    const target = current.find((place) => place.id === second.id)!;

    await sql`
      create or replace function issue22_block_preference_event()
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
      create trigger issue22_block_preference_event
      before insert on change_events
      for each row execute function issue22_block_preference_event()
    `.execute(database);

    const gatePool = new Pool({ connectionString: databaseUrl });
    const gate = await gatePool.connect();
    let gateOpen = false;

    try {
      await gate.query("begin");
      await gate.query("select pg_advisory_xact_lock(220023)");
      const preferencePromise = setPreference(
        owner.cookie,
        trip.id,
        target.id,
        "must",
        null,
        "concurrent-preference",
      );
      await waitForDatabaseLock(gatePool, "advisory");
      const mergePromise = app.request(
        `/api/trips/${trip.id}/trip-places/${source.id}/merge`,
        {
          method: "POST",
          headers: {
            cookie: owner.cookie,
            "content-type": "application/json",
            "idempotency-key": "preference-concurrent-merge",
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
      const [preference, merge] = await Promise.all([
        preferencePromise,
        mergePromise,
      ]);
      expect(preference.status).toBe(200);
      expect(merge.status).toBe(409);
    } finally {
      if (!gateOpen) await gate.query("rollback");
      gate.release();
      await gatePool.end();
      await sql`
        drop trigger if exists issue22_block_preference_event
        on change_events
      `.execute(database);
      await sql`
        drop function if exists issue22_block_preference_event()
      `.execute(database);
    }
  });

  it("serializes retained Place edits before preference membership checks", async () => {
    const owner = await login("owner@example.test");
    const trip = await createTrip(owner.cookie, "Concurrent membership trip");
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
    ).skeleton.places[0]!;

    await sql`
      create or replace function issue22_block_preference_insert()
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
      create trigger issue22_block_preference_insert
      before insert on member_place_preferences
      for each row execute function issue22_block_preference_insert()
    `.execute(database);

    const gatePool = new Pool({ connectionString: databaseUrl });
    const gate = await gatePool.connect();
    let gateOpen = false;
    try {
      await gate.query("begin");
      await gate.query("select pg_advisory_xact_lock(220024)");
      const preferencePromise = setPreference(
        owner.cookie,
        trip.id,
        place.id,
        "must",
        null,
        "membership-preference",
      );
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
      const [preference, edit] = await Promise.all([
        preferencePromise,
        editPromise,
      ]);
      expect(preference.status).toBe(200);
      expect(edit.status).toBe(200);
    } finally {
      if (!gateOpen) await gate.query("rollback");
      gate.release();
      await gatePool.end();
      await sql`
        drop trigger if exists issue22_block_preference_insert
        on member_place_preferences
      `.execute(database);
      await sql`
        drop function if exists issue22_block_preference_insert()
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
      contributions: [{
        originalNote: "Original rollback note",
        sourceUrl: "https://example.test/original",
      }],
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

  it("rejects retained-release deletion when another member retains the candidate", async () => {
    const owner = await login("owner@example.test");
    const second = await login("second@example.test");
    const trip = await createTrip(owner.cookie, "Protected rollback deletion trip");
    await addMember(trip.id, second.user.id);
    const shared = parseTripPlaceResponse(
      await (await addProvider(owner.cookie, trip.id, "protected-owner", "Owner source")).json(),
    ).tripPlace;
    await addProvider(second.cookie, trip.id, "protected-second", "Second source");
    const sharedLegacy = await database.selectFrom("trip_places")
      .select("legacy_place_id")
      .where("id", "=", shared.id)
      .executeTakeFirstOrThrow();
    await expect(
      database.deleteFrom("places").where("id", "=", sharedLegacy.legacy_place_id).execute(),
    ).rejects.toMatchObject({ code: "23503" });
    expect((await list(owner.cookie, trip.id))[0]?.contributions).toHaveLength(2);

    const manualResponse = await app.request(`/api/trips/${trip.id}/trip-places`, {
      method: "POST",
      headers: {
        cookie: owner.cookie,
        "content-type": "application/json",
        "idempotency-key": "protected-preference-place",
        origin: "https://app.example.test",
      },
      body: json({
        method: "manual",
        name: "Preference-protected place",
        type: "other",
        address: null,
        latitude: null,
        longitude: null,
        timeZone: null,
        sourceUrl: null,
        originalNote: "Owner only contribution",
      }),
    });
    const preferred = parseTripPlaceResponse(await manualResponse.json()).tripPlace;
    expect((await setPreference(
      second.cookie,
      trip.id,
      preferred.id,
      "want",
      null,
      "protect-before-rollback-delete",
    )).status).toBe(200);
    const preferredLegacy = await database.selectFrom("trip_places")
      .select("legacy_place_id")
      .where("id", "=", preferred.id)
      .executeTakeFirstOrThrow();
    await expect(
      database.deleteFrom("places").where("id", "=", preferredLegacy.legacy_place_id).execute(),
    ).rejects.toMatchObject({ code: "23503" });
    expect((await list(owner.cookie, trip.id)).find((place) => place.id === preferred.id))
      .toMatchObject({
        preferences: expect.arrayContaining([
          expect.objectContaining({ memberUserId: second.user.id, level: "want" }),
        ]),
      });
    await expect(
      database.deleteFrom("trips").where("id", "=", trip.id).execute(),
    ).resolves.toBeDefined();
    expect(await database.selectFrom("places").select("id")
      .where("trip_id", "=", trip.id).execute()).toEqual([]);
  });

  it("flags possible duplicates added through the retained skeleton Place surface", async () => {
    const owner = await login("owner@example.test");
    const trip = await createTrip(owner.cookie, "Legacy Place duplicate trip");
    const first = await app.request(`/api/trips/${trip.id}/trip-places`, {
      method: "POST",
      headers: {
        cookie: owner.cookie,
        "content-type": "application/json",
        "idempotency-key": "wishlist-duplicate-first",
        origin: "https://app.example.test",
      },
      body: json({
        method: "manual",
        name: "Shared Cafe",
        type: "restaurant",
        address: "Kyoto north entrance",
        latitude: null,
        longitude: null,
        timeZone: null,
        sourceUrl: null,
        originalNote: "Wishlist path",
      }),
    });
    expect(first.status).toBe(201);

    const second = await app.request(`/api/trips/${trip.id}/places`, {
      method: "POST",
      headers: {
        cookie: owner.cookie,
        "content-type": "application/json",
        "idempotency-key": "skeleton-duplicate-second",
        origin: "https://app.example.test",
      },
      body: json({
        expectedTripVersion: trip.version,
        name: "Shared Cafe",
        type: "restaurant",
        address: "Kyoto south entrance",
        latitude: null,
        longitude: null,
        timeZone: null,
        sourceUrl: null,
        notes: "Skeleton path",
      }),
    });
    expect(second.status).toBe(201);
    const duplicates = await list(owner.cookie, trip.id);
    expect(duplicates).toHaveLength(2);
    expect(duplicates.every((entry) => entry.status === "possible-duplicate")).toBe(true);
    const archivedCandidate = [...duplicates].sort((left, right) => left.id.localeCompare(right.id))[0]!;
    const archived = await app.request(
      `/api/trips/${trip.id}/trip-places/${archivedCandidate.id}/contributions/${archivedCandidate.contributions[0]!.id}/withdraw`,
      {
        method: "POST",
        headers: {
          cookie: owner.cookie,
          "idempotency-key": "archive-lower-duplicate",
          origin: "https://app.example.test",
        },
      },
    );
    expect(archived.status).toBe(200);
    expect(await archived.json()).toEqual({ tripPlace: null });
    const survivor = await list(owner.cookie, trip.id);
    expect(survivor).toHaveLength(1);
    expect(survivor[0]).toMatchObject({
      status: "needs-location",
      duplicateSuggestions: [],
    });
  });


  it("retains a place after its last contribution is withdrawn when an active member has a preference", async () => {
    const owner = await login("owner@example.test");
    const second = await login("second@example.test");
    const trip = await createTrip(owner.cookie, "Preference retention trip");
    await addMember(trip.id, second.user.id);
    const added = await app.request(`/api/trips/${trip.id}/trip-places`, {
      method: "POST",
      headers: {
        cookie: owner.cookie,
        "content-type": "application/json",
        "idempotency-key": "preference-retention-place",
        origin: "https://app.example.test",
      },
      body: json({
        method: "manual",
        name: "Preference-only cafe",
        type: "restaurant",
        address: "Kyoto",
        latitude: null,
        longitude: null,
        timeZone: null,
        sourceUrl: null,
        originalNote: "Owner contribution",
      }),
    });
    const place = parseTripPlaceResponse(await added.json()).tripPlace;
    const preference = await setPreference(
      second.cookie,
      trip.id,
      place.id,
      "want",
      null,
      "preference-before-withdrawal",
    );
    expect(preference.status).toBe(200);

    const withdrawn = await app.request(
      `/api/trips/${trip.id}/trip-places/${place.id}/contributions/${place.contributions[0]!.id}/withdraw`,
      {
        method: "POST",
        headers: {
          cookie: owner.cookie,
          "idempotency-key": "withdraw-last-but-preferred",
          origin: "https://app.example.test",
        },
      },
    );
    expect(withdrawn.status).toBe(200);
    expect(parseTripPlaceResponse(await withdrawn.json()).tripPlace).toMatchObject({
      id: place.id,
      preferences: expect.arrayContaining([
        expect.objectContaining({
          memberUserId: second.user.id,
          level: "want",
        }),
      ]),
    });
    expect(await list(owner.cookie, trip.id)).toHaveLength(1);
  });
  it("keeps the list and manual intake available during provider failure and preserves another member on withdrawal", async () => {
    const owner = await login("owner@example.test");
    const second = await login("second@example.test");
    const trip = await createTrip(owner.cookie, "Provider outage trip");
    await addMember(trip.id, second.user.id);
    const first = parseTripPlaceResponse(
      await (await addProvider(owner.cookie, trip.id, "outage-owner", "Owner note")).json(),
    ).tripPlace;
    const secondAdd = parseTripPlaceResponse(
      await (await addProvider(second.cookie, trip.id, "outage-second", "Second note")).json(),
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

    const ownerContribution = secondAdd.contributions.find((entry) => entry.memberUserId === owner.user.id)!;
    const withdrawn = await app.request(
      `/api/trips/${trip.id}/trip-places/${first.id}/contributions/${ownerContribution.id}/withdraw`,
      {
        method: "POST",
        headers: {
          cookie: owner.cookie,
          "idempotency-key": "withdraw-owner",
          origin: "https://app.example.test",
        },
      },
    );
    expect(withdrawn.status).toBe(200);
    const retained = parseTripPlaceResponse(await withdrawn.json()).tripPlace;
    expect(retained.contributions.filter((entry) => entry.withdrawnAt === null)).toHaveLength(1);
    expect(retained.contributions.find((entry) => entry.memberUserId === second.user.id)?.originalNote).toBe("Second note");

    const onlyContribution = manualPlace.contributions[0]!;
    const archiveRequest = {
      method: "POST",
      headers: {
        cookie: owner.cookie,
        "idempotency-key": "withdraw-and-archive-manual",
        origin: "https://app.example.test",
      },
    };
    const archived = await app.request(
      `/api/trips/${trip.id}/trip-places/${manualPlace.id}/contributions/${onlyContribution.id}/withdraw`,
      archiveRequest,
    );
    expect(archived.status).toBe(200);
    expect(await archived.json()).toEqual({ tripPlace: null });
    const archiveReplay = await app.request(
      `/api/trips/${trip.id}/trip-places/${manualPlace.id}/contributions/${onlyContribution.id}/withdraw`,
      archiveRequest,
    );
    expect(archiveReplay.status).toBe(200);
    expect(await archiveReplay.json()).toEqual({ tripPlace: null });
  });
});
