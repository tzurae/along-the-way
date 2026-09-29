import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import type { Hono } from "hono";
import {
  parseItineraryItemResponse,
  parsePlaceResponse,
  parseTripSkeletonResponse,
} from "@along-the-way/contracts/trip-skeleton";
import { parseTripResponse } from "@along-the-way/contracts/private-trips";
import { parseTripPlaceListResponse } from "@along-the-way/contracts/trip-places";

import { createApp } from "../src/app";
import { createDatabase, type AlongTheWayDatabase } from "../src/database/database";
import { runMigrations } from "../src/database/migrate";
import { seedDatabase } from "../src/database/seed";
import type { EmailSender } from "../src/private-trips/email-sender";
import { PostgresEmailWorker } from "../src/private-trips/postgres-email-worker";
import { PostgresIdentityAccessModule } from "../src/private-trips/postgres-identity-access-module";
import { PostgresRateLimiter } from "../src/private-trips/postgres-rate-limiter";
import { PostgresReadinessProbe } from "../src/private-trips/postgres-readiness-probe";
import { PostgresTripWorkspaceModule } from "../src/private-trips/postgres-trip-workspace-module";
import { TokenIssuer } from "../src/private-trips/token-issuer";
import { PostgresTripSkeletonModule } from "../src/trip-skeleton/postgres-trip-skeleton-module";
import { GooglePlacesProvider } from "../src/trip-places/google-places-provider";
import { PostgresTripPlaceModule } from "../src/trip-places/postgres-trip-place-module";
import { unrelatedDiscoveryModule } from "./discovery-test-support";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");

class CapturingEmailSender implements EmailSender {
  readonly magicLinks: Array<{ to: string; url: string }> = [];
  readonly invites: Array<{ to: string; tripName: string; url: string }> = [];

  async sendMagicLink(message: { to: string; url: string }) {
    this.magicLinks.push(message);
  }

  async sendTripInvite(message: {
    to: string;
    tripName: string;
    url: string;
  }) {
    this.invites.push(message);
  }
}

function body(value: unknown) {
  return JSON.stringify(value);
}

function cookieFrom(response: Response) {
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("Expected session cookie");
  return cookie;
}

describe("trip skeleton through HTTP and PostgreSQL", () => {
  let database: Kysely<AlongTheWayDatabase>;
  let app: Hono;
  let email: CapturingEmailSender;
  let emailWorker: PostgresEmailWorker;

  beforeAll(async () => {
    database = createDatabase(databaseUrl);
    await runMigrations(database);
  });

  beforeEach(async () => {
    await sql`
      truncate table
        itinerary_constraints,
        itinerary_endpoints,
        itinerary_items,
        trip_place_duplicate_suggestions,
        trip_place_excluded_days,
        trip_place_desired_days,
        member_place_preferences,
        trip_place_contributions,
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
    let sessionNumber = 0;
    email = new CapturingEmailSender();
    const now = () => new Date("2026-09-28T12:00:00.000Z");
    const tokenIssuer = new TokenIssuer("trip-skeleton-integration-secret-at-least-32-bytes");
    const identityAccess = new PostgresIdentityAccessModule({
      database,
      tokenIssuer,
      now,
      randomSessionToken: () => `trip-skeleton-session-${++sessionNumber}`,
    });
    emailWorker = new PostgresEmailWorker({
      database,
      emailSender: email,
      siteAddress: "https://app.example.test",
      tokenIssuer,
      now,
    });
    app = createApp({
      discovery: unrelatedDiscoveryModule,
      identityAccess,
      rateLimiter: new PostgresRateLimiter(database, "trip-skeleton-rate-secret-at-least-32-bytes", now),
      readiness: new PostgresReadinessProbe(database, now),
      siteAddress: "https://app.example.test",
      tripSkeleton: new PostgresTripSkeletonModule({ database, now }),
      tripPlaces: new PostgresTripPlaceModule({
        database,
        provider: new GooglePlacesProvider(),
        now,
      }),
      tripWorkspace: new PostgresTripWorkspaceModule({ database, now }),
    });
  });

  afterAll(async () => {
    await database.destroy();
  });

  async function login(
    address = "owner@example.test",
    inviteToken?: string,
  ) {
    const requested = await app.request("/api/auth/magic-links", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://app.example.test" },
      body: body({
        email: address,
        ...(inviteToken ? { inviteToken } : {}),
      }),
    });
    expect(requested.status).toBe(202);
    await emailWorker.runOnce();
    const link = email.magicLinks.at(-1)?.url;
    const token = link && new URLSearchParams(new URL(link).hash.slice(1)).get("magicToken");
    if (!token) throw new Error("Magic link token missing");
    const consumed = await app.request("/api/auth/magic-links/consume", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://app.example.test" },
      body: body({ token }),
    });
    expect(consumed.status).toBe(200);
    return cookieFrom(consumed);
  }

  async function createTrip(
    cookie: string,
    input = {
      name: "大阪京都家庭旅行",
      startDate: "2026-10-21",
      endDate: "2026-10-27",
      countryCodes: ["JP"],
    },
  ) {
    const response = await app.request("/api/trips", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "idempotency-key": `create-trip-skeleton-trip-${input.countryCodes.join("-")}`,
        origin: "https://app.example.test",
      },
      body: body(input),
    });
    expect(response.status).toBe(201);
    return parseTripResponse(await response.json()).trip;
  }

  async function currentTripVersion(cookie: string, tripId: string) {
    const response = await app.request(`/api/trips/${tripId}/skeleton`, {
      headers: { cookie },
    });
    expect(response.status).toBe(200);
    return parseTripSkeletonResponse(await response.json()).skeleton.tripVersion;
  }

  async function createPlace(
    cookie: string,
    tripId: string,
    key: string,
    input: Record<string, unknown>,
  ) {
    const response = await app.request(`/api/trips/${tripId}/places`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "idempotency-key": key,
        origin: "https://app.example.test",
      },
      body: body({ ...input, expectedTripVersion: await currentTripVersion(cookie, tripId) }),
    });
    expect(response.status).toBe(201);
    return parsePlaceResponse(await response.json()).place;
  }

  it("creates and replays a trip-scoped place without fabricating location metadata", async () => {
    const cookie = await login();
    const trip = await createTrip(cookie);
    const request = {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "idempotency-key": "create-manual-place",
        origin: "https://app.example.test",
      },
      body: body({
        expectedTripVersion: trip.version,
        name: "京都集合地點",
        type: "other",
        address: "京都駅附近",
        latitude: null,
        longitude: null,
        timeZone: null,
        sourceUrl: null,
        notes: "入口待確認",
      }),
    };

    const first = await app.request(`/api/trips/${trip.id}/places`, request);
    expect(first.status).toBe(201);
    const created = parsePlaceResponse(await first.json()).place;
    expect(created).toMatchObject({
      tripId: trip.id,
      name: "京都集合地點",
      locationStatus: "coordinates_missing",
      timeZone: null,
      version: 1,
    });

    const replay = await app.request(`/api/trips/${trip.id}/places`, request);
    expect(replay.status).toBe(201);
    expect(parsePlaceResponse(await replay.json()).place.id).toBe(created.id);

    const update = await app.request(`/api/trips/${trip.id}/places/${created.id}`, {
      method: "PATCH",
      headers: {
        cookie,
        "content-type": "application/json",
        "idempotency-key": "update-manual-place",
        origin: "https://app.example.test",
      },
      body: body({
        expectedVersion: created.version,
        name: created.name,
        type: created.type,
        address: created.address,
        latitude: created.latitude,
        longitude: created.longitude,
        timeZone: created.timeZone,
        sourceUrl: created.sourceUrl,
        notes: "共享規劃備註已更新",
      }),
    });
    expect(update.status).toBe(200);
    const updated = parsePlaceResponse(await update.json()).place;
    const wishlist = await app.request(`/api/trips/${trip.id}/trip-places`, {
      headers: { cookie },
    });
    expect(wishlist.status).toBe(200);
    const [projected] = parseTripPlaceListResponse(await wishlist.json()).tripPlaces;
    expect(projected?.notes).toBe("共享規劃備註已更新");
    expect(projected?.contributions[0]?.originalNote).toBe("入口待確認");

    const staleCreate = await app.request(`/api/trips/${trip.id}/places`, {
      ...request,
      headers: {
        ...request.headers,
        "idempotency-key": "create-place-with-stale-trip-version",
      },
    });
    expect(staleCreate.status).toBe(409);
    expect(await staleCreate.json()).toMatchObject({
      error: { code: "conflict", currentVersion: 2 },
    });

    const read = await app.request(`/api/trips/${trip.id}/skeleton`, { headers: { cookie } });
    expect(read.status).toBe(200);
    expect(parseTripSkeletonResponse(await read.json()).skeleton.places).toEqual([updated]);
  });

  it("keeps cross-timezone endpoints ordered and requires unlock before mutation", async () => {
    const cookie = await login();
    const trip = await createTrip(cookie, {
      name: "洛杉磯東京旅行",
      startDate: "2026-10-21",
      endDate: "2026-10-27",
      countryCodes: ["US", "JP"],
    });
    const lax = await createPlace(cookie, trip.id, "create-lax", {
      name: "Los Angeles International Airport",
      type: "airport",
      address: "1 World Way, Los Angeles",
      latitude: 33.9416,
      longitude: -118.4085,
      timeZone: "America/Los_Angeles",
      sourceUrl: "https://www.flylax.com/",
      notes: null,
    });
    const haneda = await createPlace(cookie, trip.id, "create-haneda", {
      name: "Haneda Airport",
      type: "airport",
      address: "Tokyo",
      latitude: 35.5494,
      longitude: 139.7798,
      timeZone: "Asia/Tokyo",
      sourceUrl: null,
      notes: null,
    });
    const input = {
      type: "flight",
      title: "Los Angeles to Tokyo",
      notes: "Window seat requested",
      sourceUrl: "https://example.test/flight",
      money: { amountMinor: 125000, currency: "USD" },
      endpoints: [
        {
          role: "start",
          countryStopId: trip.countryStops[0]!.id,
          placeId: lax.id,
          localDateTime: "2026-10-21T10:00",
          timeZone: "America/Los_Angeles",
        },
        {
          role: "end",
          countryStopId: trip.countryStops[1]!.id,
          placeId: haneda.id,
          localDateTime: "2026-10-22T14:00",
          timeZone: "Asia/Tokyo",
        },
      ],
      details: {
        carrier: "Japan Airlines",
        serviceNumber: "JL7015",
        confirmationNotes: "Confirmed",
      },
      constraints: [
        {
          type: "fixed_time",
          status: "confirmed",
          minimumBufferMinutes: null,
        },
      ],
    };
    const createRequest = {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "idempotency-key": "create-cross-timezone-flight",
        origin: "https://app.example.test",
      },
      body: body({ ...input, expectedTripVersion: await currentTripVersion(cookie, trip.id) }),
    };
    const createdResponse = await app.request(
      `/api/trips/${trip.id}/items`,
      createRequest,
    );
    expect(createdResponse.status).toBe(201);
    const created = parseItineraryItemResponse(await createdResponse.json()).item;
    expect(created.endpoints).toMatchObject([
      {
        utcOffset: "-07:00",
        instant: "2026-10-21T17:00:00.000Z",
      },
      {
        utcOffset: "+09:00",
        instant: "2026-10-22T05:00:00.000Z",
      },
    ]);
    expect(created.money).toEqual({ amountMinor: 125000, currency: "USD" });
    expect(created.constraints[0]?.status).toBe("confirmed");

    const replay = await app.request(`/api/trips/${trip.id}/items`, createRequest);

    const staleCreate = await app.request(`/api/trips/${trip.id}/items`, {
      ...createRequest,
      headers: {
        ...createRequest.headers,
        "idempotency-key": "create-item-with-stale-trip-version",
      },
    });
    expect(staleCreate.status).toBe(409);
    expect(await staleCreate.json()).toMatchObject({
      error: { code: "conflict", currentVersion: 4 },
    });
    expect(parseItineraryItemResponse(await replay.json()).item.id).toBe(created.id);

    const skeletonResponse = await app.request(`/api/trips/${trip.id}/skeleton`, {
      headers: { cookie },
    });
    const skeleton = parseTripSkeletonResponse(await skeletonResponse.json()).skeleton;
    expect(skeleton.items).toHaveLength(1);
    expect(skeleton.days.find((day) => day.date === "2026-10-21")?.entries).toEqual([
      {
        itemId: created.id,
        projection: "full",
        sortInstant: "2026-10-21T17:00:00.000Z",
      },
    ]);
    expect(skeleton.days.find((day) => day.date === "2026-10-22")?.entries).toEqual([
      {
        itemId: created.id,
        projection: "continuation",
        sortInstant: "2026-10-22T05:00:00.000Z",
      },
    ]);
    expect(skeleton.tripInformationItemIds).toContain(created.id);

    const lock = await app.request(`/api/trips/${trip.id}/items/${created.id}/lock`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        origin: "https://app.example.test",
        "idempotency-key": "lock-cross-timezone-flight",
      },
      body: body({ expectedVersion: 1 }),
    });
    expect(lock.status).toBe(200);
    const locked = parseItineraryItemResponse(await lock.json()).item;
    expect(locked).toMatchObject({ version: 2 });
    expect(locked.lockedAt).not.toBeNull();

    const lockedUpdate = await app.request(
      `/api/trips/${trip.id}/items/${created.id}`,
      {
        method: "PATCH",
        headers: {
          cookie,
          "content-type": "application/json",
          origin: "https://app.example.test",
          "idempotency-key": "reject-locked-item-update",
        },
        body: body({ ...input, title: "Must not change", expectedVersion: 2 }),
      },
    );
    expect(lockedUpdate.status).toBe(409);
    expect(await lockedUpdate.json()).toMatchObject({
      error: { code: "item_locked" },
    });

    const lockedDelete = await app.request(
      `/api/trips/${trip.id}/items/${created.id}`,
      {
        method: "DELETE",
        headers: {
          cookie,
          "content-type": "application/json",
          origin: "https://app.example.test",
          "idempotency-key": "reject-locked-item-delete",
        },
        body: body({ expectedVersion: 2 }),
      },
    );
    expect(lockedDelete.status).toBe(409);

    const lockedPlaceUpdate = await app.request(
      `/api/trips/${trip.id}/places/${lax.id}`,
      {
        method: "PATCH",
        headers: {
          cookie,
          "content-type": "application/json",
          origin: "https://app.example.test",
          "idempotency-key": "reject-locked-place-update",
        },
        body: body({
          name: "Renamed while locked",
          type: "airport",
          address: "1 World Way, Los Angeles",
          latitude: 33.9416,
          longitude: -118.4085,
          timeZone: "America/Denver",
          sourceUrl: "https://www.flylax.com/",
          notes: null,
          expectedVersion: 1,
        }),
      },
    );
    expect(lockedPlaceUpdate.status).toBe(409);
    expect(await lockedPlaceUpdate.json()).toMatchObject({
      error: { code: "item_locked" },
    });

    const unlock = await app.request(
      `/api/trips/${trip.id}/items/${created.id}/unlock`,
      {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/json",
          origin: "https://app.example.test",
          "idempotency-key": "unlock-cross-timezone-flight",
        },
        body: body({ expectedVersion: 2 }),
      },
    );
    expect(unlock.status).toBe(200);
    expect(parseItineraryItemResponse(await unlock.json()).item.version).toBe(3);
    const placeUpdate = await app.request(`/api/trips/${trip.id}/places/${lax.id}`, {
      method: "PATCH",
      headers: {
        cookie,
        "content-type": "application/json",
        origin: "https://app.example.test",
        "idempotency-key": "correct-lax-time-zone",
      },
      body: body({
        name: "LAX",
        type: "airport",
        address: "1 World Way, Los Angeles",
        latitude: 33.9416,
        longitude: -118.4085,
        timeZone: "America/Denver",
        sourceUrl: "https://www.flylax.com/",
        notes: null,
        expectedVersion: 1,
      }),
    });
    expect(placeUpdate.status).toBe(200);
    expect(parsePlaceResponse(await placeUpdate.json()).place).toMatchObject({
      name: "LAX",
      timeZone: "America/Denver",
      version: 2,
    });

    const correctedInput = {
      ...input,
      endpoints: input.endpoints.map((endpoint) =>
        endpoint.role === "start"
          ? { ...endpoint, timeZone: "America/Denver" }
          : endpoint,
      ),
    };
    const firstUpdate = await app.request(
      `/api/trips/${trip.id}/items/${created.id}`,
      {
        method: "PATCH",
        headers: {
          cookie,
          "content-type": "application/json",
          origin: "https://app.example.test",
          "idempotency-key": "correct-flight-time-zone",
        },
        body: body({ ...correctedInput, title: "Updated flight", expectedVersion: 3 }),
      },
    );
    expect(firstUpdate.status).toBe(200);
    const correctedItem = parseItineraryItemResponse(await firstUpdate.json()).item;
    expect(correctedItem).toMatchObject({
      id: created.id,
      title: "Updated flight",
      version: 4,
    });
    expect(correctedItem.endpoints[0]).toMatchObject({
      timeZone: "America/Denver",
      utcOffset: "-06:00",
      instant: "2026-10-21T16:00:00.000Z",
    });
    const replayedUpdate = await app.request(
      `/api/trips/${trip.id}/items/${created.id}`,
      {
        method: "PATCH",
        headers: {
          cookie,
          "content-type": "application/json",
          origin: "https://app.example.test",
          "idempotency-key": "correct-flight-time-zone",
        },
        body: body({ ...correctedInput, title: "Updated flight", expectedVersion: 3 }),
      },
    );
    expect(replayedUpdate.status).toBe(200);
    expect(parseItineraryItemResponse(await replayedUpdate.json()).item).toEqual(
      correctedItem,
    );

    const staleUpdate = await app.request(
      `/api/trips/${trip.id}/items/${created.id}`,
      {
        method: "PATCH",
        headers: {
          cookie,
          "content-type": "application/json",
          origin: "https://app.example.test",
          "idempotency-key": "reject-stale-flight-update",
        },
        body: body({ ...input, title: "Stale overwrite", expectedVersion: 3 }),
      },
    );
    expect(staleUpdate.status).toBe(409);
    expect(await staleUpdate.json()).toMatchObject({
      error: { code: "conflict", currentVersion: 4 },
    });

    const deletePlace = await app.request(`/api/trips/${trip.id}/places/${lax.id}`, {
      method: "DELETE",
      headers: {
        cookie,
        "content-type": "application/json",
        origin: "https://app.example.test",
        "idempotency-key": "reject-stale-place-delete",
      },
      body: body({ expectedVersion: lax.version }),
    });
    expect(deletePlace.status).toBe(409);
    expect(await deletePlace.json()).toMatchObject({
      error: { code: "conflict", currentVersion: 2 },
    });
    const referencedPlaceDelete = await app.request(
      `/api/trips/${trip.id}/places/${lax.id}`,
      {
        method: "DELETE",
        headers: {
          cookie,
          "content-type": "application/json",
          "idempotency-key": "reject-referenced-place-delete",
          origin: "https://app.example.test",
        },
        body: body({ expectedVersion: 2 }),
      },
    );
    expect(referencedPlaceDelete.status).toBe(409);
    expect(await referencedPlaceDelete.json()).toMatchObject({
      error: { code: "place_in_use" },
    });

    const audited = await app.request(`/api/trips/${trip.id}/skeleton`, {
      headers: { cookie },
    });
    const events = parseTripSkeletonResponse(await audited.json()).skeleton.events;
    expect(events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        "itinerary_item.created",
        "itinerary_item.locked",
        "itinerary_item.unlocked",
        "itinerary_item.updated",
      ]),
    );
    expect(events.every((event) => event.actorId.length > 0)).toBe(true);
    expect(JSON.stringify(events)).not.toContain("Window seat requested");
    expect(JSON.stringify(events)).not.toContain("Confirmed");

    const deleted = await app.request(
      `/api/trips/${trip.id}/items/${created.id}`,
      {
        method: "DELETE",
        headers: {
          cookie,
          "content-type": "application/json",
          origin: "https://app.example.test",
          "idempotency-key": "delete-cross-timezone-flight",
        },
        body: body({ expectedVersion: 4 }),
      },
    );
    expect(deleted.status).toBe(204);
    const replayedDelete = await app.request(
      `/api/trips/${trip.id}/items/${created.id}`,
      {
        method: "DELETE",
        headers: {
          cookie,
          "content-type": "application/json",
          origin: "https://app.example.test",
          "idempotency-key": "delete-cross-timezone-flight",
        },
        body: body({ expectedVersion: 4 }),
      },
    );
    expect(replayedDelete.status).toBe(204);
    const afterDelete = await app.request(`/api/trips/${trip.id}/skeleton`, {
      headers: { cookie },
    });
    expect(
      parseTripSkeletonResponse(await afterDelete.json()).skeleton.events.map(
        (event) => event.eventType,
      ),
    ).toContain("itinerary_item.deleted");
  });

  it("rejects DST gaps and requires an offset for repeated local times", async () => {
    const cookie = await login();
    const trip = await createTrip(cookie, {
      name: "美國夏令時間旅行",
      startDate: "2026-03-01",
      endDate: "2026-11-05",
      countryCodes: ["US"],
    });
    const place = await createPlace(cookie, trip.id, "create-los-angeles", {
      name: "Los Angeles",
      type: "other",
      address: null,
      latitude: 34.0522,
      longitude: -118.2437,
      timeZone: "America/Los_Angeles",
      sourceUrl: null,
      notes: null,
    });
    const item = (localDateTime: string, utcOffset?: string) => ({
      type: "free-time",
      title: "Local time check",
      notes: null,
      sourceUrl: null,
      money: null,
      endpoints: [
        {
          role: "start",
          countryStopId: trip.countryStops[0]!.id,
          placeId: place.id,
          localDateTime,
          timeZone: "America/Los_Angeles",
          ...(utcOffset ? { utcOffset } : {}),
        },
      ],
      details: { durationMinutes: 30 },
      constraints: [],
    });
    const create = async (key: string, payload: ReturnType<typeof item>) =>
      app.request(`/api/trips/${trip.id}/items`, {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/json",
          "idempotency-key": key,
          origin: "https://app.example.test",
        },
        body: body({
          ...payload,
          expectedTripVersion: await currentTripVersion(cookie, trip.id),
        }),
      });

    const missingTime = await create(
      "create-dst-gap",
      item("2026-03-08T02:30"),
    );
    expect(missingTime.status).toBe(400);
    expect(await missingTime.json()).toMatchObject({
      error: { code: "invalid_local_time" },
    });

    const repeatedTime = await create(
      "create-dst-overlap-without-offset",
      item("2026-11-01T01:30"),
    );
    expect(repeatedTime.status).toBe(400);
    expect(await repeatedTime.json()).toMatchObject({
      error: { code: "ambiguous_local_time" },
    });

    const resolved = await create(
      "create-dst-overlap-with-offset",
      item("2026-11-01T01:30", "-08:00"),
    );
    expect(resolved.status).toBe(201);
    expect(
      parseItineraryItemResponse(await resolved.json()).item.endpoints[0],
    ).toMatchObject({
      localDateTime: "2026-11-01T01:30",
      utcOffset: "-08:00",
      instant: "2026-11-01T09:30:00.000Z",
    });
  });

  it("rejects invalid item types, details, durations, currencies, and lodging endpoints", async () => {
    const cookie = await login();
    const trip = await createTrip(cookie);
    const firstPlace = await createPlace(cookie, trip.id, "validation-place-one", {
      name: "First place",
      type: "lodging",
      address: null,
      latitude: null,
      longitude: null,
      timeZone: "Asia/Tokyo",
      sourceUrl: null,
      notes: null,
    });
    const secondPlace = await createPlace(cookie, trip.id, "validation-place-two", {
      name: "Second place",
      type: "lodging",
      address: null,
      latitude: null,
      longitude: null,
      timeZone: "Asia/Tokyo",
      sourceUrl: null,
      notes: null,
    });
    const start = {
      role: "start",
      countryStopId: trip.countryStops[0]!.id,
      placeId: firstPlace.id,
      localDateTime: "2026-10-22T10:00",
      timeZone: "Asia/Tokyo",
    };
    const base = {
      type: "activity",
      title: "Validation target",
      notes: null,
      sourceUrl: null,
      money: null,
      endpoints: [start],
      details: {
        durationMinutes: 60,
        bookedBy: null,
        confirmationStatus: "unknown",
      },
      constraints: [],
    };
    const cases: Array<{ key: string; payload: Record<string, unknown> }> = [
      {
        key: "invalid-unknown-item-type",
        payload: { ...base, type: "mystery" },
      },
      {
        key: "invalid-details-shape",
        payload: { ...base, details: [] },
      },
      {
        key: "invalid-zero-duration",
        payload: { ...base, details: { ...base.details, durationMinutes: 0 } },
      },
      {
        key: "invalid-negative-duration",
        payload: { ...base, details: { ...base.details, durationMinutes: -30 } },
      },
      {
        key: "invalid-currency",
        payload: {
          ...base,
          money: { amountMinor: 1000, currency: "ZZZ" },
        },
      },
      {
        key: "invalid-lodging-endpoint",
        payload: {
          ...base,
          type: "lodging",
          endpoints: [
            start,
            {
              ...start,
              role: "end",
              placeId: secondPlace.id,
              localDateTime: "2026-10-23T10:00",
            },
          ],
          details: { bookedBy: null, confirmationCode: null },
        },
      },
    ];

    for (const invalid of cases) {
      const response = await app.request(`/api/trips/${trip.id}/items`, {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/json",
          "idempotency-key": invalid.key,
          origin: "https://app.example.test",
        },
        body: body({
          ...invalid.payload,
          expectedTripVersion: await currentTripVersion(cookie, trip.id),
        }),
      });
      expect(response.status, invalid.key).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: "validation_error" },
      });
    }
  });

  it("falls back from Place to Country Stop and explicitly confirmed endpoint time zones", async () => {
    const cookie = await login();
    const japanTrip = await createTrip(cookie);
    expect(japanTrip.countryStops[0]?.timeZone).toBe("Asia/Tokyo");
    const japanPlace = await createPlace(cookie, japanTrip.id, "japan-place-without-zone", {
      name: "Japan place without time zone",
      type: "activity",
      address: null,
      latitude: null,
      longitude: null,
      timeZone: null,
      sourceUrl: null,
      notes: null,
    });

    async function createActivity(
      tripId: string,
      countryStopId: string,
      placeId: string,
      timeZone: string,
      key: string,
    ) {
      const response = await app.request(`/api/trips/${tripId}/items`, {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/json",
          "idempotency-key": key,
          origin: "https://app.example.test",
        },
        body: body({
          expectedTripVersion: await currentTripVersion(cookie, tripId),
          type: "activity",
          title: key,
          notes: null,
          sourceUrl: null,
          money: null,
          endpoints: [{
            role: "start",
            countryStopId,
            placeId,
            localDateTime: "2026-10-22T10:00",
            timeZone,
          }],
          details: {
            durationMinutes: 60,
            bookedBy: null,
            confirmationStatus: "unknown",
          },
          constraints: [],
        }),
      });
      expect(response.status).toBe(201);
      return parseItineraryItemResponse(await response.json()).item;
    }

    const stopFallback = await createActivity(
      japanTrip.id,
      japanTrip.countryStops[0]!.id,
      japanPlace.id,
      "Asia/Tokyo",
      "country-stop-time-zone-fallback",
    );
    expect(stopFallback.endpoints[0]).toMatchObject({
      timeZone: "Asia/Tokyo",
      utcOffset: "+09:00",
      instant: "2026-10-22T01:00:00.000Z",
    });

    const usTrip = await createTrip(cookie, {
      name: "Explicit endpoint time zone",
      startDate: "2026-10-21",
      endDate: "2026-10-27",
      countryCodes: ["US"],
    });
    expect(usTrip.countryStops[0]?.timeZone).toBeNull();
    for (const [key, timeZone] of [
      ["reject-place-fixed-offset", "-07:00"],
      ["reject-place-date-time-zone", "2026-10-22T10:00-07:00"],
    ] as const) {
      const invalidPlaceTimeZone = await app.request(
        `/api/trips/${usTrip.id}/places`,
        {
          method: "POST",
          headers: {
            cookie,
            "content-type": "application/json",
            "idempotency-key": key,
            origin: "https://app.example.test",
          },
          body: body({
            expectedTripVersion: await currentTripVersion(cookie, usTrip.id),
            name: "Offset-only venue",
            type: "activity",
            address: null,
            latitude: 34.0522,
            longitude: -118.2437,
            timeZone,
            sourceUrl: null,
            notes: null,
          }),
        },
      );
      expect(invalidPlaceTimeZone.status).toBe(400);
      expect(await invalidPlaceTimeZone.json()).toMatchObject({
        error: { code: "validation_error" },
      });
    }

    const usPlace = await createPlace(cookie, usTrip.id, "us-place-without-zone", {
      name: "US place without time zone",
      type: "activity",
      address: null,
      latitude: null,
      longitude: null,
      timeZone: null,
      sourceUrl: null,
      notes: null,
    });
    for (const [key, timeZone] of [
      ["reject-fixed-offset-time-zone", "-07:00"],
      ["reject-date-time-as-time-zone", "2026-10-22T10:00-07:00"],
    ] as const) {
      const invalidTimeZoneEndpoint = await app.request(
        `/api/trips/${usTrip.id}/items`,
        {
          method: "POST",
          headers: {
            cookie,
            "content-type": "application/json",
            "idempotency-key": key,
            origin: "https://app.example.test",
          },
          body: body({
            expectedTripVersion: await currentTripVersion(cookie, usTrip.id),
            type: "activity",
            title: "Only a named IANA time zone is valid",
            notes: null,
            sourceUrl: null,
            money: null,
            endpoints: [{
              role: "start",
              countryStopId: usTrip.countryStops[0]!.id,
              placeId: usPlace.id,
              localDateTime: "2026-10-22T10:00",
              timeZone,
            }],
            details: {
              durationMinutes: 60,
              bookedBy: null,
              confirmationStatus: "unknown",
            },
            constraints: [],
          }),
        },
      );
      expect(invalidTimeZoneEndpoint.status).toBe(400);
      expect(await invalidTimeZoneEndpoint.json()).toMatchObject({
        error: { code: "validation_error" },
      });
    }

    const explicitEndpoint = await createActivity(
      usTrip.id,
      usTrip.countryStops[0]!.id,
      usPlace.id,
      "America/Los_Angeles",
      "explicit-endpoint-time-zone",
    );
    expect(explicitEndpoint.endpoints[0]).toMatchObject({
      timeZone: "America/Los_Angeles",
      utcOffset: "-07:00",
      instant: "2026-10-22T17:00:00.000Z",
    });
  });

  it("persists every item type with only its relevant details", async () => {
    const cookie = await login();
    const trip = await createTrip(cookie);
    const osaka = await createPlace(cookie, trip.id, "create-osaka-place", {
      name: "大阪站",
      type: "station",
      address: "大阪",
      latitude: 34.7025,
      longitude: 135.4959,
      timeZone: "Asia/Tokyo",
      sourceUrl: null,
      notes: null,
    });
    const kyoto = await createPlace(cookie, trip.id, "create-kyoto-place", {
      name: "京都站",
      type: "station",
      address: "京都",
      latitude: 34.9858,
      longitude: 135.7588,
      timeZone: "Asia/Tokyo",
      sourceUrl: null,
      notes: null,
    });
    const stopId = trip.countryStops[0]!.id;
    const endpoint = (
      role: "start" | "end",
      placeId: string,
      localDateTime: string,
    ) => ({
      role,
      countryStopId: stopId,
      placeId,
      localDateTime,
      timeZone: "Asia/Tokyo",
    });
    const items = [
      {
        type: "flight",
        title: "Arrival flight",
        endpoints: [
          endpoint("start", osaka.id, "2026-10-21T08:00"),
          endpoint("end", osaka.id, "2026-10-21T10:00"),
        ],
        details: {
          carrier: "Example Air",
          serviceNumber: "EX100",
          confirmationNotes: null,
        },
        constraints: [
          { type: "fixed_time", status: "confirmed", minimumBufferMinutes: null },
        ],
      },
      {
        type: "lodging",
        title: "Osaka lodging",
        endpoints: [
          endpoint("start", osaka.id, "2026-10-21T15:00"),
          endpoint("end", osaka.id, "2026-10-23T10:00"),
        ],
        details: { bookedBy: "Owner", confirmationCode: "OSAKA-1" },
        constraints: [
          { type: "immovable", status: "confirmed", minimumBufferMinutes: null },
        ],
      },
      {
        type: "transport",
        title: "Osaka to Kyoto",
        endpoints: [
          endpoint("start", osaka.id, "2026-10-23T11:00"),
          endpoint("end", kyoto.id, "2026-10-23T13:00"),
        ],
        details: { mode: "train", ticketInfo: "Reserved seats" },
        constraints: [
          { type: "minimum_buffer", status: "unknown", minimumBufferMinutes: 30 },
        ],
      },
      {
        type: "reservation",
        title: "Dinner reservation",
        endpoints: [endpoint("start", kyoto.id, "2026-10-23T18:00")],
        details: {
          durationMinutes: 90,
          bookedBy: "Owner",
          confirmationStatus: "confirmed",
        },
        constraints: [
          { type: "fixed_time", status: "conflicted", minimumBufferMinutes: null },
        ],
      },
      {
        type: "meal",
        title: "Lunch",
        endpoints: [endpoint("start", kyoto.id, "2026-10-24T12:00")],
        details: {
          durationMinutes: 60,
          bookedBy: null,
          confirmationStatus: "unknown",
        },
        constraints: [],
      },
      {
        type: "activity",
        title: "Museum ticket",
        endpoints: [endpoint("start", kyoto.id, "2026-10-25T10:00")],
        details: {
          durationMinutes: 120,
          bookedBy: "Owner",
          confirmationStatus: "confirmed",
        },
        constraints: [],
      },
      {
        type: "free-time",
        title: "Open morning",
        endpoints: [endpoint("start", kyoto.id, "2026-10-26T09:00")],
        details: { durationMinutes: 180 },
        constraints: [],
      },
    ];
    const created = [];
    for (const [index, item] of items.entries()) {
      const response = await app.request(`/api/trips/${trip.id}/items`, {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/json",
          "idempotency-key": `create-item-type-${index}`,
          origin: "https://app.example.test",
        },
        body: body({
          expectedTripVersion: await currentTripVersion(cookie, trip.id),
          ...item,
          notes: null,
          sourceUrl: null,
          money:
            item.type === "free-time"
              ? null
              : { amountMinor: 1234 + index, currency: "JPY" },
        }),
      });

      expect(response.status).toBe(201);
      created.push(parseItineraryItemResponse(await response.json()).item);
    }

    const response = await app.request(`/api/trips/${trip.id}/skeleton`, {
      headers: { cookie },
    });
    const skeleton = parseTripSkeletonResponse(await response.json()).skeleton;
    expect(skeleton.items.map((item) => item.type)).toEqual([
      "flight",
      "lodging",
      "transport",
      "reservation",
      "meal",
      "activity",
      "free-time",
    ]);
    expect(skeleton.items[2]?.constraints[0]).toMatchObject({
      type: "minimum_buffer",
      status: "unknown",
      minimumBufferMinutes: 30,
    });
    expect(skeleton.items[3]?.constraints[0]?.status).toBe("conflicted");
    expect(
      skeleton.days
        .find((day) => day.date === "2026-10-23")
        ?.entries.map((entry) => entry.itemId),
    ).toEqual([created[1]!.id, created[2]!.id, created[3]!.id]);
    expect(skeleton.tripInformationItemIds).toEqual([
      created[0]!.id,
      created[1]!.id,
      created[2]!.id,
    ]);
    expect(skeleton.items[0]?.money).toEqual({
      amountMinor: 1234,
      currency: "JPY",
    });
  });
  it("denies a signed-in nonmember and lets an accepted editor add content", async () => {
    const ownerCookie = await login();
    const trip = await createTrip(ownerCookie);
    const invite = await app.request(`/api/trips/${trip.id}/invites`, {
      method: "POST",
      headers: {
        cookie: ownerCookie,
        "content-type": "application/json",
        "idempotency-key": "invite-skeleton-editor",
        origin: "https://app.example.test",
      },
      body: body({ email: "editor@example.test" }),
    });
    expect(invite.status).toBe(201);
    await emailWorker.runOnce();
    const inviteLink = email.invites.at(-1)?.url;
    const inviteToken =
      inviteLink &&
      new URLSearchParams(new URL(inviteLink).hash.slice(1)).get("inviteToken");
    if (!inviteToken) throw new Error("Invite token missing");

    const editorCookie = await login("editor@example.test", inviteToken);
    const denied = await app.request(`/api/trips/${trip.id}/skeleton`, {
      headers: { cookie: editorCookie },
    });
    expect(denied.status).toBe(404);
    expect(await denied.json()).toMatchObject({
      error: { code: "trip_not_found" },
    });

    const accepted = await app.request("/api/invites/accept", {
      method: "POST",
      headers: {
        cookie: editorCookie,
        "content-type": "application/json",
        "idempotency-key": "accept-skeleton-editor",
        origin: "https://app.example.test",
      },
      body: body({ token: inviteToken }),
    });
    expect(accepted.status).toBe(200);

    const editorPlace = await createPlace(
      editorCookie,
      trip.id,
      "editor-creates-place",
      {
        name: "Editor place",
        type: "other",
        address: null,
        latitude: null,
        longitude: null,
        timeZone: null,
        sourceUrl: null,
        notes: null,
      },
    );
    expect(editorPlace.tripId).toBe(trip.id);
    const secondEditorPlace = await createPlace(
      editorCookie,
      trip.id,
      "editor-creates-second-place",
      {
        name: "Second editor place",
        type: "other",
        address: null,
        latitude: null,
        longitude: null,
        timeZone: null,
        sourceUrl: null,
        notes: null,
      },
    );

    const editorUser = await database.selectFrom("users")
      .select("id")
      .where("email", "=", "editor@example.test")
      .executeTakeFirstOrThrow();
    const replayProbeInput = {
      name: "Editor place updated",
      type: "other",
      address: null,
      latitude: null,
      longitude: null,
      timeZone: null,
      sourceUrl: null,
      notes: "Private to the original trip",
      expectedVersion: 1,
    };
    const originalTripUpdate = await app.request(
      `/api/trips/${trip.id}/places/${editorPlace.id}`,
      {
        method: "PATCH",
        headers: {
          cookie: editorCookie,
          "content-type": "application/json",
          "idempotency-key": "trip-scoped-place-replay",
          origin: "https://app.example.test",
        },
        body: body(replayProbeInput),
      },
    );
    expect(originalTripUpdate.status).toBe(200);
    const sameTripDifferentTarget = await app.request(
      `/api/trips/${trip.id}/places/${secondEditorPlace.id}`,
      {
        method: "PATCH",
        headers: {
          cookie: editorCookie,
          "content-type": "application/json",
          "idempotency-key": "trip-scoped-place-replay",
          origin: "https://app.example.test",
        },
        body: body({
          ...replayProbeInput,
          name: "Second editor place updated",
        }),
      },
    );
    expect(sameTripDifferentTarget.status).toBe(200);
    expect(parsePlaceResponse(await sameTripDifferentTarget.json()).place).toMatchObject({
      id: secondEditorPlace.id,
      name: "Second editor place updated",
      version: 2,
    });
    const editorOwnedTrip = await createTrip(editorCookie, {
      name: "Editor-owned replay boundary trip",
      startDate: "2026-11-01",
      endDate: "2026-11-03",
      countryCodes: ["JP"],
    });
    await database.updateTable("trip_members")
      .set({ removed_at: new Date("2026-09-28T12:00:00.000Z") })
      .where("trip_id", "=", trip.id)
      .where("user_id", "=", editorUser.id)
      .execute();
    const crossTripReplay = await app.request(
      `/api/trips/${editorOwnedTrip.id}/places/${editorPlace.id}`,
      {
        method: "PATCH",
        headers: {
          cookie: editorCookie,
          "content-type": "application/json",
          "idempotency-key": "trip-scoped-place-replay",
          origin: "https://app.example.test",
        },
        body: body(replayProbeInput),
      },
    );
    expect(crossTripReplay.status).toBe(404);
    expect(await crossTripReplay.json()).toMatchObject({
      error: { code: "place_not_found" },
    });
    await database.updateTable("trip_members")
      .set({ removed_at: null })
      .where("trip_id", "=", trip.id)
      .where("user_id", "=", editorUser.id)
      .execute();
    const expectedTripVersion = await currentTripVersion(editorCookie, trip.id);
    let mutationSettled = false;
    async function waitForMembershipLockWait() {
      for (let attempt = 0; attempt < 1_000; attempt += 1) {
        if (mutationSettled) {
          throw new Error("Editor mutation settled without waiting for membership authorization");
        }
        const result = await sql<{ waiting: boolean }>`
          select exists (
            select 1
            from pg_stat_activity
            where datname = current_database()
              and pid <> pg_backend_pid()
              and wait_event_type = 'Lock'
              and query ilike '%trip_members%'
          ) as waiting
        `.execute(database);
        if (result.rows[0]?.waiting) return;
      }
      throw new Error("Editor mutation did not reach the membership row lock");
    }
    let mutationPromise: Promise<Response> | undefined;
    await database.transaction().execute(async (transaction) => {
      await transaction.selectFrom("trip_members")
        .select("user_id")
        .where("trip_id", "=", trip.id)
        .where("user_id", "=", editorUser.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      mutationPromise = Promise.resolve(app.request(`/api/trips/${trip.id}/places`, {
        method: "POST",
        headers: {
          cookie: editorCookie,
          "content-type": "application/json",
          "idempotency-key": "removed-editor-cannot-create-place",
          origin: "https://app.example.test",
        },
        body: body({
          expectedTripVersion,
          name: "Must not be created after removal",
          type: "other",
          address: null,
          latitude: null,
          longitude: null,
          timeZone: null,
          sourceUrl: null,
          notes: null,
        }),
      }));
      const startedMutation = mutationPromise;
      void startedMutation.then(
        () => { mutationSettled = true; },
        () => { mutationSettled = true; },
      );
      await waitForMembershipLockWait();
      await transaction.updateTable("trip_members")
        .set({ removed_at: new Date("2026-09-28T12:01:00.000Z") })
        .where("trip_id", "=", trip.id)
        .where("user_id", "=", editorUser.id)
        .execute();
    });
    if (!mutationPromise) throw new Error("Expected blocked editor mutation");
    const removedEditorMutation = await mutationPromise;
    expect(removedEditorMutation.status).toBe(404);
    expect(await removedEditorMutation.json()).toMatchObject({
      error: { code: "trip_not_found" },
    });
    const forbiddenPlace = await database.selectFrom("trip_places")
      .select("id")
      .where("trip_id", "=", trip.id)
      .where("name", "=", "Must not be created after removal")
      .executeTakeFirst();
    expect(forbiddenPlace).toBeUndefined();
  });

  it("creates updates and deletes versioned constraint states", async () => {
    const cookie = await login();
    const trip = await createTrip(cookie);
    const place = await createPlace(cookie, trip.id, "constraint-place", {
      name: "Constraint place",
      type: "activity",
      address: null,
      latitude: null,
      longitude: null,
      timeZone: "Asia/Tokyo",
      sourceUrl: null,
      notes: null,
    });
    const itemResponse = await app.request(`/api/trips/${trip.id}/items`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "idempotency-key": "constraint-item",
        origin: "https://app.example.test",
      },
      body: body({
        expectedTripVersion: await currentTripVersion(cookie, trip.id),
        type: "activity",
        title: "Flexible activity",
        notes: null,
        sourceUrl: null,
        money: null,
        endpoints: [
          {
            role: "start",
            countryStopId: trip.countryStops[0]!.id,
            placeId: place.id,
            localDateTime: "2026-10-24T10:00",
            timeZone: "Asia/Tokyo",
          },
        ],
        details: {
          durationMinutes: 90,
          bookedBy: null,
          confirmationStatus: "unknown",
        },
        constraints: [],
      }),
    });
    const item = parseItineraryItemResponse(await itemResponse.json()).item;

    const createdResponse = await app.request(
      `/api/trips/${trip.id}/items/${item.id}/constraints`,
      {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/json",
          "idempotency-key": "create-minimum-buffer",
          origin: "https://app.example.test",
        },
        body: body({
          expectedItemVersion: 1,
          type: "minimum_buffer",
          status: "unknown",
          minimumBufferMinutes: 45,
        }),
      },
    );
    expect(createdResponse.status).toBe(201);
    const withConstraint = parseItineraryItemResponse(
      await createdResponse.json(),
    ).item;
    expect(withConstraint.version).toBe(2);
    expect(withConstraint.constraints[0]).toMatchObject({
      status: "unknown",
      minimumBufferMinutes: 45,
      version: 1,
    });
    const constraint = withConstraint.constraints[0]!;

    const updatedResponse = await app.request(
      `/api/trips/${trip.id}/items/${item.id}/constraints/${constraint.id}`,
      {
        method: "PATCH",
        headers: {
          cookie,
          "content-type": "application/json",
          origin: "https://app.example.test",
          "idempotency-key": "update-minimum-buffer",
        },
        body: body({
          expectedItemVersion: 2,
          expectedVersion: 1,
          type: "minimum_buffer",
          status: "conflicted",
          minimumBufferMinutes: 45,
        }),
      },
    );
    expect(updatedResponse.status).toBe(200);
    const updated = parseItineraryItemResponse(await updatedResponse.json()).item;
    expect(updated).toMatchObject({ version: 3 });
    expect(updated.constraints[0]).toMatchObject({
      status: "conflicted",
      version: 2,
    });

    const lock = await app.request(`/api/trips/${trip.id}/items/${item.id}/lock`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        origin: "https://app.example.test",
        "idempotency-key": "lock-constraint-item",
      },
      body: body({ expectedVersion: 3 }),
    });
    expect(lock.status).toBe(200);

    const unlock = await app.request(
      `/api/trips/${trip.id}/items/${item.id}/unlock`,
      {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/json",
          origin: "https://app.example.test",
          "idempotency-key": "unlock-constraint-item",
        },
        body: body({ expectedVersion: 4 }),
      },
    );
    expect(unlock.status).toBe(200);

    const staleItem = await app.request(
      `/api/trips/${trip.id}/items/${item.id}/constraints/${constraint.id}`,
      {
        method: "PATCH",
        headers: {
          cookie,
          "content-type": "application/json",
          origin: "https://app.example.test",
          "idempotency-key": "reject-stale-constraint-item",
        },
        body: body({
          expectedItemVersion: 3,
          expectedVersion: 2,
          type: "minimum_buffer",
          status: "confirmed",
          minimumBufferMinutes: 45,
        }),
      },
    );
    expect(staleItem.status).toBe(409);
    expect(await staleItem.json()).toMatchObject({
      error: { code: "conflict", currentVersion: 5 },
    });

    const stale = await app.request(
      `/api/trips/${trip.id}/items/${item.id}/constraints/${constraint.id}`,
      {
        method: "PATCH",
        headers: {
          cookie,
          "content-type": "application/json",
          origin: "https://app.example.test",
          "idempotency-key": "reject-stale-constraint-version",
        },
        body: body({
          expectedItemVersion: 5,
          expectedVersion: 1,
          type: "minimum_buffer",
          status: "confirmed",
          minimumBufferMinutes: 45,
        }),
      },
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: { code: "conflict", currentVersion: 2 },
    });

    const deletedResponse = await app.request(
      `/api/trips/${trip.id}/items/${item.id}/constraints/${constraint.id}`,
      {
        method: "DELETE",
        headers: {
          cookie,
          "content-type": "application/json",
          origin: "https://app.example.test",
          "idempotency-key": "delete-minimum-buffer",
        },
        body: body({ expectedItemVersion: 5, expectedVersion: 2 }),
      },
    );
    expect(deletedResponse.status).toBe(200);
    const withoutConstraint = parseItineraryItemResponse(
      await deletedResponse.json(),
    ).item;
    expect(withoutConstraint).toMatchObject({ version: 6, constraints: [] });
  });
});
