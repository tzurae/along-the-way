import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql, type Kysely } from "kysely";
import { Pool } from "pg";
import type { Hono } from "hono";
import {
  parseProviderCandidatesResponse,
  parseTripPlaceListResponse,
  parseTripPlaceResponse,
  type ProviderPlaceCandidateDto,
  type TripPlaceDto,
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
import { parseTripHistoryResponse, parseTripChangeNotification, type TripChangeNotification } from "@along-the-way/contracts/private-trips";
import {
  parseItineraryItemResponse,
  parsePlaceResponse,
  parseTripSkeletonResponse,
} from "@along-the-way/contracts/trip-skeleton";

import { createApp } from "../src/app";
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
  let tripPlaces: PostgresTripPlaceModule;
  let collaboration: PostgresCollaborationModule;
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
    tripPlaces = new PostgresTripPlaceModule({
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
    collaboration = new PostgresCollaborationModule(database);
    app = createApp({
      placeDetails: new PostgresPlaceDetailModule({ database, assetRoot: packagedPhotoRoot }),
      collaboration,
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
        flights: tripFlights(),
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

  it("keeps identifiable actor metadata for active readers and removed members' past changes", async () => {
    const owner = await login("label-owner@example.test");
    const member = await login("label-member@example.test");
    await database.updateTable("users").set({ display_name: null }).where("id", "=", member.user.id).execute();
    const trip = await createTrip(owner.cookie, "Identifiable history actors");
    await addMember(trip.id, member.user.id);
    const place = parseTripPlaceResponse(await (await addManual(member.cookie, trip.id, "actor-place", "Member cafe", "Kyoto")).json()).tripPlace;
    const readHistory = async (cookie: string) => {
      const response = await app.request(`/api/trips/${trip.id}/history`, { headers: { cookie } });
      expect(response.status).toBe(200);
      return (await response.json()).events as Array<Record<string, unknown>>;
    };
    const events = await readHistory(owner.cookie);
    const added = events.find((event) => event.targetId === place.id)!;
    expect(added).toMatchObject({ actorId: member.user.id, actorDisplayName: null, actorEmail: member.user.email });
    expect(events.find((event) => event.eventType === "trip.created")).toMatchObject({
      actorDisplayName: "label-owner", actorEmail: owner.user.email,
    });
    for (const [reader, isOwn] of [[member, true], [owner, false]] as const) {
      const stale = await planning(reader.cookie, trip.id, place.id, place.version + 1, `actor-stale-${isOwn}`, "Not saved");
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ error: { latestChange: {
        actorId: member.user.id, actorDisplayName: null, actorEmail: member.user.email, isOwn,
      } } });
    }
    expect((await app.request(`/api/trips/${trip.id}/members/${member.user.id}`, {
      method: "DELETE", headers: { cookie: owner.cookie, origin: "https://app.example.test", "idempotency-key": "remove-history-actor" },
    })).status).toBe(204);
    expect((await readHistory(owner.cookie)).find((event) => event.id === added.id)).toMatchObject({
      actorId: member.user.id, actorDisplayName: null, actorEmail: member.user.email,
    });
    expect((await app.request(`/api/trips/${trip.id}/history`, { headers: { cookie: member.cookie } })).status).toBe(404);
    expect((await planning(member.cookie, trip.id, place.id, place.version + 1, "removed-actor-read", "Denied")).status).toBe(404);
  });

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
    const createdPlace = await app.request(`/api/trips/${trip.id}/places`, {
      method: "POST", headers: headers("target-place"),
      body: json({ name: "Named map target", type: "activity", timeZone: "Asia/Tokyo", expectedTripVersion: (await skeleton()).tripVersion }),
    });
    expect(createdPlace.status).toBe(201);
    const place = parsePlaceResponse(await createdPlace.json()).place;
    const createdItem = await app.request(`/api/trips/${trip.id}/items`, {
      method: "POST", headers: headers("target-item"),
      body: json({
        type: "free-time", title: "Named morning walk", participantMemberIds: null,
        endpoints: [{ role: "start", countryStopId: trip.countryStops[0]!.id, placeId: place.id, localDateTime: "2026-10-22T09:00", timeZone: "Asia/Tokyo" }],
        details: { durationMinutes: 60 }, expectedTripVersion: (await skeleton()).tripVersion,
      }),
    });
    expect(createdItem.status).toBe(201);
    const item = parseItineraryItemResponse(await createdItem.json()).item;
    const day = trip.days[1]!;
    const window = parseDayWindowResponse(await (await app.request(`/api/trips/${trip.id}/days/${day.id}/window`, { headers: { cookie: owner.cookie } })).json()).window;
    expect((await app.request(`/api/trips/${trip.id}/days/${day.id}/window`, {
      method: "PUT", headers: headers("target-day"), body: json({ startMinute: 480, endMinute: 1140, expectedVersion: window.version }),
    })).status).toBe(200);
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
    expect((await removePlace(owner.cookie, trip.id, wishlist, "target-remove-wishlist")).status).toBe(204);
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

  it("refuses a stale TripDay window rather than silently overwriting another member", async () => {
    const owner = await login("day-owner@example.test");
    const editor = await login("day-editor@example.test");
    const trip = await createTrip(owner.cookie, "Day optimistic version");
    await addMember(trip.id, editor.user.id);
    const day = trip.days[0]!;
    const update = (cookie: string, key: string, expectedVersion: number, startMinute: number) =>
      app.request(`/api/trips/${trip.id}/days/${day.id}/window`, {
        method: "PUT", headers: { cookie, origin: "https://app.example.test", "content-type": "application/json", "idempotency-key": key },
        body: json({ expectedVersion, startMinute, endMinute: 1140 }),
      });
    expect((await update(owner.cookie, "day-first", 1, 480)).status).toBe(200);
    const before = await history(owner.cookie, trip.id);
    const stale = await update(editor.cookie, "day-stale", 1, 600);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "conflict", currentVersion: 2, latestChange: { actorId: owner.user.id } } });
    expect(await history(owner.cookie, trip.id)).toEqual(before);
    const current = await app.request(`/api/trips/${trip.id}/days/${day.id}/window`, { headers: { cookie: editor.cookie } });
    expect(parseDayWindowResponse(await current.json()).window).toEqual({ version: 2, startMinute: 480, endMinute: 1140 });
    const saved = await update(editor.cookie, "day-reapplied", 2, 600);
    expect(saved.status).toBe(200);
    expect(parseDayWindowResponse(await saved.json()).window).toEqual({ version: 3, startMinute: 600, endMinute: 1140 });
  });

  it("serializes same-day order edits and invalidates a draft when its assignment changes", async () => {
    const owner = await login("order-owner@example.test");
    const editor = await login("order-editor@example.test");
    const trip = await createTrip(owner.cookie, "Order optimistic version");
    await addMember(trip.id, editor.user.id);
    const a = parseTripPlaceResponse(await (await addManual(owner.cookie, trip.id, "order-a", "A", "A")).json()).tripPlace;
    const b = parseTripPlaceResponse(await (await addManual(owner.cookie, trip.id, "order-b", "B", "B")).json()).tripPlace;
    const dayId = trip.days[1]!.id;
    const send = (cookie: string, path: string, key: string, input: unknown) => app.request(`/api/trips/${trip.id}/${path}`, {
      method: "PUT", headers: { cookie, origin: "https://app.example.test", "content-type": "application/json", "idempotency-key": key }, body: json(input),
    });
    const window = async () => parseDayWindowResponse(await (await app.request(`/api/trips/${trip.id}/days/${dayId}/window`, { headers: { cookie: owner.cookie } })).json()).window;
    expect((await send(owner.cookie, "trip-place-day-assignments", "order-assign", {
      assignments: [a, b].map((place) => ({ tripPlaceId: place.id, tripDayId: dayId, expectedVersion: place.version })),
    })).status).toBe(200);
    const base = await window();
    const attempts = [
      { cookie: owner.cookie, actor: owner.user.id, ids: [a.id, b.id] },
      { cookie: editor.cookie, actor: editor.user.id, ids: [b.id, a.id] },
    ];
    const results = await Promise.all(attempts.map((attempt, index) => send(attempt.cookie, `days/${dayId}/place-order`, `order-race-${index}`, {
      expectedVersion: base.version, orderedTripPlaceIds: attempt.ids,
    })));
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const winner = attempts[results.findIndex((result) => result.status === 200)]!;
    const saved = await window();
    const loser = results.find((result) => result.status === 409)!;
    expect(await loser.json()).toMatchObject({ error: { currentVersion: saved.version, latestChange: { actorId: winner.actor } } });
    const placed = (await list(owner.cookie, trip.id)).filter((place) => place.assignedDayId === dayId).sort((left, right) => left.dayPosition! - right.dayPosition!);
    expect(placed.map((place) => place.id)).toEqual(winner.ids);
    expect((await history(owner.cookie, trip.id)).filter((event) => event.eventType === "trip_day.places_ordered")).toHaveLength(1);
    expect((await send(editor.cookie, "trip-place-day-assignments", "order-unassign", {
      assignments: [{ tripPlaceId: placed[0]!.id, tripDayId: null, expectedVersion: placed[0]!.version }],
    })).status).toBe(200);
    const before = await history(owner.cookie, trip.id);
    const stale = await send(owner.cookie, `days/${dayId}/place-order`, "order-after-unassign", { expectedVersion: saved.version, orderedTripPlaceIds: winner.ids });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { currentVersion: (await window()).version, latestChange: { actorId: editor.user.id, eventId: before[0]!.id } } });
    expect(await history(owner.cookie, trip.id)).toEqual(before);
    expect((await list(owner.cookie, trip.id)).find((place) => place.id === placed[0]!.id)?.assignedDayId).toBeNull();
  });

  function planning(cookie: string, tripId: string, placeId: string, expectedVersion: number, key: string, notes: string, conflictBase?: number) {
    return app.request(`/api/trips/${tripId}/trip-places/${placeId}/planning`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json", origin: "https://app.example.test", "idempotency-key": key,
        ...(conflictBase ? { "Conflict-Base-Version": String(conflictBase) } : {}) },
      body: json({ expectedVersion, notes, durationMinutes: 90, budgetAmountMinor: 1000, budgetCurrency: "JPY" }),
    });
  }

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

  it("commits concurrent invite revocation and a day write without an event lock deadlock", async () => {
    const owner = await login("event-lock-owner@example.test");
    const trip = await createTrip(owner.cookie, "Event lock order");
    const headers = { cookie: owner.cookie, origin: "https://app.example.test", "content-type": "application/json" };
    const invited = await app.request(`/api/trips/${trip.id}/invites`, {
      method: "POST", headers: { ...headers, "idempotency-key": "event-lock-invite" }, body: json({ email: "event-lock-invitee@example.test" }),
    });
    expect(invited.status).toBe(201);
    const invite = (await invited.json()).invite;
    const pool = new Pool({ connectionString: databaseUrl });
    const gate = await pool.connect();
    let window: Promise<Response> | undefined;
    let revoke: Promise<Response> | undefined;
    try {
      await gate.query("begin");
      await gate.query("select id from trips where id = $1 for update", [trip.id]);
      window = Promise.resolve(app.request(`/api/trips/${trip.id}/days/${trip.days[0]!.id}/window`, {
        method: "PUT", headers: { ...headers, "idempotency-key": "event-lock-window" },
        body: json({ expectedVersion: 1, startMinute: 480, endMinute: 1140 }),
      }));
      await waitForDatabaseLock(pool, "row");
      revoke = Promise.resolve(app.request(`/api/trips/${trip.id}/invites/${invite.id}`, {
        method: "DELETE", headers: { ...headers, "idempotency-key": "event-lock-revoke" },
      }));
      // Release only once both real HTTP transactions reach the lock barrier.
      await vi.waitFor(async () => {
        const waiting = await pool.query<{ count: number }>("select count(*)::int as count from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'");
        expect(waiting.rows[0]?.count).toBe(2);
      }, { timeout: 5_000 });
      await gate.query("commit");
      expect((await window).status).toBe(200);
      expect((await revoke).status).toBe(204);
      const events = await history(owner.cookie, trip.id);
      expect(events.filter((event) => event.targetId === invite.id && event.eventType === "invite.revoked")).toHaveLength(1);
      expect(events.filter((event) => event.eventType === "trip_day.window_changed")).toHaveLength(1);
    } finally {
      await gate.query("rollback");
      gate.release();
      await Promise.allSettled([window, revoke].filter((value) => value !== undefined));
      await pool.end();
    }
  }, 15_000);

  it("rejects a day draft whose order changes during its read", async () => {
    const owner = await login("day-snapshot@example.test");
    const trip = await createTrip(owner.cookie, "Day snapshot consistency");
    const headers = { cookie: owner.cookie, origin: "https://app.example.test", "content-type": "application/json" };
    const places: TripPlaceDto[] = [];
    for (const name of ["A", "B"]) {
      const added = await app.request(`/api/trips/${trip.id}/trip-places`, {
        method: "POST", headers: { ...headers, "idempotency-key": `snapshot-${name}` },
        body: json({ method: "manual", name, type: "activity", address: name, latitude: 35, longitude: 135, timeZone: "Asia/Tokyo", sourceUrl: null, originalNote: null }),
      });
      expect(added.status).toBe(201);
      places.push(parseTripPlaceResponse(await added.json()).tripPlace);
    }
    const dayId = trip.days[1]!.id;
    expect((await app.request(`/api/trips/${trip.id}/trip-place-day-assignments`, {
      method: "PUT", headers: { ...headers, "idempotency-key": "snapshot-assign" },
      body: json({ assignments: places.map((place) => ({ tripPlaceId: place.id, tripDayId: dayId, expectedVersion: place.version })) }),
    })).status).toBe(200);
    const readWindow = async () => parseDayWindowResponse(await (await app.request(`/api/trips/${trip.id}/days/${dayId}/window`, { headers })).json()).window;
    const before = await readWindow();
    const originalList = tripPlaces.list.bind(tripPlaces);
    const read = vi.spyOn(tripPlaces, "list").mockImplementationOnce(async (...args) => {
      const old = await originalList(...args);
      expect((await app.request(`/api/trips/${trip.id}/days/${dayId}/place-order`, {
        method: "PUT", headers: { ...headers, "idempotency-key": "snapshot-reorder" },
        body: json({ orderedTripPlaceIds: places.map((place) => place.id).reverse(), expectedVersion: before.version }),
      })).status).toBe(200);
      expect((await readWindow()).version).toBeGreaterThan(before.version);
      return old;
    });
    try {
      const draft = await app.request(`/api/trips/${trip.id}/days/${dayId}/timetable`, {
        method: "POST", headers, body: json({ order: "current" }),
      });
      expect(draft.status, await draft.clone().text()).toBe(409);
      expect(await draft.json()).toMatchObject({ error: { code: "conflict", currentVersion: (await readWindow()).version } });
      expect((await list(owner.cookie, trip.id)).filter((place) => place.assignedDayId === dayId)
        .sort((a, b) => a.dayPosition! - b.dayPosition!).map((place) => place.id)).toEqual(places.map((place) => place.id).reverse());
    } finally { read.mockRestore(); }
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
    expect((await removePlace(second.cookie, trip.id, read, "remove-duplicate")).status).toBe(204);
    const readded = await addProvider(second.cookie, trip.id, "readd-kiyomizu", "Easy taxi drop-off", method);
    expect(readded.status).toBe(201);
    const restored = parseTripPlaceResponse(await readded.json()).tripPlace;
    expect(restored).toMatchObject({ id: first.id, notes: "Easy taxi drop-off", voteCount: 0, assignedDayId: null });
    expect((await list(owner.cookie, trip.id))[0]?.notes).toBe("Easy taxi drop-off");
    const skeleton = await app.request(`/api/trips/${trip.id}/skeleton`, { headers: { cookie: owner.cookie } });
    expect(parseTripSkeletonResponse(await skeleton.json()).skeleton.places.find((place) => place.name === first.name)?.notes)
      .toBe("Easy taxi drop-off");
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

  it("orders active votes descending, ignores removed members, and disables voting for one member", async () => {
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
      .toEqual([[two.id, 2], [one.id, 1], [tie.id, 1], [zero.id, 0]]);
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
    for (const voted of [true, false]) {
      const refused = await setVote(owner.cookie, trip.id, two.id, voted, `single-${voted}`);
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ error: { code: "voting_unavailable" } });
    }
    // A retry of a vote stored before the trip dropped to one member replays its success.
    expect((await setVote(owner.cookie, trip.id, two.id, true, `${owner.user.id}-${two.id}`)).status).toBe(200);
    const solo = await list(owner.cookie, trip.id);
    expect(solo.map((place) => place.id)).toEqual([zero.id, one.id, two.id, tie.id]);
    expect(solo.every((place) => !place.votingAvailable)).toBe(true);
    expect(solo.find((place) => place.id === two.id)?.voteCount).toBe(1);
  });

  it("merges the union of votes without duplicating a member", async () => {
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
    const merged = await app.request(`/api/trips/${trip.id}/trip-places/${source.id}/merge`, {
      method: "POST",
      headers: { cookie: owner.cookie, "content-type": "application/json", "idempotency-key": "union-merge", origin: "https://app.example.test" },
      body: json({
        targetTripPlaceId: target.id,
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
    expect((await app.request(`/api/trips/${trip.id}/trip-place-day-assignments`, request)).status).toBe(200);
    await sql`
      update mutation_requests set response = jsonb_set(response, '{tripPlaces}', (
        select jsonb_agg(entry - 'sourceUrl' - 'voters' - 'voteCount' - 'ownVote' - 'votingAvailable')
        from jsonb_array_elements(response -> 'tripPlaces') entry
      ))
      where actor_id = ${owner.user.id} and operation = ${`tp:day-assignments:${trip.id}`} and idempotency_key = 'old-assignment'
    `.execute(database);
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
    const dayVersion = async () => parseDayWindowResponse(await (await app.request(`/api/trips/${trip.id}/days/${dayTwo}/window`, { headers: { cookie: owner.cookie } })).json()).window.version;
    expect((await send("PUT", orderPath, "day-order", { orderedTripPlaceIds: currentOrder, expectedVersion: await dayVersion() })).status).toBe(200);

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
    expect(first.window).toEqual({ startMinute: 9 * 60, endMinute: 19 * 60, version: await dayVersion() });
    expect(first.startsAt).toEqual({ placeId: hotel.id, name: "Kyoto Station Hotel" });
    expect(first.endsAt).toEqual({ placeId: hotel.id, name: "Kyoto Station Hotel" });
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
        bufferEstimated: false,
        afterBufferMinutes: 0,
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
    // The 15 confirmed minutes before lunch are spent waiting there, so they count as busy.
    expect(first.load).toEqual({ busyMinutes: 90 + 18 + 15 + 60 + 10 + 45 + 10 + 10, windowMinutes: 600, level: "relaxed" });
    // One opening-hours lookup per Google place; every route as if leaving at the day's start.
    expect([...hours.calls].sort()).toEqual([provider.branch.providerPlaceId, provider.kyoto.providerPlaceId].sort());
    expect(new Set(routes.queries.map((query) => query.departureTime))).toEqual(new Set(["2026-10-22T09:00:00+09:00"]));

    expect(await draft("current")).toEqual(first);
    expect(await skeleton()).toMatchObject({ tripVersion: before.tripVersion, items: before.items });

    // Another member shortens the day; everyone's next draft uses the saved window.
    const second = await login("second@example.test");
    await addMember(trip.id, second.user.id);
    const windowPath = `/api/trips/${trip.id}/days/${dayTwo}/window`;
    expect((await send("PUT", windowPath, "day-window-empty", { startMinute: 600, endMinute: 600, expectedVersion: first.window.version })).status).toBe(400);
    const changed = await send("PUT", windowPath, "day-window", { startMinute: 540, endMinute: 810, expectedVersion: first.window.version }, second.cookie);
    expect(changed.status).toBe(200);
    const changedWindow = parseDayWindowResponse(await changed.json()).window;
    expect(changedWindow).toEqual({ startMinute: 540, endMinute: 810, version: first.window.version + 1 });
    const shortened = await draft("current");
    expect(shortened.window).toEqual(changedWindow);
    expect(shortened.rows.map((row) => row.kind)).toEqual(["start", "visit", "fixed"]);
    expect(shortened.unscheduled).toContainEqual({ tripPlaceId: tofukuji.id, name: "Tofuku-ji", reason: "not_enough_time" });
    expect((await draft("current", second.cookie)).window).toEqual(changedWindow);

    // The suggested order is drafted in that order and, once used, becomes the day's order.
    const suggested = await draft("suggested");
    expect(suggested.order).toBe("suggested");
    expect([...suggested.orderedTripPlaceIds].sort()).toEqual([...currentOrder].sort());
    const visited = suggested.rows.flatMap((row) => row.kind === "visit" ? [row.tripPlaceId] : []);
    expect(visited).toEqual(suggested.orderedTripPlaceIds.filter((id) => visited.includes(id)));
    const applied = await send("PUT", orderPath, "day-order-suggested", {
      orderedTripPlaceIds: suggested.orderedTripPlaceIds,
      expectedVersion: suggested.window.version,
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
      expectedVersion: suggested.window.version,
    });
    expect(replay.status).toBe(200);
    expect(await positions()).toEqual(afterApply);
    // An order naming a place planned for another day is stale and changes nothing.
    const stale = await send("PUT", orderPath, "day-order-stale", {
      orderedTripPlaceIds: [arashiyama.id, ...suggested.orderedTripPlaceIds],
      expectedVersion: await dayVersion(),
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
    // Active members' votes prioritize Kiyomizu; fixed items and day placement stay unchanged.
    const second = await login("second@example.test");
    await addMember(trip.id, second.user.id);
    for (const [cookie, place, key] of [
      [owner.cookie, kiyomizu, "plan-owner-kiyomizu"],
      [second.cookie, kiyomizu, "plan-second-kiyomizu"],
      [owner.cookie, hidden, "plan-owner-hidden"],
    ] as const) {
      expect((await setVote(cookie, trip.id, place.id, true, key)).status).toBe(200);
    }
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
      days: chosen.days.map((day) => ({ tripDayId: day.timetable.dayId, orderedTripPlaceIds: day.orderedTripPlaceIds, expectedVersion: day.timetable.window.version })),
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
    // The day plan retains its places and formal itinerary items.
    const dayDraft = await send("POST", `/api/trips/${trip.id}/days/${dayOf("2026-10-22")}/timetable`, null, {
      order: "current",
    });
    expect(parseDayTimetableResponse(await dayDraft.json()).timetable.orderedTripPlaceIds).toEqual([kiyomizu.id]);
    // Nothing is left to add except the place without a location.
    expect(await draft()).toMatchObject({ days: [], unplaced: [{ tripPlaceId: hidden.id, reason: "no_location" }] });
  });

  it("starts arrival, moving and departure days where the traveller really is", async () => {
    const owner = await login("owner@example.test");
    const trip = await createTrip(owner.cookie, "Travel days trip");
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
    // This scenario supplies its own arrival/departure pair and measured airport routes;
    // do not leave the general creation fixture as extra fixed blocks on its arrival day.
    const initial = await app.request(`/api/trips/${trip.id}/skeleton`, { headers: { cookie: owner.cookie } });
    for (const flight of parseTripSkeletonResponse(await initial.json()).skeleton.items) {
      expect((await send("DELETE", `/api/trips/${trip.id}/items/${flight.id}`, `remove-${flight.id}`,
        { expectedVersion: flight.version })).status).toBe(204);
    }
    const tripVersion = async () => {
      const response = await app.request(`/api/trips/${trip.id}/skeleton`, { headers: { cookie: owner.cookie } });
      return parseTripSkeletonResponse(await response.json()).skeleton.tripVersion;
    };
    const skeletonPlace = async (key: string, name: string, type: string, latitude: number, longitude: number, timeZone: string) => {
      const response = await send("POST", `/api/trips/${trip.id}/places`, key, {
        name, type, address: null, latitude, longitude, timeZone, sourceUrl: null, notes: null,
        expectedTripVersion: await tripVersion(),
      });
      expect(response.status).toBe(201);
      return parsePlaceResponse(await response.json()).place;
    };
    const at = (placeId: string, role: "start" | "end", localDateTime: string, timeZone = "Asia/Tokyo") => ({
      role, countryStopId: trip.countryStops[0]!.id, placeId, localDateTime, timeZone,
    });
    const item = async (key: string, payload: Record<string, unknown>) => {
      const response = await send("POST", `/api/trips/${trip.id}/items`, key, {
        expectedTripVersion: await tripVersion(),
        participantMemberIds: null, notes: null, sourceUrl: null, money: null, constraints: [],
        ...payload,
      });
      expect(response.status).toBe(201);
      return parseItineraryItemResponse(await response.json()).item;
    };
    const tpe = await skeletonPlace("days-tpe", "Taoyuan Airport", "airport", 25.0797, 121.2342, "Asia/Taipei");
    const kix = await skeletonPlace("days-kix", "Kansai Airport", "airport", 34.4347, 135.244, "Asia/Tokyo");
    const kyotoHotel = await skeletonPlace("days-kyoto", "Kyoto Station Hotel", "lodging", 34.9858, 135.7588, "Asia/Tokyo");
    const osakaHotel = await skeletonPlace("days-osaka", "Namba Hotel", "lodging", 34.6665, 135.5013, "Asia/Tokyo");
    const flight = (key: string, title: string, from: [string, string, string], to: [string, string, string]) => item(key, {
      type: "flight",
      title,
      endpoints: [at(from[0], "start", from[1], from[2]), at(to[0], "end", to[1], to[2])],
      details: { carrier: null, serviceNumber: title, confirmationNotes: null },
    });
    // In on the 21st (lands 12:30), Kyoto for two nights, Osaka for two, out on the 25th at 18:00.
    const inbound = await flight("days-in", "CI 152", [tpe.id, "2026-10-21T09:00", "Asia/Taipei"], [kix.id, "2026-10-21T12:30", "Asia/Tokyo"]);
    const outbound = await flight("days-out", "CI 153", [kix.id, "2026-10-25T18:00", "Asia/Tokyo"], [tpe.id, "2026-10-25T20:00", "Asia/Taipei"]);
    for (const [key, hotel, from, to] of [
      ["days-stay-kyoto", kyotoHotel, "2026-10-21T15:00", "2026-10-23T10:00"],
      ["days-stay-osaka", osakaHotel, "2026-10-23T15:00", "2026-10-25T11:00"],
    ] as const) {
      await item(key, {
        type: "lodging",
        title: hotel.name,
        endpoints: [at(hotel.id, "start", from), at(hotel.id, "end", to)],
        details: { bookedBy: null, confirmationCode: null },
      });
    }
    const manual = async (key: string, name: string, latitude: number, longitude: number) => {
      const response = await send("POST", `/api/trips/${trip.id}/trip-places`, key, {
        method: "manual", name, type: "activity", address: null, latitude, longitude,
        timeZone: "Asia/Tokyo", sourceUrl: null, originalNote: null,
      });
      expect(response.status).toBe(201);
      return parseTripPlaceResponse(await response.json()).tripPlace;
    };
    const dayOf = (date: string) => trip.days.find((day) => day.date === date)!.id;
    const kiyomizu = await manual("days-kiyomizu", "Kiyomizu-dera", 34.9949, 135.785);
    const castle = await manual("days-castle", "Osaka Castle", 34.6873, 135.5262);
    const dotonbori = await manual("days-dotonbori", "Dotonbori", 34.6687, 135.5013);
    expect((await send("PUT", `/api/trips/${trip.id}/trip-place-day-assignments`, "days-assign", {
      assignments: [
        { tripPlaceId: kiyomizu.id, tripDayId: dayOf("2026-10-21"), expectedVersion: kiyomizu.version },
        { tripPlaceId: castle.id, tripDayId: dayOf("2026-10-23"), expectedVersion: castle.version },
        { tripPlaceId: dotonbori.id, tripDayId: dayOf("2026-10-25"), expectedVersion: dotonbori.version },
      ],
    })).status).toBe(200);
    // Airport and hotel transfers take the train; everything else is a 10-minute walk.
    for (const [left, right, minutes] of [
      [kix.id, kyotoHotel.id, 75],
      [kyotoHotel.id, osakaHotel.id, 50],
      [osakaHotel.id, kix.id, 60],
    ] as const) {
      routes.walking.set(ControlledRouteProvider.pair(left, right), null);
      routes.transit.set(ControlledRouteProvider.pair(left, right), minutes);
    }
    const draft = async (date: string) => {
      const response = await send("POST", `/api/trips/${trip.id}/days/${dayOf(date)}/timetable`, null, { order: "current" });
      expect(response.status).toBe(200);
      return parseDayTimetableResponse(await response.json()).timetable;
    };
    const kinds = (rows: Awaited<ReturnType<typeof draft>>["rows"]) => rows.map((row) =>
      row.kind === "luggage" ? `${row.action}-luggage` : row.kind === "fixed" ? row.title : row.kind === "visit" ? row.name : row.kind);

    // Arrival: lands 12:30, an estimated hour for entry and luggage, 75 minutes to the hotel.
    const arrival = await draft("2026-10-21");
    expect(arrival).toMatchObject({ startsAt: null, endsAt: { placeId: kyotoHotel.id } });
    expect(kinds(arrival.rows)).toEqual(["CI 152", "drop-luggage", "Kiyomizu-dera", "return"]);
    // Check-in for this flight happened in Taipei, so no airport buffer is shown for it here.
    expect(arrival.rows[0]).toMatchObject({ itemId: inbound.id, endMinute: 750, afterBufferMinutes: 60, bufferMinutes: 0 });
    expect(arrival.rows[1]).toMatchObject({ arriveMinute: 885, leaveMinute: 900, travel: { fromName: "Kansai Airport", durationMinutes: 75 } });
    expect(arrival.rows[2]).toMatchObject({ startMinute: 910, endMinute: 1000 });

    // Moving day: from Kyoto, luggage to Osaka first, back to Osaka at the end.
    const moving = await draft("2026-10-23");
    expect(moving).toMatchObject({ startsAt: { placeId: kyotoHotel.id }, endsAt: { placeId: osakaHotel.id } });
    expect(kinds(moving.rows)).toEqual(["start", "drop-luggage", "Osaka Castle", "return"]);
    expect(moving.rows[1]).toMatchObject({ name: "Namba Hotel", arriveMinute: 590, leaveMinute: 605 });
    expect(moving.rows[3]).toMatchObject({ name: "Namba Hotel", arriveMinute: 715 });

    // Departure: from Osaka, back for the luggage, at the airport two hours before 18:00.
    const departure = await draft("2026-10-25");
    expect(departure).toMatchObject({ startsAt: { placeId: osakaHotel.id }, endsAt: null });
    expect(kinds(departure.rows)).toEqual(["start", "Dotonbori", "collect-luggage", "CI 153"]);
    expect(departure.rows[2]).toMatchObject({ name: "Namba Hotel", arriveMinute: 650, leaveMinute: 665 });
    expect(departure.rows[3]).toMatchObject({
      itemId: outbound.id,
      startMinute: 1080,
      bufferMinutes: 120,
      bufferEstimated: true,
      afterBufferMinutes: 0,
      travel: { fromName: "Namba Hotel", durationMinutes: 60 },
    });

    // A confirmed buffer replaces the default.
    expect((await send("POST", `/api/trips/${trip.id}/items/${outbound.id}/constraints`, "days-buffer", {
      type: "minimum_buffer", status: "confirmed", minimumBufferMinutes: 90, expectedItemVersion: outbound.version,
    })).status).toBe(201);
    expect((await draft("2026-10-25")).rows.at(-1)).toMatchObject({ bufferMinutes: 90, bufferEstimated: false });

    // With a train to the airport, luggage is collected before the train, not before the flight.
    const station = await skeletonPlace("days-namba-station", "Namba Station", "station", 34.6627, 135.5021, "Asia/Tokyo");
    const rapit = await item("days-rapit", {
      type: "transport",
      title: "Rapi:t",
      endpoints: [at(station.id, "start", "2026-10-25T15:00"), at(kix.id, "end", "2026-10-25T15:40")],
      details: { mode: "train", ticketInfo: null },
    });
    const withTrain = await draft("2026-10-25");
    expect(kinds(withTrain.rows)).toEqual(["start", "Dotonbori", "collect-luggage", "Rapi:t", "CI 153"]);
    expect(withTrain.rows[2]).toMatchObject({ arriveMinute: 650, leaveMinute: 665 });
    expect(withTrain.rows[3]).toMatchObject({ itemId: rapit.id, travel: { fromName: "Namba Hotel", toName: "Namba Station" } });

    // A day without any lodging is not an arrival day: a midday train leaves the morning free.
    const aquarium = await manual("days-aquarium", "Kaiyukan", 34.6545, 135.429);
    expect((await send("PUT", `/api/trips/${trip.id}/trip-place-day-assignments`, "days-assign-aquarium", {
      assignments: [{ tripPlaceId: aquarium.id, tripDayId: dayOf("2026-10-26"), expectedVersion: aquarium.version }],
    })).status).toBe(200);
    await item("days-jr", {
      type: "transport",
      title: "JR to Kyoto",
      endpoints: [at(station.id, "start", "2026-10-26T13:00"), at(kyotoHotel.id, "end", "2026-10-26T13:30")],
      details: { mode: "train", ticketInfo: null },
    });
    const afterTrip = await draft("2026-10-26");
    expect(kinds(afterTrip.rows)).toEqual(["Kaiyukan", "JR to Kyoto"]);
    expect(afterTrip.rows[0]).toMatchObject({ startMinute: 540 });
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

  it("allows itinerary deletion despite another member's contribution and votes", async () => {
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
        headers: { cookie: owner.cookie, "content-type": "application/json", "idempotency-key": key, origin: "https://app.example.test" },
        body: json({ expectedVersion: legacy.version }),
      });
    };
    expect((await deletePlace("delete-voted")).status).toBe(204);
    expect(await list(owner.cookie, trip.id)).toEqual([]);
    expect(await database.selectFrom("trip_place_votes").selectAll().where("trip_place_id", "=", place.id).execute()).toEqual([]);
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
      `/api/trips/${trip.id}/trip-places/${archivedCandidate.id}/remove`,
      {
        method: "POST",
        headers: {
          cookie: owner.cookie,
          "content-type": "application/json",
          "idempotency-key": "archive-lower-duplicate",
          origin: "https://app.example.test",
        },
        body: json({ expectedVersion: archivedCandidate.version }),
      },
    );
    expect(archived.status).toBe(204);
    const survivor = await list(owner.cookie, trip.id);
    expect(survivor).toHaveLength(1);
    expect(survivor[0]).toMatchObject({
      status: "needs-location",
      duplicateSuggestions: [],
    });
  });


  it("lets another member remove a scheduled place without changing any formal itinerary content", async () => {
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
    const activity = await app.request(`/api/trips/${trip.id}/items`, {
      method: "POST",
      headers: { cookie: owner.cookie, "content-type": "application/json", "idempotency-key": "activity-before-remove", origin: "https://app.example.test" },
      body: json({
        expectedTripVersion: skeleton.tripVersion, type: "activity", title: "Keep my booking",
        notes: "Booking stays", sourceUrl: null, money: null, participantMemberIds: null,
        endpoints: [{ role: "start", countryStopId: trip.countryStops[0]!.id, placeId: legacy.id,
          localDateTime: "2026-10-21T10:00", timeZone: "Asia/Tokyo" }],
        details: { durationMinutes: 60, bookedBy: null, confirmationStatus: "unknown" }, constraints: [],
      }),
    });
    expect(activity.status).toBe(201);
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
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "conflict", currentVersion: current.version } });
    const endpointRefused = await app.request(`/api/trips/${trip.id}/places/${legacy.id}`, {
      method: "DELETE",
      headers: { cookie: second.cookie, "content-type": "application/json", "idempotency-key": "delete-in-use", origin: "https://app.example.test" },
      body: json({ expectedVersion: legacy.version }),
    });
    expect(endpointRefused.status).toBe(409);
    expect(await endpointRefused.json()).toMatchObject({ error: { code: "place_in_use" } });
    expect((await removePlace(second.cookie, trip.id, current, "remove-scheduled")).status).toBe(204);
    expect((await removePlace(second.cookie, trip.id, current, "remove-scheduled")).status).toBe(204);
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
      .toEqual([{ actor_id: second.user.id }]);
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
});
