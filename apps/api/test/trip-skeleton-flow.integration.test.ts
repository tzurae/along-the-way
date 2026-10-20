import { PostgresCollaborationModule } from "../src/private-trips/postgres-collaboration-module";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import { FileMigrationProvider, Migrator } from "kysely/migration";
import type { Hono } from "hono";
import {
  parseItineraryItemResponse,
  parsePlaceResponse,
  parseTripSkeletonResponse,
  type CreateItineraryItemInput,
  type PlaceDto,
} from "@along-the-way/contracts/trip-skeleton";
import { parseTripHistoryResponse, parseTripResponse } from "@along-the-way/contracts/private-trips";
import {
  parseTripPlaceListResponse,
  parseTripPlaceResponse,
} from "@along-the-way/contracts/trip-places";

import { createApp } from "../src/app";
import { PostgresPlaceDetailModule } from "../src/place-details/postgres-place-detail-module";
import { packagedPhotoRoot } from "../src/place-details/photo-assets";
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
import { unrelatedDayPlanModule } from "./day-plan-test-support";
import { unrelatedDiscoveryModule } from "./discovery-test-support";
import { tripFlights } from "./travel-test-support";

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
  let tripSkeleton: PostgresTripSkeletonModule;

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
        trip_place_must_items,
        trip_place_excluded_days,
        trip_place_desired_days,
        trip_place_votes,
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
    tripSkeleton = new PostgresTripSkeletonModule({ database, now });
    app = createApp({
      placeDetails: new PostgresPlaceDetailModule({ database, assetRoot: packagedPhotoRoot }),
      collaboration: new PostgresCollaborationModule(database),
      dayPlans: unrelatedDayPlanModule,
      discovery: unrelatedDiscoveryModule,
      identityAccess,
      rateLimiter: new PostgresRateLimiter(database, "trip-skeleton-rate-secret-at-least-32-bytes", now),
      readiness: new PostgresReadinessProbe(database, now),
      siteAddress: "https://app.example.test",
      tripSkeleton,
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
      headers: { "content-type": "application/json", origin: "https://app.example.test" },
      body: body({ email: address }),
    });
    expect(requested.status).toBe(202);
    await emailWorker.runOnce();
    const link = email.magicLinks.at(-1)?.url;
    const token = link && new URLSearchParams(new URL(link).hash.slice(1)).get("magicToken");
    if (!token) throw new Error("Magic link token missing");
    const consumed = await app.request("/api/auth/magic-links/consume", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://app.example.test" },
      body: body({ token, confirm: true }),
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
      body: body({ ...input, flights: tripFlights(input.startDate, input.endDate) }),
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
  ): Promise<PlaceDto> {
    const response = await app.request(`/api/trips/${tripId}/trip-places`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "idempotency-key": key,
        origin: "https://app.example.test",
      },
      body: body({
        method: "manual",
        name: input.name,
        type: input.type,
        address: input.address ?? null,
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
        timeZone: input.timeZone ?? null,
        sourceUrl: input.sourceUrl ?? null,
        originalNote: input.notes ?? null,
      }),
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const tripPlace = parseTripPlaceResponse(await response.json()).tripPlace;
    const place = (await readSkeleton(cookie, tripId)).places
      .find((candidate) => candidate.id === tripPlace.legacyPlaceId);
    if (!place) throw new Error("Manual wishlist place is missing its retained skeleton mirror");
    return place;
  }

  async function seedItem(
    userId: string,
    tripId: string,
    input: CreateItineraryItemInput,
  ) {
    return database.transaction().execute((transaction) =>
      tripSkeleton.createItemInTransaction(transaction, userId, tripId, input));
  }


  async function mutate(
    cookie: string,
    path: string,
    key: string,
    payload: unknown,
    method = "POST",
  ) {
    return app.request(path, {
      method,
      headers: {
        cookie,
        "content-type": "application/json",
        "idempotency-key": key,
        origin: "https://app.example.test",
      },
      body: body(payload),
    });
  }

  async function readSkeleton(cookie: string, tripId: string) {
    const response = await app.request(`/api/trips/${tripId}/skeleton`, {
      headers: { cookie },
    });
    expect(response.status).toBe(200);
    return parseTripSkeletonResponse(await response.json()).skeleton;
  }

  async function joinMember(
    ownerCookie: string,
    tripId: string,
    address: string,
    key: string,
    existingCookie?: string,
  ) {
    const invitation = await mutate(ownerCookie, `/api/trips/${tripId}/invites`, key, {
      email: address,
    });
    expect(invitation.status).toBe(201);
    await emailWorker.runOnce();
    const link = email.invites.at(-1)?.url;
    const token = link && new URLSearchParams(new URL(link).hash.slice(1)).get("inviteToken");
    if (!token) throw new Error("Invite token missing");
    const cookie = existingCookie ?? await login(address);
    const accepted = await mutate(cookie, "/api/invites/accept", `accept-${key}`, { token });
    expect(accepted.status).toBe(200);
    const member = parseTripResponse(await accepted.json()).trip.members
      .find((candidate) => candidate.email === address)!;
    return { cookie, member };
  }

  it.each([
    "flights", "outbound", "return",
    ...(["outbound", "return"] as const).flatMap((side) =>
      ["serviceNumber", "departureAirport", "arrivalAirport", "departureAirport.name", "departureAirport.timeZone",
        "arrivalAirport.name", "arrivalAirport.timeZone", "departureLocalDateTime", "arrivalLocalDateTime"].map((field) => `${side}.${field}`)),
  ])("refuses missing %s without leaving any trip content behind", async (missing) => {
    const cookie = await login();
    const input: Record<string, unknown> = { name: "Atomic flight validation", startDate: "2026-10-21", endDate: "2026-10-27",
      countryCodes: ["JP"], flights: tripFlights() };
    const path = missing === "flights" ? ["flights"] : ["flights", ...missing.split(".")];
    let target = input;
    for (const field of path.slice(0, -1)) target = target[field] as Record<string, unknown>;
    delete target[path.at(-1)!];
    const response = await mutate(cookie, "/api/trips", "missing-flight-field", input);
    expect(response.status).toBe(400);
    const listed = await app.request("/api/trips", { headers: { cookie } });
    expect(await listed.json()).toEqual({ trips: [] });
    // These tables are not individually listable without a trip; inspect residues explicitly.
    for (const table of ["trips", "places", "itinerary_items", "itinerary_endpoints", "trip_members", "trip_days", "trip_country_stops", "mutation_requests"] as const) {
      expect(await database.selectFrom(table).selectAll().execute(), table).toEqual([]);
    }
  });

  it("rolls back both flights and airports when the return departs before outbound arrival", async () => {
    const cookie = await login();
    const flights = tripFlights();
    flights.return.departureLocalDateTime = "2026-10-21T05:30";
    flights.return.arrivalLocalDateTime = "2026-10-21T07:00";
    const response = await mutate(cookie, "/api/trips", "overlapping-flights", {
      name: "Overlapping flights", startDate: "2026-10-21", endDate: "2026-10-27", countryCodes: ["JP"], flights,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "flight_order" } });
    for (const table of ["trips", "places", "itinerary_items", "itinerary_endpoints", "trip_members", "trip_days", "trip_country_stops", "mutation_requests"] as const) {
      expect(await database.selectFrom(table).selectAll().execute(), table).toEqual([]);
    }
  });

  it("accepts legacy name-and-zone airports, creates a shared pair atomically and replays old flightless bodies", async () => {
    const cookie = await login();
    const flights = tripFlights();
    flights.return.departureAirport.name = "  FIXTURE DESTINATION AIRPORT  ";
    const input = { name: "Shared flights", startDate: "2026-10-21", endDate: "2026-10-27", countryCodes: ["JP"] };
    const response = await mutate(cookie, "/api/trips", "shared-flight-pair", { ...input, flights });
    expect(response.status).toBe(201);
    const trip = parseTripResponse(await response.json()).trip;
    const skeleton = await readSkeleton(cookie, trip.id);
    expect(skeleton.items.map((item) => item.title).sort()).toEqual(["FIXTURE-OUT", "FIXTURE-RETURN"]);
    expect(skeleton.places.map((place) => ({ name: place.name, type: place.type })).sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "Fixture destination airport", type: "airport" }, { name: "Fixture home airport", type: "airport" },
    ]);
    const outbound = skeleton.items.find((item) => item.title === "FIXTURE-OUT")!;
    const returning = skeleton.items.find((item) => item.title === "FIXTURE-RETURN")!;
    expect(outbound.participants?.map((member) => member.memberId)).toEqual([trip.members[0]!.id]);
    expect(returning.participants).toEqual(outbound.participants);
    expect(outbound.endpoints.find((endpoint) => endpoint.role === "start")?.countryStopId).toBeNull();
    expect(outbound.endpoints.find((endpoint) => endpoint.role === "end")?.countryStopId).toBe(trip.countryStops[0]!.id);
    expect(returning.endpoints.find((endpoint) => endpoint.role === "start")).toMatchObject({
      countryStopId: trip.countryStops[0]!.id, placeId: outbound.endpoints.find((endpoint) => endpoint.role === "end")!.placeId,
    });
    expect(returning.endpoints.find((endpoint) => endpoint.role === "end")?.countryStopId).toBeNull();
    const wishlist = await app.request(`/api/trips/${trip.id}/trip-places`, { headers: { cookie } });
    expect(parseTripPlaceListResponse(await wishlist.json()).tripPlaces).toEqual([]);
    expect(await database.selectFrom("places").select("travel_only").where("trip_id", "=", trip.id).execute())
      .toEqual([{ travel_only: true }, { travel_only: true }]);
    const replay = await mutate(cookie, "/api/trips", "shared-flight-pair", input);
    expect(replay.status).toBe(201);
    expect(parseTripResponse(await replay.json()).trip).toEqual(trip);
    expect(await readSkeleton(cookie, trip.id)).toEqual(skeleton);
  });

  it("accepts a blank service number, derives the route title and persists airport coordinates", async () => {
    const cookie = await login();
    const flights = tripFlights();
    flights.outbound.serviceNumber = "";
    flights.outbound.departureAirport = {
      name: "TPE · Taiwan Taoyuan International Airport",
      timeZone: "Asia/Taipei",
      latitude: 25.0777,
      longitude: 121.233,
    };
    flights.outbound.arrivalAirport = {
      name: "KIX · Kansai International Airport",
      timeZone: "Asia/Tokyo",
      latitude: 34.4273,
      longitude: 135.244,
    };
    flights.outbound.arrivalLocalDateTime = "2026-10-21T06:30";
    flights.return.departureAirport = { ...flights.outbound.arrivalAirport };
    flights.return.arrivalAirport = { ...flights.outbound.departureAirport };

    const response = await mutate(cookie, "/api/trips", "coordinate-flight-pair", {
      name: "Located airports",
      startDate: "2026-10-21",
      endDate: "2026-10-27",
      countryCodes: ["JP"],
      flights,
    });
    expect(response.status).toBe(201);
    const trip = parseTripResponse(await response.json()).trip;
    const skeleton = await readSkeleton(cookie, trip.id);
    const outbound = skeleton.items.find((item) => item.title === "TPE → KIX");
    expect(outbound).toMatchObject({
      type: "flight",
      details: { serviceNumber: "", carrier: null },
    });
    expect(skeleton.places.find((place) => place.name.startsWith("TPE ·"))).toMatchObject({
      latitude: 25.0777,
      longitude: 121.233,
      timeZone: "Asia/Taipei",
    });
    expect(skeleton.places.find((place) => place.name.startsWith("KIX ·"))).toMatchObject({
      latitude: 34.4273,
      longitude: 135.244,
      timeZone: "Asia/Tokyo",
    });
  });

  it.each([
    ["one-sided", { latitude: 25.0777 }],
    ["latitude-range", { latitude: 91, longitude: 121.233 }],
    ["longitude-range", { latitude: 25.0777, longitude: 181 }],
  ])("rejects %s airport coordinates with 400", async (label, coordinates) => {
    const cookie = await login();
    const flights = tripFlights();
    flights.outbound.departureAirport = {
      ...flights.outbound.departureAirport,
      ...coordinates,
    };
    const response = await mutate(cookie, "/api/trips", `invalid-airport-coordinates-${label}`, {
      name: "Invalid airport coordinates",
      startDate: "2026-10-21",
      endDate: "2026-10-27",
      countryCodes: ["JP"],
      flights,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "validation_error" } });
  });


  it("edits overview flight fields without discarding item metadata and respects version, locks and retry", async () => {
    const cookie = await login();
    const trip = await createTrip(cookie);
    const flight = (await readSkeleton(cookie, trip.id)).items.find((item) => item.title === "FIXTURE-OUT")!;
    const enrichedResponse = await mutate(cookie, `/api/trips/${trip.id}/items/${flight.id}`, "enrich-flight", {
      ...flight, participantMemberIds: [trip.members[0]!.id], expectedVersion: flight.version,
      notes: "Keep these notes", sourceUrl: "https://example.test/booking", money: { amountMinor: 12345, currency: "JPY" },
      details: { ...flight.details, confirmationNotes: "Keep this booking reference" },
    }, "PATCH");
    expect(enrichedResponse.status).toBe(200);
    const enriched = parseItineraryItemResponse(await enrichedResponse.json()).item;
    const constrainedResponse = await mutate(cookie, `/api/trips/${trip.id}/items/${flight.id}/constraints`, "flight-buffer", {
      expectedItemVersion: enriched.version, type: "minimum_buffer", status: "confirmed", minimumBufferMinutes: 150,
    });
    const before = parseItineraryItemResponse(await constrainedResponse.json()).item;
    const sharedPlace = await createPlace(cookie, trip.id, "shared-flight-airport", {
      name: "Replacement airport", type: "airport", timeZone: "Asia/Tokyo", notes: "Do not rewrite this place",
    });
    await seedItem(trip.members[0]!.userId, trip.id, {
      type: "activity", title: "Airport observation deck", participantMemberIds: null,
      endpoints: [{ role: "start", countryStopId: trip.countryStops[0]!.id, placeId: sharedPlace.id,
        localDateTime: "2026-10-22T12:00", timeZone: "Asia/Tokyo" }],
      details: { durationMinutes: 60, bookedBy: null, confirmationStatus: null },
      constraints: [],
    });
    const payload = { ...tripFlights().outbound, serviceNumber: "UPDATED-OUT", carrier: "Shared airline",
      arrivalAirport: { name: "Replacement airport", timeZone: "Asia/Tokyo" }, expectedVersion: before.version };
    const updatedResponse = await mutate(cookie, `/api/trips/${trip.id}/flights/${flight.id}`, "overview-edit", payload, "PATCH");
    expect(updatedResponse.status).toBe(200);
    const updated = parseItineraryItemResponse(await updatedResponse.json()).item;
    expect(updated).toMatchObject({ title: "UPDATED-OUT", version: before.version + 1,
      notes: before.notes, sourceUrl: before.sourceUrl, money: before.money, participants: before.participants,
      constraints: before.constraints, details: { serviceNumber: "UPDATED-OUT", carrier: "Shared airline", confirmationNotes: "Keep this booking reference" } });
    expect(updated.endpoints.find((endpoint) => endpoint.role === "end")?.placeId).not.toBe(sharedPlace.id);
    expect((await readSkeleton(cookie, trip.id)).places.find((place) => place.id === sharedPlace.id)).toEqual(sharedPlace);
    const replay = await mutate(cookie, `/api/trips/${trip.id}/flights/${flight.id}`, "overview-edit", payload, "PATCH");
    expect(parseItineraryItemResponse(await replay.json()).item).toEqual(updated);
    expect((await mutate(cookie, `/api/trips/${trip.id}/flights/${flight.id}`, "overview-stale", payload, "PATCH")).status).toBe(409);
    const lockedResponse = await mutate(cookie, `/api/trips/${trip.id}/items/${flight.id}/lock`, "overview-lock", { expectedVersion: updated.version });
    const locked = parseItineraryItemResponse(await lockedResponse.json()).item;
    const beforeRejected = await readSkeleton(cookie, trip.id);
    const beforeHistory = await (await app.request(`/api/trips/${trip.id}/history`, { headers: { cookie } })).json();
    const rejected = await app.request(`/api/trips/${trip.id}/flights/${flight.id}`, {
      method: "PATCH",
      headers: { cookie, origin: "https://app.example.test", "content-type": "application/json",
        "idempotency-key": "overview-locked-reapply", "Conflict-Base-Version": String(before.version) },
      body: body({ ...payload, expectedVersion: locked.version }),
    });
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ error: { code: "item_locked" } });
    expect(await readSkeleton(cookie, trip.id)).toEqual(beforeRejected);
    expect(await (await app.request(`/api/trips/${trip.id}/history`, { headers: { cookie } })).json()).toEqual(beforeHistory);
  });

  it("hides active and former participant emails according to the requesting member", async () => {
    const ownerCookie = await login("participant-owner@example.test");
    const trip = await createTrip(ownerCookie);
    const editor = await joinMember(
      ownerCookie, trip.id, "participant-editor@example.test", "participant-editor",
    );
    const former = await joinMember(
      ownerCookie, trip.id, "participant-former@example.test", "participant-former",
    );
    const flight = (await readSkeleton(ownerCookie, trip.id)).items
      .find((item) => item.title === "FIXTURE-OUT")!;
    const created = await mutate(ownerCookie, `/api/trips/${trip.id}/items/${flight.id}`, "participant-private-item", {
      ...flight,
      participantMemberIds: [trip.members[0]!.id, editor.member.id, former.member.id],
      expectedVersion: flight.version,
    }, "PATCH");
    expect(created.status).toBe(200);
    const itemId = parseItineraryItemResponse(await created.json()).item.id;
    expect((await app.request(`/api/trips/${trip.id}/members/${former.member.userId}`, {
      method: "DELETE",
      headers: {
        cookie: ownerCookie,
        origin: "https://app.example.test",
        "idempotency-key": "remove-private-participant",
      },
    })).status).toBe(204);

    const editorParticipants = (await readSkeleton(editor.cookie, trip.id)).items
      .find((item) => item.id === itemId)!.participants!;
    expect(new Map(editorParticipants.map((participant) => [
      participant.memberId, [participant.email, participant.removed],
    ]))).toEqual(new Map([
      [trip.members[0]!.id, [null, false]],
      [editor.member.id, [editor.member.email, false]],
      [former.member.id, [null, true]],
    ]));
    const ownerParticipants = (await readSkeleton(ownerCookie, trip.id)).items
      .find((item) => item.id === itemId)!.participants!;
    expect(new Map(ownerParticipants.map((participant) => [
      participant.memberId, [participant.email, participant.removed],
    ]))).toEqual(new Map([
      [trip.members[0]!.id, [trip.members[0]!.email, false]],
      [editor.member.id, [editor.member.email, false]],
      [former.member.id, [null, true]],
    ]));
  });
  it("lets only the owner unlock an item and keeps locked flights immutable", async () => {
    const ownerCookie = await login();
    const trip = await createTrip(ownerCookie);
    const editor = await joinMember(ownerCookie, trip.id, "flight-lock-editor@example.test", "flight-lock-editor");
    const flight = (await readSkeleton(ownerCookie, trip.id)).items.find((item) => item.type === "flight")!;
    const lockedResponse = await mutate(ownerCookie, `/api/trips/${trip.id}/items/${flight.id}/lock`, "owner-lock-flight", {
      expectedVersion: flight.version,
    });
    expect(lockedResponse.status).toBe(200);
    const locked = parseItineraryItemResponse(await lockedResponse.json()).item;

    expect((await mutate(editor.cookie, `/api/trips/${trip.id}/items/${flight.id}/unlock`, "editor-unlock-flight", {
      expectedVersion: locked.version,
    })).status).toBe(403);
    expect((await mutate(ownerCookie, `/api/trips/${trip.id}/items/${flight.id}`, "owner-delete-locked-flight", {
      expectedVersion: locked.version,
    }, "DELETE")).status).toBe(409);
    expect((await mutate(editor.cookie, `/api/trips/${trip.id}/flights/${flight.id}`, "editor-edit-locked-flight", {
      ...tripFlights().outbound,
      expectedVersion: locked.version,
    }, "PATCH")).status).toBe(409);

    const unlockedResponse = await mutate(ownerCookie, `/api/trips/${trip.id}/items/${flight.id}/unlock`, "owner-unlock-flight", {
      expectedVersion: locked.version,
    });
    expect(unlockedResponse.status).toBe(200);
    const unlocked = parseItineraryItemResponse(await unlockedResponse.json()).item;
    expect((await mutate(ownerCookie, `/api/trips/${trip.id}/editors-can-schedule`, "allow-unlocked-flight-editor", {
      enabled: true,
    }, "PUT")).status).toBe(204);
    expect((await mutate(editor.cookie, `/api/trips/${trip.id}/flights/${flight.id}`, "editor-edit-unlocked-flight", {
      ...tripFlights().outbound,
      carrier: "Editor airline",
      expectedVersion: unlocked.version,
    }, "PATCH")).status).toBe(200);
  });


  it("adds missing flights to an old trip and creates, edits and deletes lodging without a wishlist hotel", async () => {
    const cookie = await login();
    const trip = await createTrip(cookie);
    for (const flight of (await readSkeleton(cookie, trip.id)).items) {
      expect((await mutate(cookie, `/api/trips/${trip.id}/items/${flight.id}`, `old-trip-${flight.id}`, { expectedVersion: flight.version }, "DELETE")).status).toBe(204);
    }
    const addedMember = await joinMember(cookie, trip.id, "travel-member@example.test", "travel-member");
    const first = await mutate(cookie, `/api/trips/${trip.id}/flights`, "missing-outbound", {
      ...tripFlights().outbound, expectedTripVersion: await currentTripVersion(cookie, trip.id),
    });
    expect(first.status).toBe(201);
    expect(parseItineraryItemResponse(await first.json()).item.participants?.map((member) => member.memberId).sort())
      .toEqual([trip.members[0]!.id, addedMember.member.id].sort());
    const second = await mutate(cookie, `/api/trips/${trip.id}/flights`, "missing-return", {
      ...tripFlights().return, expectedTripVersion: await currentTripVersion(cookie, trip.id),
    });
    expect(second.status).toBe(201);
    const payload = { hotel: { name: "Travel hotel", address: "Kyoto", latitude: 35, longitude: 135, timeZone: "Asia/Tokyo", sourceUrl: null },
      countryStopId: trip.countryStops[0]!.id, checkInLocalDateTime: "2026-10-21T15:00", checkOutLocalDateTime: "2026-10-27T10:00" };
    const createdResponse = await mutate(cookie, `/api/trips/${trip.id}/lodgings`, "hotel-create", {
      ...payload, expectedTripVersion: await currentTripVersion(cookie, trip.id),
    });
    expect(createdResponse.status).toBe(201);
    const hotel = parseItineraryItemResponse(await createdResponse.json()).item;
    expect(hotel.endpoints[0]?.placeId).toBe(hotel.endpoints[1]?.placeId);
    const editedResponse = await mutate(cookie, `/api/trips/${trip.id}/lodgings/${hotel.id}`, "hotel-edit", {
      ...payload, hotel: { ...payload.hotel, name: "  TRAVEL HOTEL " }, checkOutLocalDateTime: "2026-10-26T10:00", expectedVersion: hotel.version,
    }, "PATCH");
    expect(editedResponse.status).toBe(200);
    const edited = parseItineraryItemResponse(await editedResponse.json()).item;
    expect(edited.endpoints.find((endpoint) => endpoint.role === "end")).toMatchObject({
      placeId: hotel.endpoints[0]!.placeId, localDateTime: "2026-10-26T10:00",
    });
    expect(edited.participants).toEqual(hotel.participants);
    const invalid = await mutate(cookie, `/api/trips/${trip.id}/lodgings/${hotel.id}`, "hotel-invalid", {
      ...payload, checkOutLocalDateTime: "2026-10-21T14:00", expectedVersion: edited.version,
    }, "PATCH");
    expect(invalid.status).toBe(400);
    expect((await readSkeleton(cookie, trip.id)).items.find((item) => item.id === hotel.id)).toEqual(edited);
    expect((await mutate(cookie, `/api/trips/${trip.id}/items/${hotel.id}`, "hotel-delete", { expectedVersion: edited.version }, "DELETE")).status).toBe(204);
    expect((await readSkeleton(cookie, trip.id)).items.some((item) => item.id === hotel.id)).toBe(false);
    const wishlist = await app.request(`/api/trips/${trip.id}/trip-places`, { headers: { cookie } });
    expect(parseTripPlaceListResponse(await wishlist.json()).tripPlaces).toEqual([]);
    expect((await readSkeleton(cookie, trip.id)).places.filter((place) => place.type === "lodging").map((place) => place.name)).toEqual(["Travel hotel"]);
  });

  it("resolves repeated-hour travel endpoints with explicit offsets and retains untouched choices", async () => {
    const cookie = await login();
    const flights = tripFlights("2026-11-01", "2026-11-02", "America/New_York");
    flights.outbound.departureLocalDateTime = "2026-11-01T01:30";
    flights.outbound.arrivalLocalDateTime = "2026-11-01T01:45";
    const input = { name: "Repeated travel hour", startDate: "2026-11-01", endDate: "2026-11-02", countryCodes: ["US"], flights };
    const ambiguous = await mutate(cookie, "/api/trips", "ambiguous-travel", input);
    expect(ambiguous.status).toBe(400);
    expect(await ambiguous.json()).toMatchObject({ error: { code: "ambiguous_local_time" } });
    flights.outbound.departureUtcOffset = "-04:00";
    flights.outbound.arrivalUtcOffset = "-05:00";
    const created = await mutate(cookie, "/api/trips", "resolved-travel", input);
    expect(created.status).toBe(201);
    const trip = parseTripResponse(await created.json()).trip;
    const flight = (await readSkeleton(cookie, trip.id)).items.find((item) => item.title === "FIXTURE-OUT")!;
    expect(flight.endpoints.find((endpoint) => endpoint.role === "start")).toMatchObject({ utcOffset: "-04:00", instant: "2026-11-01T05:30:00.000Z" });
    expect(flight.endpoints.find((endpoint) => endpoint.role === "end")).toMatchObject({ utcOffset: "-05:00", instant: "2026-11-01T06:45:00.000Z" });
    const withoutOffsets = { ...flights.outbound, departureUtcOffset: undefined, arrivalUtcOffset: undefined };
    const retained = await mutate(cookie, `/api/trips/${trip.id}/flights/${flight.id}`, "retain-travel-offset", {
      ...withoutOffsets, carrier: "Updated carrier", expectedVersion: flight.version,
    }, "PATCH");
    expect(retained.status).toBe(200);
    const retainedFlight = parseItineraryItemResponse(await retained.json()).item;
    expect(retainedFlight.endpoints).toEqual(flight.endpoints);
    const changed = await mutate(cookie, `/api/trips/${trip.id}/flights/${flight.id}`, "change-travel-offset", {
      ...flights.outbound, departureLocalDateTime: "2026-11-01T01:40", departureUtcOffset: "-05:00", expectedVersion: retainedFlight.version,
    }, "PATCH");
    expect(changed.status).toBe(200);
    expect(parseItineraryItemResponse(await changed.json()).item.endpoints.find((endpoint) => endpoint.role === "start"))
      .toMatchObject({ utcOffset: "-05:00", instant: "2026-11-01T06:40:00.000Z" });
    const lodgingInput = { hotel: { name: "DST hotel", address: null, latitude: null, longitude: null, sourceUrl: null, timeZone: "America/New_York" },
      countryStopId: trip.countryStops[0]!.id, checkInLocalDateTime: "2026-11-01T01:15", checkOutLocalDateTime: "2026-11-01T01:45",
      checkInUtcOffset: "-04:00", checkOutUtcOffset: "-05:00" };
    const stay = await mutate(cookie, `/api/trips/${trip.id}/lodgings`, "dst-stay", {
      ...lodgingInput, expectedTripVersion: await currentTripVersion(cookie, trip.id),
    });
    expect(stay.status).toBe(201);
    const lodging = parseItineraryItemResponse(await stay.json()).item;
    expect(lodging.endpoints.find((endpoint) => endpoint.role === "start")?.instant).toBe("2026-11-01T05:15:00.000Z");
    const editedStay = await mutate(cookie, `/api/trips/${trip.id}/lodgings/${lodging.id}`, "dst-stay-edit", {
      ...lodgingInput, checkInLocalDateTime: "2026-11-01T01:30", checkInUtcOffset: "-05:00", expectedVersion: lodging.version,
    }, "PATCH");
    expect(editedStay.status).toBe(200);
    expect(parseItineraryItemResponse(await editedStay.json()).item.endpoints.find((endpoint) => endpoint.role === "start")?.instant)
      .toBe("2026-11-01T06:30:00.000Z");
  });

  it("rejects malformed nested travel facts with 400 instead of an internal error", async () => {
    const cookie = await login();
    const flights = tripFlights();
    const rejected = await mutate(cookie, "/api/trips", "invalid-airport-extra", {
      name: "Malformed airport", startDate: "2026-10-21", endDate: "2026-10-27", countryCodes: ["JP"],
      flights: { ...flights, outbound: { ...flights.outbound, departureAirport: { ...flights.outbound.departureAirport, address: 123 } } },
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: { code: "validation_error" } });
    expect(await database.selectFrom("trips").select("id").execute()).toEqual([]);
    const trip = await createTrip(cookie);
    const before = await readSkeleton(cookie, trip.id);
    const flight = before.items.find((item) => item.title === "FIXTURE-OUT")!;
    const badPatch = await mutate(cookie, `/api/trips/${trip.id}/flights/${flight.id}`, "invalid-airport-patch", {
      ...flights.outbound, departureAirport: { ...flights.outbound.departureAirport, address: 123 }, expectedVersion: flight.version,
    }, "PATCH");
    expect(badPatch.status).toBe(400);
    for (const extra of [{ notes: 123 }, { address: 123 }]) {
      const badHotel = await mutate(cookie, `/api/trips/${trip.id}/lodgings`, `invalid-hotel-${Object.keys(extra)[0]}`, {
        hotel: { name: "Invalid hotel", address: null, latitude: null, longitude: null, sourceUrl: null, timeZone: "Asia/Tokyo", ...extra },
        countryStopId: trip.countryStops[0]!.id, checkInLocalDateTime: "2026-10-21T15:00", checkOutLocalDateTime: "2026-10-22T10:00",
        expectedTripVersion: before.tripVersion,
      });
      expect(badHotel.status).toBe(400);
      expect(await badHotel.json()).toMatchObject({ error: { code: "validation_error" } });
    }
    expect(await readSkeleton(cookie, trip.id)).toEqual(before);
  });




  it("uses IDs to keep equally-timestamped places in a stable user-visible order", async () => {
    const cookie = await login();
    const trip = await createTrip(cookie);
    const createdAt = new Date("2026-10-01T00:00:00.000Z");
    const ownerId = trip.members[0]!.userId;
    const highId = "00000000-0000-4000-8000-000000000002";
    const lowId = "00000000-0000-4000-8000-000000000001";
    await database.insertInto("places").values([
      {
        id: highId, trip_id: trip.id, name: "Same-time high", place_type: "other",
        created_by: ownerId, created_at: createdAt, updated_at: createdAt,
      },
      {
        id: lowId, trip_id: trip.id, name: "Same-time low", place_type: "other",
        created_by: ownerId, created_at: createdAt, updated_at: createdAt,
      },
    ]).execute();

    expect((await readSkeleton(cookie, trip.id)).places
      .filter((place) => place.name.startsWith("Same-time"))
      .map((place) => place.id)).toEqual([lowId, highId]);
  });



  it("caps cumulative constraints and keeps the largest constraint response bounded", async () => {
    const cookie = await login("constraint-cap-owner@example.test");
    const trip = await createTrip(cookie);
    const extraUsers = await database.insertInto("users").values(
      Array.from({ length: 99 }, (_, index) => ({
        email: `${String(index).padStart(2, "0")}-${"x".repeat(238)}@example.test`,
        display_name: `${String(index).padStart(2, "0")}-${"m".repeat(37)}`,
        status: "active" as const,
      })),
    ).returning("id").execute();
    const extraMembers = await database.insertInto("trip_members").values(
      extraUsers.map((user) => ({
        trip_id: trip.id,
        user_id: user.id,
        role: "editor" as const,
        removed_at: null,
      })),
    ).returning("id").execute();
    const initial = (await readSkeleton(cookie, trip.id)).items.find((entry) => entry.title === "FIXTURE-OUT")!;
    const primedResponse = await mutate(cookie, `/api/trips/${trip.id}/items/${initial.id}`, "constraint-cap-item", {
      ...initial,
      title: "t".repeat(200),
      notes: "n".repeat(10_000),
      sourceUrl: `https://example.test/${"s".repeat(1_978)}`,
      money: { amountMinor: 2_147_483_647, currency: "TWD" },
      participantMemberIds: [trip.members[0]!.id, ...extraMembers.map((member) => member.id)],
      details: { ...initial.details, confirmationNotes: "c".repeat(200) },
      expectedVersion: initial.version,
    }, "PATCH");
    expect(primedResponse.status, await primedResponse.clone().text()).toBe(200);
    let item = parseItineraryItemResponse(await primedResponse.json()).item;

    for (let index = 0; index < 20; index += 1) {
      const response = await mutate(
        cookie,
        `/api/trips/${trip.id}/items/${item.id}/constraints`,
        `constraint-cap-${index}`,
        {
          expectedItemVersion: item.version,
          type: "minimum_buffer",
          status: "unknown",
          minimumBufferMinutes: 2_147_483_647 - index,
        },
      );
      expect(response.status).toBe(201);
      item = parseItineraryItemResponse(await response.json()).item;
    }
    expect(item.constraints).toHaveLength(20);
    const stored = await database.selectFrom("mutation_requests")
      .select([
        sql<number>`octet_length(response::text)`.as("responseBytes"),
        sql<number>`pg_column_size(response)`.as("storedBytes"),
      ])
      .where("actor_id", "=", trip.members[0]!.userId)
      .where("operation", "=", `cc:${trip.id}:${item.id}`)
      .where("idempotency_key", "=", "constraint-cap-19")
      .executeTakeFirstOrThrow();
    expect(Number(stored.responseBytes)).toBeLessThan(58_000);
    expect(Number(stored.storedBytes)).toBeLessThan(8_000);

    const rejected = await mutate(
      cookie,
      `/api/trips/${trip.id}/items/${item.id}/constraints`,
      "constraint-cap-rejected",
      {
        expectedItemVersion: item.version,
        type: "fixed_time",
        status: "unknown",
        minimumBufferMinutes: null,
      },
    );
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({
      error: {
        code: "validation_error",
        message: "An itinerary item can have at most 20 constraints",
      },
    });
    expect((await readSkeleton(cookie, trip.id)).items.find((entry) => entry.id === item.id))
      .toMatchObject({ version: item.version, constraints: item.constraints });
  });

  it("keeps unchanged mixed-use legacy airport and hotel endpoints on dedicated PATCH", async () => {
    const cookie = await login();
    const trip = await createTrip(cookie);
    const airport = await createPlace(cookie, trip.id, "legacy-airport", {
      name: "Mixed airport", type: "airport", timeZone: null, latitude: 35, longitude: 135,
      address: "Airport address", sourceUrl: "https://example.test/airport",
    });
    const hotel = await createPlace(cookie, trip.id, "legacy-hotel", {
      name: "Mixed hotel", type: "lodging", timeZone: "Asia/Tokyo", latitude: 35.1, longitude: 135.1,
      address: "Hotel address", sourceUrl: "https://example.test/hotel",
    });
    const endpoint = (placeId: string, localDateTime: string, role: "start" | "end" = "start") => ({
      role, placeId, countryStopId: trip.countryStops[0]!.id, timeZone: "Asia/Tokyo", localDateTime,
    });
    for (const place of [airport, hotel]) {
      await seedItem(trip.members[0]!.userId, trip.id, {
        type: "activity", title: `Visit ${place.name}`, participantMemberIds: null,
        endpoints: [endpoint(place.id, "2026-10-22T12:00")], details: { durationMinutes: 30, bookedBy: null, confirmationStatus: null },
        constraints: [],
      });
    }
    const flight = (await readSkeleton(cookie, trip.id)).items.find((item) => item.title === "FIXTURE-OUT")!;
    const wired = await mutate(cookie, `/api/trips/${trip.id}/items/${flight.id}`, "legacy-airport-wire", {
      ...flight, endpoints: flight.endpoints.map((value) => value.role === "start" ? { ...value, placeId: airport.id } : value),
      participantMemberIds: flight.participants?.map((participant) => participant.memberId) ?? null,
      expectedVersion: flight.version,
    }, "PATCH");
    expect(wired.status).toBe(200);
    const beforeFlight = parseItineraryItemResponse(await wired.json()).item;
    const updated = await mutate(cookie, `/api/trips/${trip.id}/flights/${flight.id}`, "legacy-flight-carrier", {
      ...tripFlights().outbound, departureAirport: { name: airport.name, timeZone: "Asia/Tokyo" }, carrier: "New carrier",
      expectedVersion: beforeFlight.version,
    }, "PATCH");
    expect(updated.status).toBe(200);
    expect(parseItineraryItemResponse(await updated.json()).item.endpoints).toEqual(beforeFlight.endpoints);
    const lodging = await seedItem(trip.members[0]!.userId, trip.id, {
      type: "lodging", title: "Legacy booking", participantMemberIds: null,
      endpoints: [endpoint(hotel.id, "2026-10-21T15:00"), endpoint(hotel.id, "2026-10-23T10:00", "end")],
      details: { bookedBy: null, confirmationCode: null }, constraints: [],
    });
    const edited = await mutate(cookie, `/api/trips/${trip.id}/lodgings/${lodging.id}`, "legacy-stay-time", {
      hotel: { name: hotel.name, address: hotel.address, latitude: hotel.latitude, longitude: hotel.longitude, sourceUrl: hotel.sourceUrl, timeZone: hotel.timeZone },
      countryStopId: trip.countryStops[0]!.id, checkInLocalDateTime: "2026-10-21T15:00", checkOutLocalDateTime: "2026-10-24T10:00",
      expectedVersion: lodging.version,
    }, "PATCH");
    expect(edited.status).toBe(200);
    expect(parseItineraryItemResponse(await edited.json()).item.endpoints.map((value) => value.placeId)).toEqual([hotel.id, hotel.id]);
    const after = await readSkeleton(cookie, trip.id);
    expect(after.places.find((place) => place.id === airport.id)).toEqual(airport);
    expect(after.places.find((place) => place.id === hotel.id)).toEqual(hotel);
    expect(after.places.filter((place) => place.name === airport.name || place.name === hotel.name).map((place) => place.id).sort())
      .toEqual([airport.id, hotel.id].sort());
  });

  it("enriches reused travel hotel facts with versions while protecting locked and mixed-use places", async () => {
    const cookie = await login();
    const trip = await createTrip(cookie);
    const input = { hotel: { name: "Manual hotel", address: null, latitude: null, longitude: null, sourceUrl: null, timeZone: "Asia/Tokyo" },
      countryStopId: trip.countryStops[0]!.id, checkInLocalDateTime: "2026-10-21T15:00", checkOutLocalDateTime: "2026-10-23T10:00" };
    const created = await mutate(cookie, `/api/trips/${trip.id}/lodgings`, "manual-facts", {
      ...input, expectedTripVersion: await currentTripVersion(cookie, trip.id),
    });
    expect(created.status).toBe(201);
    const lodging = parseItineraryItemResponse(await created.json()).item;
    const placeId = lodging.endpoints[0]!.placeId!;
    const original = (await readSkeleton(cookie, trip.id)).places.find((place) => place.id === placeId)!;
    const facts = { ...input.hotel, address: "Located address", latitude: 35, longitude: 135, sourceUrl: "https://example.test/hotel" };
    const enriched = await mutate(cookie, `/api/trips/${trip.id}/lodgings/${lodging.id}`, "enrich-hotel-facts", {
      ...input, hotel: facts, expectedVersion: lodging.version,
    }, "PATCH");
    expect(enriched.status).toBe(200);
    const current = parseItineraryItemResponse(await enriched.json()).item;
    expect(current.endpoints.map((value) => value.placeId)).toEqual([placeId, placeId]);
    const stored = (await readSkeleton(cookie, trip.id)).places.find((place) => place.id === placeId)!;
    expect(stored).toMatchObject({ ...facts, version: original.version + 1, locationStatus: "complete" });
    const secondInput = {
      ...input,
      checkInLocalDateTime: "2026-10-23T15:00",
      checkOutLocalDateTime: "2026-10-25T10:00",
    };
    const secondResponse = await mutate(cookie, `/api/trips/${trip.id}/lodgings`, "shared-hotel-facts", {
      ...secondInput, hotel: facts, expectedTripVersion: await currentTripVersion(cookie, trip.id),
    });
    expect(secondResponse.status).toBe(201);
    const second = parseItineraryItemResponse(await secondResponse.json()).item;
    const lock = await mutate(cookie, `/api/trips/${trip.id}/items/${second.id}/lock`, "shared-hotel-lock", { expectedVersion: second.version });
    const locked = parseItineraryItemResponse(await lock.json()).item;
    const rejected = await mutate(cookie, `/api/trips/${trip.id}/lodgings/${lodging.id}`, "locked-hotel-facts", {
      ...input, hotel: { ...facts, latitude: 36 }, expectedVersion: current.version,
    }, "PATCH");
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ error: { code: "item_locked" } });
    expect((await readSkeleton(cookie, trip.id)).places.find((place) => place.id === placeId)).toEqual(stored);
    expect((await mutate(cookie, `/api/trips/${trip.id}/items/${second.id}/unlock`, "shared-hotel-unlock", { expectedVersion: locked.version })).status).toBe(200);
    await seedItem(trip.members[0]!.userId, trip.id, {
      type: "activity", title: "Hotel restaurant", participantMemberIds: null,
      endpoints: [{ role: "start", placeId, countryStopId: trip.countryStops[0]!.id, timeZone: "Asia/Tokyo", localDateTime: "2026-10-22T12:00" }],
      details: { durationMinutes: 60, bookedBy: null, confirmationStatus: null }, constraints: [],
    });
    const separate = await mutate(cookie, `/api/trips/${trip.id}/lodgings/${lodging.id}`, "mixed-hotel-facts", {
      ...input, hotel: { ...facts, latitude: 36 }, expectedVersion: current.version,
    }, "PATCH");
    expect(separate.status).toBe(200);
    const separatePlaceId = parseItineraryItemResponse(await separate.json()).item.endpoints[0]!.placeId;
    expect(separatePlaceId).not.toBe(placeId);
    const after = await readSkeleton(cookie, trip.id);
    expect(after.places.find((place) => place.id === placeId)).toEqual(stored);
    expect(after.places.find((place) => place.id === separatePlaceId)).toMatchObject({ latitude: 36, longitude: 135 });
  });

  it("accepts canonical-equivalent uppercase UUIDs in itinerary endpoint JSON", async () => {
    const cookie = await login();
    const trip = await createTrip(cookie);
    const flight = (await readSkeleton(cookie, trip.id)).items.find((item) => item.title === "FIXTURE-OUT")!;
    const response = await mutate(cookie, `/api/trips/${trip.id}/items/${flight.id}`, "uppercase-endpoint", {
      ...flight,
      participantMemberIds: flight.participants?.map((participant) => participant.memberId) ?? null,
      endpoints: flight.endpoints.map((endpoint) => endpoint.role === "end" ? {
        ...endpoint,
        countryStopId: endpoint.countryStopId!.toUpperCase(),
        placeId: endpoint.placeId!.toUpperCase(),
      } : endpoint),
      expectedVersion: flight.version,
    }, "PATCH");
    expect(response.status).toBe(200);
    expect(parseItineraryItemResponse(await response.json()).item.endpoints.find((endpoint) => endpoint.role === "end")).toMatchObject({
      countryStopId: flight.endpoints.find((endpoint) => endpoint.role === "end")!.countryStopId,
      placeId: flight.endpoints.find((endpoint) => endpoint.role === "end")!.placeId,
    });
  });

  it("rejects version numbers outside PostgreSQL integer bounds before querying", async () => {
    const cookie = await login();
    const trip = await createTrip(cookie);
    const place = await createPlace(cookie, trip.id, "oversized-version-place", {
      name: "Oversized version place", type: "activity", timeZone: "Asia/Tokyo",
    });
    const oversized = 2_147_483_648;

    const invalidPlaceUpdate = await mutate(
      cookie,
      `/api/trips/${trip.id}/places/${place.id}`,
      "oversized-place-version",
      { ...place, expectedVersion: oversized },
      "PATCH",
    );
    expect(invalidPlaceUpdate.status).toBe(400);
    expect(await invalidPlaceUpdate.json()).toMatchObject({ error: { code: "validation_error" } });

    const item = await seedItem(trip.members[0]!.userId, trip.id, {
      type: "activity", title: "Version bounds item", participantMemberIds: null,
      endpoints: [{ role: "start", countryStopId: trip.countryStops[0]!.id, placeId: place.id,
        localDateTime: "2026-10-22T10:00", timeZone: "Asia/Tokyo" }],
      details: { durationMinutes: 60, bookedBy: null, confirmationStatus: "unknown" }, constraints: [],
    });
    const constrainedResponse = await mutate(
      cookie,
      `/api/trips/${trip.id}/items/${item.id}/constraints`,
      "version-bounds-constraint",
      {
        expectedItemVersion: item.version,
        type: "minimum_buffer",
        status: "unknown",
        minimumBufferMinutes: 30,
      },
    );
    const constrained = parseItineraryItemResponse(await constrainedResponse.json()).item;
    const constraint = constrained.constraints[0]!;
    for (const [method, key] of [["PATCH", "oversized-constraint-update"], ["DELETE", "oversized-constraint-delete"]] as const) {
      const response = await mutate(
        cookie,
        `/api/trips/${trip.id}/items/${item.id}/constraints/${constraint.id}`,
        key,
        {
          expectedItemVersion: constrained.version,
          expectedVersion: oversized,
          ...(method === "PATCH"
            ? { type: "minimum_buffer", status: "confirmed", minimumBufferMinutes: 30 }
            : {}),
        },
        method,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "validation_error" } });
    }
    expect((await readSkeleton(cookie, trip.id)).items.find((entry) => entry.id === item.id))
      .toEqual(constrained);
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
    const item = await seedItem(trip.members[0]!.userId, trip.id, {
      type: "activity",
      title: "Flexible activity",
      notes: null,
      sourceUrl: null,
      money: null,
      participantMemberIds: null,
      endpoints: [{
        role: "start",
        countryStopId: trip.countryStops[0]!.id,
        placeId: place.id,
        localDateTime: "2026-10-24T10:00",
        timeZone: "Asia/Tokyo",
      }],
      details: { durationMinutes: 90, bookedBy: null, confirmationStatus: "unknown" },
      constraints: [],
    });


    const oversized = await mutate(
      cookie,
      `/api/trips/${trip.id}/items/${item.id}/constraints`,
      "oversized-minimum-buffer",
      {
        expectedItemVersion: item.version,
        type: "minimum_buffer",
        status: "unknown",
        minimumBufferMinutes: 2_147_483_648,
      },
    );
    expect(oversized.status).toBe(400);
    expect(await oversized.json()).toMatchObject({ error: { code: "validation_error" } });
    expect((await readSkeleton(cookie, trip.id)).items.find((entry) => entry.id === item.id))
      .toMatchObject({ version: item.version, constraints: [] });
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
      participantMemberIds: null,
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
    const fixture = (await readSkeleton(cookie, trip.id)).items.find((item) => item.title === "FIXTURE-OUT")!;
    const createdResponse = await mutate(cookie, `/api/trips/${trip.id}/items/${fixture.id}`, "create-cross-timezone-flight", {
      ...input,
      expectedVersion: fixture.version,
    }, "PATCH");
    expect(createdResponse.status).toBe(200);
    const created = parseItineraryItemResponse(await createdResponse.json()).item;
    expect(created.endpoints).toMatchObject([
      { utcOffset: "-07:00", instant: "2026-10-21T17:00:00.000Z" },
      { utcOffset: "+09:00", instant: "2026-10-22T05:00:00.000Z" },
    ]);
    expect(created.money).toEqual({ amountMinor: 125000, currency: "USD" });

    const skeletonResponse = await app.request(`/api/trips/${trip.id}/skeleton`, {
      headers: { cookie },
    });
    const skeleton = parseTripSkeletonResponse(await skeletonResponse.json()).skeleton;
    expect(skeleton.items.filter((item) => item.id === created.id)).toEqual([created]);
    expect(skeleton.days.find((day) => day.date === "2026-10-21")?.entries.filter((entry) => entry.itemId === created.id)).toEqual([
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
    const lock = await app.request(`/api/trips/${trip.id}/items/${created.id}/lock`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        origin: "https://app.example.test",
        "idempotency-key": "lock-cross-timezone-flight",
      },
      body: body({ expectedVersion: created.version }),
    });
    expect(lock.status).toBe(200);
    const locked = parseItineraryItemResponse(await lock.json()).item;
    expect(locked).toMatchObject({ version: created.version + 1 });
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
        body: body({ ...input, title: "Must not change", expectedVersion: locked.version }),
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
        body: body({ expectedVersion: locked.version }),
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
        body: body({ expectedVersion: locked.version }),
      },
    );
    expect(unlock.status).toBe(200);
    const unlocked = parseItineraryItemResponse(await unlock.json()).item;
    expect(unlocked.version).toBe(locked.version + 1);
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
        body: body({ ...correctedInput, title: "Updated flight", expectedVersion: unlocked.version }),
      },
    );
    expect(firstUpdate.status).toBe(200);
    const correctedItem = parseItineraryItemResponse(await firstUpdate.json()).item;
    expect(correctedItem).toMatchObject({
      id: created.id,
      title: "Updated flight",
      version: unlocked.version + 1,
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
        body: body({ ...correctedInput, title: "Updated flight", expectedVersion: unlocked.version }),
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
        body: body({ ...input, title: "Stale overwrite", expectedVersion: unlocked.version }),
      },
    );
    expect(staleUpdate.status).toBe(409);
    expect(await staleUpdate.json()).toMatchObject({
      error: { code: "conflict", currentVersion: correctedItem.version },
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

    const audited = await app.request(`/api/trips/${trip.id}/history`, {
      headers: { cookie },
    });
    const events = parseTripHistoryResponse(await audited.json()).events;
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
        body: body({ expectedVersion: correctedItem.version }),
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
        body: body({ expectedVersion: correctedItem.version }),
      },
    );
    expect(replayedDelete.status).toBe(204);
    const afterDelete = await app.request(`/api/trips/${trip.id}/history`, {
      headers: { cookie },
    });
    expect(
      parseTripHistoryResponse(await afterDelete.json()).events.map(
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
    const item = (localDateTime: string, utcOffset?: string): CreateItineraryItemInput => ({
      type: "free-time",
      title: "Local time check",
      notes: null,
      sourceUrl: null,
      money: null,
      participantMemberIds: null,
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
    const flight = (await readSkeleton(cookie, trip.id)).items.find((entry) => entry.title === "FIXTURE-OUT")!;
    const create = async (key: string, payload: CreateItineraryItemInput) =>
      mutate(cookie, `/api/trips/${trip.id}/items/${flight.id}`, key, {
        ...payload,
        expectedVersion: flight.version,
      }, "PATCH");

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
    expect(resolved.status).toBe(200);
    expect(
      parseItineraryItemResponse(await resolved.json()).item.endpoints[0],
    ).toMatchObject({
      localDateTime: "2026-11-01T01:30",
      utcOffset: "-08:00",
      instant: "2026-11-01T09:30:00.000Z",
    });
  });

  it("bounds derived ends by their local date when a time zone repeats the previous date", async () => {
    // tzdb: America/St_Johns fell back at 2009-11-01 00:01 (-02:30) to 2009-10-31 23:01 (-03:30).
    const cookie = await login();
    interface StJohnsTarget { tripId: string; countryStopId: string; placeId: string; itemId: string }
    async function stJohnsTrip(key: string, date: string): Promise<StJohnsTarget> {
      const response = await mutate(cookie, "/api/trips", key, {
        name: `St. John's ${date}`, startDate: date, endDate: date, countryCodes: ["CA"],
        flights: tripFlights(date, date, "Etc/UTC"),
      });
      expect(response.status).toBe(201);
      const trip = parseTripResponse(await response.json()).trip;
      const place = await createPlace(cookie, trip.id, `${key}-place`, {
        name: "St. John's", type: "other", address: null, latitude: null, longitude: null,
        timeZone: "America/St_Johns", sourceUrl: null, notes: null,
      });
      const itemId = (await readSkeleton(cookie, trip.id)).items.find((item) => item.title === "FIXTURE-OUT")!.id;
      return { tripId: trip.id, countryStopId: trip.countryStops[0]!.id, placeId: place.id, itemId };
    }
    async function create(
      target: StJohnsTarget, key: string, localDateTime: string,
      durationMinutes: number, type: string, details: Record<string, unknown>,
    ) {
      const current = (await readSkeleton(cookie, target.tripId)).items.find((item) => item.id === target.itemId)!;
      return mutate(cookie, `/api/trips/${target.tripId}/items/${target.itemId}`, key, {
        type, title: key, notes: null, sourceUrl: null, money: null, participantMemberIds: null,
        endpoints: [{
          role: "start", countryStopId: target.countryStopId, placeId: target.placeId,
          localDateTime, timeZone: "America/St_Johns", utcOffset: "-02:30",
        }],
        details: { ...details, durationMinutes },
        expectedVersion: current.version,
      }, "PATCH");
    }
    const appointment = { bookedBy: null, confirmationStatus: "unknown" };
    const durationTypes = [
      { type: "reservation", details: appointment },
      { type: "meal", details: appointment },
      { type: "activity", details: appointment },
      { type: "free-time", details: {} },
    ];
    // 2009-11-01T00:00-02:30 + 30 min is 2009-10-31T23:30-03:30, before this trip's first date.
    const novemberFirst = await stJohnsTrip("st-johns-november-first", "2009-11-01");
    // 2009-10-31T23:30-02:30 + 60 min is 2009-10-31T23:30-03:30, still this trip's last date.
    const octoberLast = await stJohnsTrip("st-johns-october-last", "2009-10-31");
    for (const { type, details } of durationTypes) {
      const early = await create(novemberFirst, `before-first-${type}`, "2009-11-01T00:00", 30, type, details);
      expect(early.status, type).toBe(400);
      const repeated = await create(octoberLast, `repeated-last-${type}`, "2009-10-31T23:30", 60, type, details);
      expect(repeated.status, type).toBe(200);
      expect(parseItineraryItemResponse(await repeated.json()).item.endpoints[0]).toMatchObject({
        utcOffset: "-02:30", instant: "2009-11-01T02:00:00.000Z",
      });
    }
    expect((await readSkeleton(cookie, novemberFirst.tripId)).items.map((item) => item.title).sort()).toEqual(["FIXTURE-OUT", "FIXTURE-RETURN"]);
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
      role: "start" as const,
      countryStopId: trip.countryStops[0]!.id,
      placeId: firstPlace.id,
      localDateTime: "2026-10-22T10:00",
      timeZone: "Asia/Tokyo",
    };
    const base = {
      type: "activity" as const,
      title: "Validation target",
      notes: null,
      sourceUrl: null,
      money: null,
      participantMemberIds: null,
      endpoints: [start],
      details: {
        durationMinutes: 60,
        bookedBy: null,
        confirmationStatus: "unknown",
      },
      constraints: [],
    } satisfies CreateItineraryItemInput;
    const original = await seedItem(trip.members[0]!.userId, trip.id, base);
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
        // 2026-10-22T10:00 + 8040 min is 2026-10-28T00:00, after the trip's last date.
        key: "invalid-duration-after-trip",
        payload: { ...base, details: { ...base.details, durationMinutes: 8040 } },
      },
      {
        key: "invalid-unrepresentable-duration",
        payload: { ...base, details: { ...base.details, durationMinutes: Number.MAX_SAFE_INTEGER } },
      },
      {
        key: "invalid-free-time-after-trip",
        payload: { ...base, type: "free-time", details: { durationMinutes: Number.MAX_SAFE_INTEGER } },
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
      const response = await mutate(
        cookie,
        `/api/trips/${trip.id}/items/${original.id}`,
        invalid.key,
        { ...invalid.payload, expectedVersion: original.version },
        "PATCH",
      );
      expect(response.status, invalid.key).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: "validation_error" },
      });
      const unchanged = (await readSkeleton(cookie, trip.id)).items
        .find((item) => item.id === original.id);
      expect(unchanged?.version, invalid.key).toBe(original.version);
      expect(unchanged, invalid.key).toEqual(original);
    }

    const lastMinute = await mutate(
      cookie,
      `/api/trips/${trip.id}/items/${original.id}`,
      "valid-duration-last-trip-minute",
      {
        ...base,
        details: { ...base.details, durationMinutes: 8039 },
        expectedVersion: original.version,
      },
      "PATCH",
    );
    expect(lastMinute.status).toBe(200);
    expect(parseItineraryItemResponse(await lastMinute.json()).item.details)
      .toMatchObject({ durationMinutes: 8039 });
  });

  it("falls back from Place to Country Stop and explicitly confirmed endpoint time zones", async () => {
    const cookie = await login();
    const japanTrip = await createTrip(cookie);
    expect(japanTrip.countryStops[0]?.timeZone).toBe("Asia/Tokyo");
    const japanPlace = await createPlace(cookie, japanTrip.id, "japan-place-without-zone", {
      name: "Japan place without time zone", type: "activity", timeZone: null,
    });

    async function updateActivity(
      tripId: string,
      countryStopId: string,
      placeId: string,
      timeZone: string,
      key: string,
    ) {
      const current = (await readSkeleton(cookie, tripId)).items.find((item) => item.title === "FIXTURE-OUT")!;
      const response = await mutate(cookie, `/api/trips/${tripId}/items/${current.id}`, key, {
        type: "activity",
        title: key,
        notes: null,
        sourceUrl: null,
        money: null,
        participantMemberIds: null,
        endpoints: [{ role: "start", countryStopId, placeId, localDateTime: "2026-10-22T10:00", timeZone }],
        details: { durationMinutes: 60, bookedBy: null, confirmationStatus: "unknown" },
        expectedVersion: current.version,
      }, "PATCH");
      expect(response.status).toBe(200);
      return parseItineraryItemResponse(await response.json()).item;
    }

    const stopFallback = await updateActivity(
      japanTrip.id, japanTrip.countryStops[0]!.id, japanPlace.id, "Asia/Tokyo", "country-stop-time-zone-fallback",
    );
    expect(stopFallback.endpoints[0]).toMatchObject({
      timeZone: "Asia/Tokyo", utcOffset: "+09:00", instant: "2026-10-22T01:00:00.000Z",
    });

    const usTrip = await createTrip(cookie, {
      name: "Explicit endpoint time zone", startDate: "2026-10-21", endDate: "2026-10-27", countryCodes: ["US"],
    });
    expect(usTrip.countryStops[0]?.timeZone).toBeNull();
    const usPlace = await createPlace(cookie, usTrip.id, "us-place-without-zone", {
      name: "US place without time zone", type: "activity", timeZone: null,
    });
    const usFlight = (await readSkeleton(cookie, usTrip.id)).items.find((item) => item.title === "FIXTURE-OUT")!;
    for (const [key, timeZone] of [
      ["reject-fixed-offset-time-zone", "-07:00"],
      ["reject-date-time-as-time-zone", "2026-10-22T10:00-07:00"],
    ] as const) {
      const invalidTimeZoneEndpoint = await mutate(cookie, `/api/trips/${usTrip.id}/items/${usFlight.id}`, key, {
        type: "activity", title: "Only a named IANA time zone is valid", participantMemberIds: null,
        endpoints: [{ role: "start", countryStopId: usTrip.countryStops[0]!.id, placeId: usPlace.id,
          localDateTime: "2026-10-22T10:00", timeZone }],
        details: { durationMinutes: 60, bookedBy: null, confirmationStatus: "unknown" },
        expectedVersion: usFlight.version,
      }, "PATCH");
      expect(invalidTimeZoneEndpoint.status).toBe(400);
      expect(await invalidTimeZoneEndpoint.json()).toMatchObject({ error: { code: "validation_error" } });
    }
    const explicitEndpoint = await updateActivity(
      usTrip.id, usTrip.countryStops[0]!.id, usPlace.id, "America/Los_Angeles", "explicit-endpoint-time-zone",
    );
    expect(explicitEndpoint.endpoints[0]).toMatchObject({
      timeZone: "America/Los_Angeles", utcOffset: "-07:00", instant: "2026-10-22T17:00:00.000Z",
    });
  });

  it("lets flights and transport leave from outside the trip's countries on their own time zone", async () => {
    const cookie = await login();
    const japanTrip = await createTrip(cookie);
    const japanStopId = japanTrip.countryStops[0]!.id;
    const placeWithoutZone = (name: string) => ({
      name, type: "airport", address: null, latitude: null, longitude: null,
      timeZone: null, sourceUrl: null, notes: null,
    });
    const taoyuan = await createPlace(cookie, japanTrip.id, "outside-taoyuan", placeWithoutZone("Taoyuan Airport"));
    const kansai = await createPlace(cookie, japanTrip.id, "outside-kansai", placeWithoutZone("Kansai Airport"));
    const flight = (countryStopId: string | null) => ({
      type: "flight",
      title: "CI 152",
      notes: null,
      sourceUrl: null,
      money: null,
      participantMemberIds: null,
      endpoints: [
        { role: "start", countryStopId, placeId: taoyuan.id, localDateTime: "2026-10-21T09:00", timeZone: "Asia/Taipei" },
        { role: "end", countryStopId: japanStopId, placeId: kansai.id, localDateTime: "2026-10-21T12:30", timeZone: "Asia/Tokyo" },
      ],
      details: { carrier: "China Airlines", serviceNumber: "CI 152", confirmationNotes: null },
      constraints: [],
    });

    const fixture = (await readSkeleton(cookie, japanTrip.id)).items.find((item) => item.title === "FIXTURE-OUT")!;

    // Inside the Japan stop, a Place without a time zone still takes the stop's time zone.
    const underJapan = await mutate(cookie, `/api/trips/${japanTrip.id}/items/${fixture.id}`, "outside-under-japan", {
      ...flight(japanStopId), expectedVersion: fixture.version,
    }, "PATCH");
    expect(underJapan.status).toBe(400);

    const created = await mutate(cookie, `/api/trips/${japanTrip.id}/items/${fixture.id}`, "outside-departure", {
      ...flight(null), expectedVersion: fixture.version,
    }, "PATCH");
    expect(created.status).toBe(200);
    const item = parseItineraryItemResponse(await created.json()).item;
    const departure = {
      role: "start", countryStopId: null, placeId: taoyuan.id,
      localDateTime: "2026-10-21T09:00", timeZone: "Asia/Taipei", utcOffset: "+08:00",
      instant: "2026-10-21T01:00:00.000Z",
    };
    expect(item.endpoints.find((endpoint) => endpoint.role === "start")).toMatchObject(departure);
    const reloaded = (await readSkeleton(cookie, japanTrip.id)).items.find((candidate) => candidate.id === item.id);
    expect(reloaded?.endpoints.find((endpoint) => endpoint.role === "start")).toMatchObject(departure);

    const transport = await mutate(cookie, `/api/trips/${japanTrip.id}/items/${item.id}`, "outside-transport", {
      ...flight(null),
      type: "transport",
      title: "Home to Taoyuan Airport",
      endpoints: [
        { role: "start", countryStopId: null, placeId: taoyuan.id, localDateTime: "2026-10-21T05:00", timeZone: "Asia/Taipei" },
        { role: "end", countryStopId: null, placeId: taoyuan.id, localDateTime: "2026-10-21T06:00", timeZone: "Asia/Taipei" },
      ],
      details: { mode: "bus", ticketInfo: null },
      expectedVersion: item.version,
    }, "PATCH");
    expect(transport.status).toBe(200);
    const transportItem = parseItineraryItemResponse(await transport.json()).item;

    // Single-place items still belong to one of the trip's country stops.
    const looseActivity = await mutate(cookie, `/api/trips/${japanTrip.id}/items/${item.id}`, "outside-activity", {
      ...flight(null),
      type: "activity",
      title: "Airport lounge",
      endpoints: [{ role: "start", countryStopId: null, placeId: taoyuan.id, localDateTime: "2026-10-21T07:00", timeZone: "Asia/Taipei" }],
      details: { durationMinutes: 60, bookedBy: null, confirmationStatus: "unknown" },
      expectedVersion: transportItem.version,
    }, "PATCH");
    expect(looseActivity.status).toBe(400);
    const looseLodging = await mutate(cookie, `/api/trips/${japanTrip.id}/items/${item.id}`, "outside-lodging", {
      ...flight(null),
      type: "lodging",
      title: "Airport hotel",
      endpoints: [
        { role: "start", countryStopId: null, placeId: taoyuan.id, localDateTime: "2026-10-21T15:00", timeZone: "Asia/Taipei" },
        { role: "end", countryStopId: null, placeId: taoyuan.id, localDateTime: "2026-10-22T10:00", timeZone: "Asia/Taipei" },
      ],
      details: { bookedBy: null, confirmationCode: null },
      expectedVersion: transportItem.version,
    }, "PATCH");
    expect(looseLodging.status).toBe(400);
  });
  it("requires scheduling permission to create, update, or delete timed wishlist-place items", async () => {
    const ownerCookie = await login();
    const trip = await createTrip(ownerCookie);
    const editor = await joinMember(ownerCookie, trip.id, "timed-item-editor@example.test", "timed-item-editor");
    const place = await createPlace(ownerCookie, trip.id, "timed-item-place", {
      name: "Timed wishlist place", type: "activity", timeZone: "Asia/Tokyo",
    });
    const input = {
      type: "activity" as const,
      title: "Timed wishlist activity",
      participantMemberIds: null,
      endpoints: [{
        role: "start" as const,
        countryStopId: trip.countryStops[0]!.id,
        placeId: place.id,
        localDateTime: "2026-10-22T10:00",
        timeZone: "Asia/Tokyo",
      }],
      details: { durationMinutes: 60, bookedBy: null, confirmationStatus: "unknown" as const },
    };

    const created = await seedItem(trip.members[0]!.userId, trip.id, {
      ...input,
      constraints: [],
    });
    const update = { ...input, title: "Moved timed activity", expectedVersion: created.version };
    expect((await mutate(editor.cookie, `/api/trips/${trip.id}/items/${created.id}`, "timed-editor-update", update, "PATCH")).status).toBe(403);
    expect((await mutate(editor.cookie, `/api/trips/${trip.id}/items/${created.id}`, "timed-editor-delete", {
      expectedVersion: created.version,
    }, "DELETE")).status).toBe(403);
    const lodgingResponse = await mutate(ownerCookie, `/api/trips/${trip.id}/lodgings`, "travel-permission-lodging", {
      hotel: {
        name: "Travel-only hotel", address: null, latitude: null, longitude: null,
        sourceUrl: null, timeZone: "Asia/Tokyo",
      },
      countryStopId: trip.countryStops[0]!.id,
      checkInLocalDateTime: "2026-10-23T15:00",
      checkOutLocalDateTime: "2026-10-24T10:00",
      expectedTripVersion: await currentTripVersion(ownerCookie, trip.id),
    });
    expect(lodgingResponse.status).toBe(201);
    const lodging = parseItineraryItemResponse(await lodgingResponse.json()).item;
    const flight = (await readSkeleton(ownerCookie, trip.id)).items.find((item) => item.type === "flight")!;
    expect((await mutate(editor.cookie, `/api/trips/${trip.id}/flights/${flight.id}`, "travel-only-editor-flight", {
      ...tripFlights().outbound,
      expectedVersion: flight.version,
    }, "PATCH")).status).toBe(403);
    expect((await mutate(editor.cookie, `/api/trips/${trip.id}/items/${lodging.id}`, "travel-only-editor-lodging-delete", {
      expectedVersion: lodging.version,
    }, "DELETE")).status).toBe(403);
    const sharedAirport = await createPlace(ownerCookie, trip.id, "timed-shared-airport", {
      name: "Shared itinerary airport", type: "airport", timeZone: "Asia/Tokyo",
    });
    const wiredResponse = await mutate(ownerCookie, `/api/trips/${trip.id}/items/${flight.id}`, "wire-timed-flight", {
      ...flight,
      participantMemberIds: flight.participants?.map((participant) => participant.memberId) ?? null,
      endpoints: flight.endpoints.map((endpoint) =>
        endpoint.role === "end" ? { ...endpoint, placeId: sharedAirport.id } : endpoint
      ),
      expectedVersion: flight.version,
    }, "PATCH");
    expect(wiredResponse.status).toBe(200);
    const wired = parseItineraryItemResponse(await wiredResponse.json()).item;
    const travelUpdate = {
      ...tripFlights().outbound,
      arrivalAirport: { name: sharedAirport.name, timeZone: "Asia/Tokyo" },
      expectedVersion: wired.version,
    };
    expect((await mutate(
      editor.cookie,
      `/api/trips/${trip.id}/flights/${flight.id}`,
      "timed-editor-flight",
      travelUpdate,
      "PATCH",
    )).status).toBe(403);


    expect((await mutate(ownerCookie, `/api/trips/${trip.id}/editors-can-schedule`, "allow-timed-editor", {
      enabled: true,
    }, "PUT")).status).toBe(204);
    expect((await mutate(
      editor.cookie,
      `/api/trips/${trip.id}/flights/${flight.id}`,
      "timed-allowed-flight",
      travelUpdate,
      "PATCH",
    )).status).toBe(200);
    const updatedResponse = await mutate(
      editor.cookie, `/api/trips/${trip.id}/items/${created.id}`, "timed-allowed-update", update, "PATCH",
    );
    expect(updatedResponse.status).toBe(200);
    const updated = parseItineraryItemResponse(await updatedResponse.json()).item;
    expect((await mutate(editor.cookie, `/api/trips/${trip.id}/items/${created.id}`, "timed-allowed-delete", {
      expectedVersion: updated.version,
    }, "DELETE")).status).toBe(204);
    expect((await mutate(editor.cookie, `/api/trips/${trip.id}/items/${lodging.id}`, "allowed-editor-lodging-delete", {
      expectedVersion: lodging.version,
    }, "DELETE")).status).toBe(204);
  });
  it("reloads independent activities and changes a shared party without duplicating the item", async () => {
    const cookie = await login();
    const trip = await createTrip(cookie);
    const owner = trip.members[0]!;
    const initialItems = (await readSkeleton(cookie, trip.id)).items;
    const editor = await joinMember(cookie, trip.id, "second@example.test", "party-second");
    await joinMember(cookie, trip.id, "third@example.test", "party-third");
    const fourth = await joinMember(cookie, trip.id, "fourth@example.test", "party-fourth");
    expect((await mutate(cookie, `/api/trips/${trip.id}/editors-can-schedule`, "allow-party-editor", {
      enabled: true,
    }, "PUT")).status).toBe(204);
    const place = await createPlace(cookie, trip.id, "party-place", {
      name: "Meeting point", type: "activity", timeZone: "Asia/Tokyo",
    });
    const base: CreateItineraryItemInput = {
      type: "activity",
      title: "A / 甲",
      participantMemberIds: [owner.id],
      endpoints: [{
        role: "start", countryStopId: trip.countryStops[0]!.id, placeId: place.id,
        localDateTime: "2026-10-21T10:00", timeZone: "Asia/Tokyo",
      }],
      details: { durationMinutes: 120, bookedBy: null, confirmationStatus: "unknown" },
      constraints: [],
    };
    const a = await seedItem(owner.userId, trip.id, base);
    const b = await seedItem(editor.member.userId, trip.id, {
      ...base,
      title: "B / 乙",
      participantMemberIds: [editor.member.id],
      endpoints: [{ ...base.endpoints[0]!, localDateTime: "2026-10-21T11:00" }],
    });
    const unspecified = await seedItem(owner.userId, trip.id, {
      ...base,
      title: "Unspecified",
      participantMemberIds: null,
    });

    const selectedIds = [fourth.member.id, owner.id, editor.member.id];
    const updatePayload = { ...base, participantMemberIds: selectedIds, expectedVersion: a.version };
    const updated = await mutate(
      cookie, `/api/trips/${trip.id}/items/${a.id}`, "party-shared", updatePayload, "PATCH",
    );
    expect(updated.status).toBe(200);
    const shared = parseItineraryItemResponse(await updated.json()).item;
    expect(shared.id).toBe(a.id);
    expect(shared.participants?.map((participant) => participant.memberId))
      .toEqual([...selectedIds].sort());
    expect(shared.participants).toEqual(
      [owner, editor.member, fourth.member]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((member) => ({
          memberId: member.id, displayName: member.displayName, email: member.email, removed: false,
        })),
    );
    const stale = await mutate(
      cookie, `/api/trips/${trip.id}/items/${a.id}`, "party-stale",
      { ...updatePayload, participantMemberIds: null }, "PATCH",
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: { code: "conflict", currentVersion: shared.version },
    });
    const lockedResponse = await mutate(cookie, `/api/trips/${trip.id}/items/${a.id}/lock`, "party-lock", {
      expectedVersion: shared.version,
    });
    expect(lockedResponse.status).toBe(200);
    const locked = parseItineraryItemResponse(await lockedResponse.json()).item;
    const rejected = await mutate(
      cookie, `/api/trips/${trip.id}/items/${a.id}`, "party-edit-locked",
      { ...updatePayload, expectedVersion: locked.version, participantMemberIds: null }, "PATCH",
    );
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ error: { code: "item_locked" } });
    const beforeReplay = await readSkeleton(editor.cookie, trip.id);
    const updateReplay = await mutate(
      cookie, `/api/trips/${trip.id}/items/${a.id}`, "party-shared", updatePayload, "PATCH",
    );
    expect(updateReplay.status).toBe(200);
    expect(parseItineraryItemResponse(await updateReplay.json()).item).toEqual(shared);
    const reloaded = await readSkeleton(editor.cookie, trip.id);
    expect(reloaded).toEqual(beforeReplay);
    expect(reloaded.items.map((item) => item.id).sort()).toEqual([...initialItems.map((item) => item.id), a.id, b.id, unspecified.id].sort());
    expect(reloaded.items.find((item) => item.id === a.id)).toMatchObject({
      id: locked.id,
      lockedAt: locked.lockedAt,
      version: locked.version,
    });
    expect(reloaded.items.find((item) => item.id === b.id)).toMatchObject({
      participants: [{ memberId: editor.member.id }],
      endpoints: [{ localDateTime: "2026-10-21T11:00", instant: "2026-10-21T02:00:00.000Z" }],
      details: { durationMinutes: 120 },
    });
    expect(reloaded.items.find((item) => item.id === a.id)).toMatchObject({
      endpoints: [{ localDateTime: "2026-10-21T10:00", instant: "2026-10-21T01:00:00.000Z" }],
      details: { durationMinutes: 120 },
    });
    expect(reloaded.items.find((item) => item.id === unspecified.id)?.participants).toBeNull();
  });
  it("rejects invalid parties atomically and retains removed participants until explicitly deselected", async () => {
    const cookie = await login();
    const trip = await createTrip(cookie);
    const owner = trip.members[0]!;
    const editor = await joinMember(cookie, trip.id, "historical@example.test", "historical-member");
    await database.updateTable("users").set({ display_name: "Historical traveler" })
      .where("id", "=", editor.member.userId).execute();
    const foreignTrip = await createTrip(cookie, {
      name: "Different membership scope", startDate: "2026-10-21", endDate: "2026-10-27",
      countryCodes: ["US"],
    });
    const place = await createPlace(cookie, trip.id, "historical-place", {
      name: "Historical visit", type: "activity", timeZone: "Asia/Tokyo",
    });
    const base = {
      type: "activity", title: "Historical party",
      participantMemberIds: [editor.member.id],
      endpoints: [{
        role: "start", countryStopId: trip.countryStops[0]!.id, placeId: place.id,
        localDateTime: "2026-10-21T10:00", timeZone: "Asia/Tokyo",
      }],
      details: { durationMinutes: 120, bookedBy: null, confirmationStatus: "unknown" },
    };
    const beforeInvalid = await readSkeleton(cookie, trip.id);
    const item = await seedItem(owner.userId, trip.id, {
      type: "activity", title: "Historical party",
      participantMemberIds: [editor.member.id],
      endpoints: [{ role: "start", countryStopId: trip.countryStops[0]!.id, placeId: place.id,
        localDateTime: "2026-10-21T10:00", timeZone: "Asia/Tokyo" }],
      details: { durationMinutes: 120, bookedBy: null, confirmationStatus: "unknown" },
      constraints: [],
    });
    const beforeBadUpdate = await readSkeleton(cookie, trip.id);
    const badUpdate = await mutate(
      cookie, `/api/trips/${trip.id}/items/${item.id}`, "foreign-party-update",
      { ...base, expectedVersion: item.version, participantMemberIds: [foreignTrip.members[0]!.id] },
      "PATCH",
    );
    expect(badUpdate.status).toBe(400);
    expect(await readSkeleton(cookie, trip.id)).toEqual(beforeBadUpdate);

    const removal = await mutate(
      cookie, `/api/trips/${trip.id}/members/${editor.member.userId}`, "historical-removal", {}, "DELETE",
    );
    expect(removal.status).toBe(204);
    const rosterResponse = await app.request(`/api/trips/${trip.id}`, { headers: { cookie } });
    expect(parseTripResponse(await rosterResponse.json()).trip.members).toEqual([owner]);
    const removedParticipant = {
      memberId: editor.member.id, displayName: "Historical traveler",
      email: null, removed: true,
    };
    const removedRead = await readSkeleton(cookie, trip.id);
    expect(removedRead.items.find((entry) => entry.id === item.id)?.participants).toEqual([removedParticipant]);
    await expect(database.deleteFrom("trip_members")
      .where("trip_id", "=", trip.id).where("id", "=", editor.member.id).execute())
      .rejects.toMatchObject({ code: "23503" });
    expect((await readSkeleton(cookie, trip.id)).items.find((entry) => entry.id === item.id)?.participants).toEqual([removedParticipant]);

    const ordinaryEdit = await mutate(
      cookie, `/api/trips/${trip.id}/items/${item.id}`, "retain-removed-party",
      { ...base, title: "Renamed without losing history", expectedVersion: item.version }, "PATCH",
    );
    expect(ordinaryEdit.status).toBe(200);
    const retained = parseItineraryItemResponse(await ordinaryEdit.json()).item;
    expect(retained).toMatchObject({ id: item.id, participants: [removedParticipant] });
    const rejoinedWithHistory = await joinMember(
      cookie, trip.id, editor.member.email!, "historical-rejoin-with-reference", editor.cookie,
    );
    expect(rejoinedWithHistory.member.id).toBe(editor.member.id);
    expect((await readSkeleton(cookie, trip.id)).items.find((entry) => entry.id === item.id)).toMatchObject({
      id: item.id, version: retained.version,
      participants: [{ ...removedParticipant, email: editor.member.email, removed: false }],
    });
    const removedAgain = await mutate(
      cookie, `/api/trips/${trip.id}/members/${editor.member.userId}`, "historical-remove-again", {}, "DELETE",
    );
    expect(removedAgain.status).toBe(204);

    const clearResponse = await mutate(
      cookie, `/api/trips/${trip.id}/items/${item.id}`, "clear-removed-party",
      { ...base, expectedVersion: retained.version, participantMemberIds: null }, "PATCH",
    );
    expect(clearResponse.status).toBe(200);
    const cleared = parseItineraryItemResponse(await clearResponse.json()).item;
    expect(cleared.participants).toBeNull();
    const beforeReadd = await readSkeleton(cookie, trip.id);
    const readd = await mutate(
      cookie, `/api/trips/${trip.id}/items/${item.id}`, "readd-inactive-party",
      { ...base, expectedVersion: cleared.version }, "PATCH",
    );
    expect(readd.status).toBe(400);
    expect(await readSkeleton(cookie, trip.id)).toEqual(beforeReadd);
    const rejoined = await joinMember(
      cookie, trip.id, editor.member.email!, "historical-rejoin", editor.cookie,
    );
    expect(rejoined.member.id).toBe(editor.member.id);
    const restoredResponse = await mutate(
      cookie, `/api/trips/${trip.id}/items/${item.id}`, "readd-inactive-party",
      { ...base, expectedVersion: cleared.version }, "PATCH",
    );
    expect(restoredResponse.status).toBe(200);
    const restored = parseItineraryItemResponse(await restoredResponse.json()).item;
    expect(restored).toMatchObject({
      id: item.id, participants: [{ ...removedParticipant, email: editor.member.email, removed: false }],
    });
    const deleted = await mutate(
      cookie, `/api/trips/${trip.id}/items/${item.id}`, "delete-party-item",
      { expectedVersion: restored.version }, "DELETE",
    );
    expect(deleted.status).toBe(204);
    expect((await readSkeleton(cookie, trip.id)).items).toEqual(beforeInvalid.items);
    // Item cascade must release the history FK, without deleting the membership itself.
    const rosterAfterDeletion = await app.request(`/api/trips/${trip.id}`, { headers: { cookie } });
    expect(parseTripResponse(await rosterAfterDeletion.json()).trip.members
      .find((member) => member.id === editor.member.id)?.email).toBe(editor.member.email);
    await database.deleteFrom("trip_members")
      .where("trip_id", "=", trip.id).where("id", "=", editor.member.id).execute();
    const rosterAfterPhysicalDeletion = await app.request(`/api/trips/${trip.id}`, { headers: { cookie } });
    expect(parseTripResponse(await rosterAfterPhysicalDeletion.json()).trip.members).toEqual([owner]);
  });

  it("validates the participant after a concurrent membership removal commits", async () => {
    const cookie = await login();
    const trip = await createTrip(cookie);
    const editor = await joinMember(cookie, trip.id, "racing@example.test", "racing-member");
    const place = await createPlace(cookie, trip.id, "racing-place", {
      name: "Race boundary", type: "activity", timeZone: "Asia/Tokyo",
    });
    const before = await readSkeleton(cookie, trip.id);
    const fixture = before.items.find((item) => item.title === "FIXTURE-OUT")!;
    let pending: Promise<Response> | undefined;
    let settled = false;
    await database.transaction().execute(async (transaction) => {
      await transaction.selectFrom("trips").select("id").where("id", "=", trip.id)
        .forUpdate().executeTakeFirstOrThrow();
      pending = Promise.resolve(mutate(cookie, `/api/trips/${trip.id}/items/${fixture.id}`, "racing-party", {
        expectedVersion: fixture.version,
        type: "activity", title: "Must not add an inactive participant",
        participantMemberIds: [editor.member.id],
        endpoints: [{
          role: "start", countryStopId: trip.countryStops[0]!.id, placeId: place.id,
          localDateTime: "2026-10-21T10:00", timeZone: "Asia/Tokyo",
        }],
        details: { durationMinutes: 120, bookedBy: null, confirmationStatus: "unknown" },
      }, "PATCH"));
      void pending.then(() => { settled = true; }, () => { settled = true; });
      let waiting = false;
      for (let attempt = 0; attempt < 1_000; attempt += 1) {
        if (settled) throw new Error("Participant assignment bypassed the trip lifecycle lock");
        const result = await sql<{ waiting: boolean }>`
          select exists (
            select 1 from pg_stat_activity
            where datname = current_database() and pid <> pg_backend_pid()
              and wait_event_type = 'Lock' and query ilike '%trips%'
          ) as waiting
        `.execute(database);
        if (result.rows[0]?.waiting) {
          waiting = true;
          break;
        }
      }
      if (!waiting) throw new Error("Participant assignment did not reach the trip lifecycle lock");
      await transaction.updateTable("trip_members")
        .set({ removed_at: new Date("2026-09-28T12:00:00.000Z") })
        .where("trip_id", "=", trip.id).where("id", "=", editor.member.id).execute();
    });
    if (!pending) throw new Error("Expected an in-flight participant assignment");
    const response = await pending;
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "validation_error" } });
    expect(await readSkeleton(cookie, trip.id)).toEqual(before);
  });

  it("rejects timing a place while it has an unscheduled day assignment", async () => {
    const cookie = await login();
    const trip = await createTrip(cookie);
    const assignedPlace = await createPlace(cookie, trip.id, "create-assigned-place", {
      name: "Assigned temple",
      type: "activity",
      address: "Kyoto east",
      latitude: 35.001,
      longitude: 135.77,
      timeZone: "Asia/Tokyo",
      sourceUrl: null,
      notes: null,
    });
    const timedPlace = await createPlace(cookie, trip.id, "create-timed-place", {
      name: "Timed museum",
      type: "activity",
      address: "Kyoto west",
      latitude: 35.002,
      longitude: 135.76,
      timeZone: "Asia/Tokyo",
      sourceUrl: null,
      notes: null,
    });
    const wishlistResponse = await app.request(`/api/trips/${trip.id}/trip-places`, {
      headers: { cookie },
    });
    const assignedCandidate = parseTripPlaceListResponse(
      await wishlistResponse.json(),
    ).tripPlaces.find((place) => place.legacyPlaceId === assignedPlace.id)!;
    const assignment = await app.request(
      `/api/trips/${trip.id}/trip-place-day-assignments`,
      {
        method: "PUT",
        headers: {
          cookie,
          "content-type": "application/json",
          "idempotency-key": "assign-before-timing",
          origin: "https://app.example.test",
        },
        body: body({
          assignments: [{
            tripPlaceId: assignedCandidate.id,
            tripDayId: trip.days[0]!.id,
            expectedVersion: assignedCandidate.version,
          }],
        }),
      },
    );
    expect(assignment.status).toBe(200);
    const itemInput = (placeId: string, title: string) => ({
      type: "activity",
      title,
      notes: null,
      sourceUrl: null,
      money: null,
      participantMemberIds: null,
      endpoints: [{
        role: "start",
        countryStopId: trip.countryStops[0]!.id,
        placeId,
        localDateTime: "2026-10-21T10:00",
        timeZone: "Asia/Tokyo",
      }],
      details: {
        durationMinutes: 60,
        bookedBy: null,
        confirmationStatus: "unknown",
      },
      constraints: [],
    });

    const skeleton = await readSkeleton(cookie, trip.id);
    const rejectedFixture = skeleton.items.find((item) => item.title === "FIXTURE-OUT")!;
    const acceptedFixture = skeleton.items.find((item) => item.title === "FIXTURE-RETURN")!;
    const rejectedCreate = await app.request(`/api/trips/${trip.id}/items/${rejectedFixture.id}`, {
      method: "PATCH",
      headers: {
        cookie,
        "content-type": "application/json",
        "idempotency-key": "reject-assigned-item-create",
        origin: "https://app.example.test",
      },
      body: body({
        ...itemInput(assignedPlace.id, "Must remain untimed"),
        expectedVersion: rejectedFixture.version,
      }),
    });
    expect(rejectedCreate.status).toBe(409);
    expect(await rejectedCreate.json()).toMatchObject({
      error: {
        code: "conflict",
        message: "Remove the place from its unscheduled day before adding it to a timed itinerary item",
      },
    });

    const createdResponse = await app.request(`/api/trips/${trip.id}/items/${acceptedFixture.id}`, {
      method: "PATCH",
      headers: {
        cookie,
        "content-type": "application/json",
        "idempotency-key": "create-other-timed-item",
        origin: "https://app.example.test",
      },
      body: body({
        ...itemInput(timedPlace.id, "Timed museum visit"),
        expectedVersion: acceptedFixture.version,
      }),
    });
    expect(createdResponse.status).toBe(200);
    const created = parseItineraryItemResponse(await createdResponse.json()).item;
    const rejectedUpdate = await app.request(
      `/api/trips/${trip.id}/items/${created.id}`,
      {
        method: "PATCH",
        headers: {
          cookie,
          "content-type": "application/json",
          "idempotency-key": "reject-assigned-item-update",
          origin: "https://app.example.test",
        },
        body: body({
          ...itemInput(assignedPlace.id, "Must still remain untimed"),
          expectedVersion: created.version,
        }),
      },
    );
    expect(rejectedUpdate.status).toBe(409);
    expect(await rejectedUpdate.json()).toMatchObject({
      error: { code: "conflict" },
    });
  });
  it("keeps shared hotel enrichment when a stale lodging editor saves only times with omitted facts", async () => {
    const cookie = await login();
    const trip = await createTrip(cookie);
    const hotel = { name: "Shared unlocated hotel", timeZone: "Asia/Tokyo" };
    const firstInput = { hotel, countryStopId: trip.countryStops[0]!.id,
      checkInLocalDateTime: "2026-10-21T15:00", checkOutLocalDateTime: "2026-10-23T10:00" };
    const firstResponse = await mutate(cookie, `/api/trips/${trip.id}/lodgings`, "shared-stale-first", {
      ...firstInput, expectedTripVersion: await currentTripVersion(cookie, trip.id),
    });
    expect(firstResponse.status).toBe(201);
    const first = parseItineraryItemResponse(await firstResponse.json()).item;
    const secondInput = { ...firstInput, checkInLocalDateTime: "2026-10-23T15:00", checkOutLocalDateTime: "2026-10-25T10:00" };
    const secondResponse = await mutate(cookie, `/api/trips/${trip.id}/lodgings`, "shared-stale-second", {
      ...secondInput, expectedTripVersion: await currentTripVersion(cookie, trip.id),
    });
    expect(secondResponse.status).toBe(201);
    const second = parseItineraryItemResponse(await secondResponse.json()).item;
    const placeId = first.endpoints[0]!.placeId;
    expect(second.endpoints.map((endpoint) => endpoint.placeId)).toEqual([placeId, placeId]);
    expect((await readSkeleton(cookie, trip.id)).places.find((place) => place.id === placeId))
      .toMatchObject({ latitude: null, longitude: null });
    const enrichedResponse = await mutate(cookie, `/api/trips/${trip.id}/lodgings/${first.id}`, "shared-stale-enrich", {
      ...firstInput, hotel: { ...hotel, address: "Updated address", latitude: 35, longitude: 135, sourceUrl: "https://example.test/shared-hotel" },
      expectedVersion: first.version,
    }, "PATCH");
    expect(enrichedResponse.status).toBe(200);
    const enriched = parseItineraryItemResponse(await enrichedResponse.json()).item;
    const stored = (await readSkeleton(cookie, trip.id)).places.find((place) => place.id === placeId)!;
    expect(stored).toMatchObject({ latitude: 35, longitude: 135, address: "Updated address", sourceUrl: "https://example.test/shared-hotel" });
    // The second editor still has its original item version and loaded null facts.
    // Its time-only request omits those facts instead of writing the stale nulls back.
    const timeOnly = await mutate(cookie, `/api/trips/${trip.id}/lodgings/${second.id}`, "shared-stale-time", {
      ...secondInput, checkOutLocalDateTime: "2026-10-26T11:00", expectedVersion: second.version,
    }, "PATCH");
    expect(timeOnly.status).toBe(200);
    expect(parseItineraryItemResponse(await timeOnly.json()).item.endpoints.find((endpoint) => endpoint.role === "end"))
      .toMatchObject({ placeId, localDateTime: "2026-10-26T11:00" });
    expect((await readSkeleton(cookie, trip.id)).places.find((place) => place.id === placeId)).toEqual(stored);
    // Explicitly clearing individual facts remains supported without clearing omitted coordinates.
    const cleared = await mutate(cookie, `/api/trips/${trip.id}/lodgings/${first.id}`, "shared-explicit-clear", {
      ...firstInput, hotel: { ...hotel, address: null, sourceUrl: null }, expectedVersion: enriched.version,
    }, "PATCH");
    expect(cleared.status).toBe(200);
    expect((await readSkeleton(cookie, trip.id)).places.find((place) => place.id === placeId))
      .toMatchObject({ latitude: 35, longitude: 135, address: null, sourceUrl: null, version: stored.version + 1 });
    // A one-sided coordinate would split the stored pair, so it is refused and nothing changes.
    const afterClear = (await readSkeleton(cookie, trip.id)).places.find((place) => place.id === placeId)!;
    const oneSided = await mutate(cookie, `/api/trips/${trip.id}/lodgings/${first.id}`, "shared-one-sided", {
      ...firstInput, hotel: { ...hotel, latitude: null }, expectedVersion: enriched.version + 1,
    }, "PATCH");
    expect(oneSided.status).toBe(400);
    expect(await oneSided.json()).toMatchObject({ error: { code: "validation_error" } });
    expect((await readSkeleton(cookie, trip.id)).places.find((place) => place.id === placeId)).toEqual(afterClear);
  });

















  describe("day title, 玩法 note and 備案", () => {
    async function addPocketPlace(cookie: string, tripId: string, key: string, name: string) {
      const response = await mutate(cookie, `/api/trips/${tripId}/trip-places`, key, {
        method: "manual", name, type: "restaurant", address: null, latitude: 35.0, longitude: 135.77,
        timeZone: "Asia/Tokyo", sourceUrl: null, originalNote: null,
      });
      expect(response.status, await response.clone().text()).toBe(201);
      return parseTripPlaceResponse(await response.json()).tripPlace;
    }

    it("saves a normalized day title and note under their own version, replays a retry and refuses a stale write", async () => {
      const cookie = await login();
      const trip = await createTrip(cookie);
      const day = (await readSkeleton(cookie, trip.id)).days[1]!;
      expect(day).toMatchObject({ title: null, note: null, detailsVersion: 1 });

      const path = `/api/trips/${trip.id}/days/${day.id}/details`;
      const payload = { expectedVersion: 1, title: "  京都\n賞楓日 ", note: "早上先去伏見稻荷\r\n中午吃錦市場  " };
      const saved = await mutate(cookie, path, "day-details-1", payload, "PUT");
      expect(saved.status, await saved.clone().text()).toBe(200);
      expect((await saved.json()).day).toMatchObject({ title: "京都 賞楓日", note: "早上先去伏見稻荷\n中午吃錦市場", detailsVersion: 2 });
      // Same key, same body after a dropped response: the stored result, not a version conflict.
      const replay = await mutate(cookie, path, "day-details-1", payload, "PUT");
      expect(replay.status).toBe(200);
      expect((await replay.json()).day.detailsVersion).toBe(2);

      const stale = await mutate(cookie, path, "day-details-stale", { expectedVersion: 1, title: "別人的標題", note: null }, "PUT");
      expect(stale.status).toBe(409);
      const cleared = await mutate(cookie, path, "day-details-clear", { expectedVersion: 2, title: "   ", note: "" }, "PUT");
      expect((await cleared.json()).day).toMatchObject({ title: null, note: null, detailsVersion: 3 });
      const tooLong = await mutate(cookie, path, "day-details-long", { expectedVersion: 3, title: "長".repeat(61), note: null }, "PUT");
      expect(tooLong.status).toBe(400);

      const after = (await readSkeleton(cookie, trip.id)).days.find((entry) => entry.id === day.id)!;
      expect(after).toMatchObject({ title: null, note: null, detailsVersion: 3 });
    });

    it("lets only members who can arrange the itinerary edit a day's words", async () => {
      const ownerCookie = await login();
      const trip = await createTrip(ownerCookie);
      const { cookie: editorCookie } = await joinMember(ownerCookie, trip.id, "editor@example.test", "day-details-editor");
      const day = (await readSkeleton(ownerCookie, trip.id)).days[0]!;
      const refused = await mutate(editorCookie, `/api/trips/${trip.id}/days/${day.id}/details`, "editor-details",
        { expectedVersion: 1, title: "編輯者的標題", note: null }, "PUT");
      expect(refused.status).toBe(403);
      const alternatives = await mutate(editorCookie, `/api/trips/${trip.id}/days/${day.id}/alternatives`, "editor-alternatives",
        { expectedVersion: 1, tripPlaceIds: [] }, "PUT");
      expect(alternatives.status).toBe(403);
      expect((await readSkeleton(ownerCookie, trip.id)).days[0]).toMatchObject({ title: null, detailsVersion: 1, alternativesVersion: 1 });
    });

    it("accepts a 待安排 place as 備案, rejects scheduled places, and drops removed places", async () => {
      const cookie = await login();
      const trip = await createTrip(cookie);
      const [first, second] = (await readSkeleton(cookie, trip.id)).days;
      const steak = await addPocketPlace(cookie, trip.id, "alt-steak", "牛排店");
      const ramen = await addPocketPlace(cookie, trip.id, "alt-ramen", "拉麵店");
      const planned = await addPocketPlace(cookie, trip.id, "alt-planned", "原本的午餐");
      const pending = await addPocketPlace(cookie, trip.id, "alt-pending", "AI 待安排餐廳");
      const scheduled = await addPocketPlace(cookie, trip.id, "alt-scheduled", "已排時間餐廳");
      await database.updateTable("trip_places").set({ selected_for_itinerary: true })
        .where("trip_id", "=", trip.id).where("id", "=", pending.id).execute();
      await seedItem(trip.members[0]!.userId, trip.id, {
        type: "activity",
        title: "已排時間餐廳",
        participantMemberIds: null,
        endpoints: [{
          role: "start",
          countryStopId: trip.countryStops[0]!.id,
          placeId: scheduled.legacyPlaceId!,
          localDateTime: "2026-10-21T12:00",
          timeZone: "Asia/Tokyo",
        }],
        details: { durationMinutes: 60, bookedBy: null, confirmationStatus: null },
        constraints: [],
      });
      const assigned = await mutate(cookie, `/api/trips/${trip.id}/trip-place-day-assignments`, "alt-assign", {
        assignments: [{ tripPlaceId: planned.id, tripDayId: first!.id, expectedVersion: planned.version }],
      }, "PUT");
      expect(assigned.status, await assigned.clone().text()).toBe(200);

      const path = `/api/trips/${trip.id}/days/${first!.id}/alternatives`;
      const assignedRefused = await mutate(cookie, path, "alt-planned-refused",
        { expectedVersion: 1, tripPlaceIds: [planned.id] }, "PUT");
      expect(assignedRefused.status).toBe(400);
      const scheduledRefused = await mutate(cookie, path, "alt-scheduled-refused",
        { expectedVersion: 1, tripPlaceIds: [scheduled.id] }, "PUT");
      expect(scheduledRefused.status).toBe(400);
      const saved = await mutate(cookie, path, "alt-save",
        { expectedVersion: 1, tripPlaceIds: [pending.id, ramen.id, steak.id] }, "PUT");
      expect(saved.status, await saved.clone().text()).toBe(200);
      expect((await saved.json()).day).toEqual({
        id: first!.id,
        alternativeTripPlaceIds: [pending.id, ramen.id, steak.id],
        alternativesVersion: 2,
      });
      const stale = await mutate(cookie, path, "alt-stale", { expectedVersion: 1, tripPlaceIds: [] }, "PUT");
      expect(stale.status).toBe(409);

      const skeleton = await readSkeleton(cookie, trip.id);
      expect(skeleton.days.find((day) => day.id === first!.id)).toMatchObject({
        alternativeTripPlaceIds: [pending.id, ramen.id, steak.id],
        alternativesVersion: 2,
      });
      expect(skeleton.days.find((day) => day.id === second!.id)).toMatchObject({ alternativeTripPlaceIds: [], alternativesVersion: 1 });
      const places = parseTripPlaceListResponse(await (await app.request(`/api/trips/${trip.id}/trip-places`, { headers: { cookie } })).json()).tripPlaces;
      // Backups stay off a day; an accepted AI place may remain selected while it is 待安排.
      for (const id of [ramen.id, steak.id]) {
        expect(places.find((place) => place.id === id)).toMatchObject({ selectedForItinerary: false, assignedDayId: null });
      }
      expect(places.find((place) => place.id === pending.id)).toMatchObject({
        selectedForItinerary: true,
        assignedDayId: null,
        scheduled: false,
      });

      const ramenNow = places.find((place) => place.id === ramen.id)!;
      const removed = await mutate(cookie, `/api/trips/${trip.id}/trip-places/${ramen.id}/remove`, "alt-remove-ramen", { expectedVersion: ramenNow.version });
      expect(removed.status, await removed.clone().text()).toBe(204);
      expect((await readSkeleton(cookie, trip.id)).days.find((day) => day.id === first!.id)!.alternativeTripPlaceIds)
        .toEqual([pending.id, steak.id]);
    });
  });

  describe("activity participant migration in its dedicated database", () => {
    let mainDatabase: Kysely<AlongTheWayDatabase>;
    let migrationDatabase: Kysely<AlongTheWayDatabase>;
    let migrator: Migrator;

    beforeAll(async () => {
      mainDatabase = database;
      const migrationUrl = new URL(databaseUrl);
      if (migrationUrl.pathname === "/along_the_way_participants_migration") {
        throw new Error("The migration regression requires a database separate from TEST_DATABASE_URL");
      }
      migrationUrl.pathname = "/along_the_way_participants_migration";
      // CI provisions only TEST_DATABASE_URL; create the sibling database on that same server.
      const existing = await sql<{ present: boolean }>`
        select exists (
          select 1 from pg_database where datname = 'along_the_way_participants_migration'
        ) as present
      `.execute(mainDatabase);
      if (!existing.rows[0]?.present) {
        await sql`create database along_the_way_participants_migration`.execute(mainDatabase);
      }
      migrationDatabase = createDatabase(migrationUrl.toString());
      database = migrationDatabase;
      migrator = new Migrator({
        db: migrationDatabase,
        provider: new FileMigrationProvider({
          fs, path,
          migrationFolder: fileURLToPath(new URL("../src/database/migrations", import.meta.url)),
        }),
      });
      await runMigrations(migrationDatabase);
    });

    afterAll(async () => {
      database = mainDatabase;
      await migrationDatabase?.destroy();
    });

  it("backfills notes consistently and reopens removed accepted proposals in 017 without restoring data on down", async () => {
      const historicalTime = new Date("2026-09-28T12:00:00.000Z");
      const cookie = await login();
      const trip = await createTrip(cookie);
      const ownerId = trip.members[0]!.userId;
      const ordered = await createPlace(cookie, trip.id, "backfill-ordered", { name: "Ordered notes", type: "activity", notes: null });
      const capped = await createPlace(cookie, trip.id, "backfill-capped", { name: "Long notes", type: "activity", notes: null });
      const kept = await createPlace(cookie, trip.id, "backfill-kept", { name: "Existing notes", type: "activity", notes: "Keep the edited note" });
      const empty = await createPlace(cookie, trip.id, "backfill-empty", { name: "No notes", type: "activity", notes: null });
      const ahead = await createPlace(cookie, trip.id, "backfill-ahead", { name: "Unreconciled place", type: "activity", notes: null });
      const newerNote = await createPlace(cookie, trip.id, "backfill-newer-note", { name: "Newer legacy note", type: "activity", notes: null });
      const originalIntake = await createPlace(cookie, trip.id, "backfill-original-intake", {
        name: "Pre-017 intake", type: "activity", notes: "Sunset if possible",
      });
      const wishlistIds = new Map(
        (await database.selectFrom("trip_places").select(["id", "legacy_place_id"])
          .where("trip_id", "=", trip.id).execute())
          .map((row) => [row.legacy_place_id, row.id]),
      );
      const wishlistId = (place: PlaceDto) => wishlistIds.get(place.id)!;
      const before = await readSkeleton(cookie, trip.id);
      try {
        const old = await migrator.migrateTo("016_travel_places");
        if (old.error) throw old.error;
        // ac431b4 intake populated the legacy/contribution note, but left its equal-version mirror null.
        await database.updateTable("trip_places").set({ notes: null })
          .where("id", "=", wishlistId(originalIntake)).execute();
        expect(await database.selectFrom("trip_places").select(["notes", "legacy_place_version"])
          .where("id", "=", wishlistId(originalIntake)).executeTakeFirstOrThrow())
          .toEqual({ notes: null, legacy_place_version: originalIntake.version });
        expect(await database.selectFrom("places").select(["notes", "version"])
          .where("id", "=", originalIntake.id).executeTakeFirstOrThrow())
          .toEqual({ notes: "Sunset if possible", version: originalIntake.version });
        await database.updateTable("places").set({
          name: "Corrected legacy name", address: "Corrected legacy address", version: sql`version + 1`,
        }).where("id", "=", ahead.id).execute();
        await database.updateTable("places").set({
          notes: "Newer note from retained release", version: sql`version + 1`,
        }).where("id", "=", newerNote.id).execute();
        for (const [place, notes] of [
          [ordered, ["First note", "Second note", "First note", "   "]],
          [capped, ["x".repeat(10_010)]],
          [kept, ["Do not replace the edited note"]],
          [empty, ["   "]],
          [ahead, ["Original contribution note"]],
          [newerNote, ["Must not overwrite the newer note"]],
          [originalIntake, ["Sunset if possible"]],
        ] as const) {
          await database.deleteFrom("trip_place_contributions")
            .where("trip_place_id", "=", wishlistId(place)).execute();
          for (const [index, note] of notes.entries()) {
            await database.insertInto("trip_place_contributions").values({
              trip_id: trip.id, trip_place_id: wishlistId(place), member_user_id: ownerId,
              intake_method: "manual", original_note: note, source_url: null,
              provider_observed_at: null, withdrawn_at: index === 1 ? historicalTime : null,
              created_at: new Date(`2026-09-${20 + index}T12:00:00.000Z`),
            }).execute();
          }
        }
        await database.updateTable("trip_places").set({ archived_at: historicalTime })
          .where("id", "=", wishlistId(ordered)).execute();
        const run = await sql<{ id: string }>`
          insert into discovery_runs (trip_id, brief_version, policy_version, model_id, status, search_plan, created_by)
          values (${trip.id}, 1, 'migration-fixture', 'fixture', 'completed', '{}'::jsonb, ${ownerId})
          returning id
        `.execute(database);
        const proposals: Record<string, string> = {};
        for (const [state, placeId] of [
          ["archived", wishlistId(ordered)],
          ["missing", null],
          ["active", wishlistId(kept)],
        ] as const) {
          const proposal = await sql<{ id: string }>`
            insert into candidate_proposals (
              trip_id, run_id, provider_place_id, name, place_type, recommendation, matched_needs,
              tradeoffs, unknowns, confidence, status, decided_by, decided_at, accepted_trip_place_id, version
            ) values (
              ${trip.id}, ${run.rows[0]!.id}, ${state}, ${state}, 'activity', 'Historical recommendation',
              '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'medium', 'accepted', ${ownerId}, now(), ${placeId}, 4
            ) returning id
          `.execute(database);
          proposals[state] = proposal.rows[0]!.id;
          await database.insertInto("discovery_proposal_votes").values({
            trip_id: trip.id, proposal_id: proposal.rows[0]!.id, member_user_id: ownerId,
          }).execute();
        }
        const votesBefore = await database.selectFrom("discovery_proposal_votes").selectAll().orderBy("proposal_id").execute();
        const contributionsBefore = await database.selectFrom("trip_place_contributions").selectAll().orderBy("id").execute();
        const versionsBefore = await database.selectFrom("trip_places")
          .select(["id", "version", "legacy_place_version"]).orderBy("id").execute();
        const legacyVersionsBefore = await database.selectFrom("places").select(["id", "version"]).orderBy("id").execute();
        const upgraded = await migrator.migrateToLatest();
        if (upgraded.error) throw upgraded.error;
        for (const [place, notes] of [
          [ordered, "First note\n\nSecond note"],
          [capped, "x".repeat(10_000)],
          [kept, "Keep the edited note"],
          [empty, null],
          [ahead, "Original contribution note"],
          [originalIntake, "Sunset if possible"],
        ] as const) {
          const wishlist = await database.selectFrom("trip_places").select(["notes", "legacy_place_version"])
            .where("id", "=", wishlistId(place)).executeTakeFirstOrThrow();
          const legacy = await database.selectFrom("places").select(["notes", "version"])
            .where("id", "=", place.id).executeTakeFirstOrThrow();
          expect(wishlist.notes).toBe(notes);
          expect(legacy.notes).toBe(notes);
          expect(wishlist.legacy_place_version).toBe(place.version);
        }
        expect(await database.selectFrom("trip_places").select(["id", "version", "legacy_place_version"]).orderBy("id").execute())
          .toEqual(versionsBefore);
        expect(await database.selectFrom("places").select(["id", "version"]).orderBy("id").execute()).toEqual(legacyVersionsBefore);
        expect((await database.selectFrom("trip_places").select("notes")
          .where("id", "=", wishlistId(newerNote)).executeTakeFirstOrThrow()).notes)
          .toBe("Newer note from retained release");
        expect((await database.selectFrom("places").select("notes").where("id", "=", newerNote.id).executeTakeFirstOrThrow()).notes)
          .toBe("Newer note from retained release");
        for (const state of ["archived", "missing"]) {
          expect(await database.selectFrom("candidate_proposals")
            .select(["status", "decided_by", "decided_at", "accepted_trip_place_id", "version"])
            .where("id", "=", proposals[state]!).executeTakeFirstOrThrow()).toEqual({
              status: "pending", decided_by: null, decided_at: null, accepted_trip_place_id: null, version: 5,
            });
          expect((await database.selectFrom("candidate_proposals").select("reopened_at")
            .where("id", "=", proposals[state]!).executeTakeFirstOrThrow()).reopened_at).not.toBeNull();
        }
        expect(await database.selectFrom("candidate_proposals").select(["status", "accepted_trip_place_id", "version"])
          .where("id", "=", proposals.active!).executeTakeFirstOrThrow())
          .toEqual({ status: "accepted", accepted_trip_place_id: wishlistId(kept), version: 4 });
        expect(await database.selectFrom("discovery_proposal_votes").selectAll().orderBy("proposal_id").execute()).toEqual(votesBefore);
        expect(await database.selectFrom("trip_place_contributions").selectAll().orderBy("id").execute()).toEqual(contributionsBefore);
        expect(await database.selectFrom("change_events").select("target_id")
          .where("event_type", "=", "discovery.proposal_reopened").orderBy("target_id").execute())
          .toEqual([proposals.archived!, proposals.missing!].sort().map((target_id) => ({ target_id })));
        const after = await readSkeleton(cookie, trip.id);
        expect(after.items).toEqual(before.items);
        expect(after.days).toEqual(before.days);
        const listed = await app.request(`/api/trips/${trip.id}/trip-places`, { headers: { cookie } });
        const projected = parseTripPlaceListResponse(await listed.json()).tripPlaces;
        expect(projected.find((place) => place.id === wishlistId(capped))?.notes).toBe("x".repeat(10_000));
        expect(projected.find((place) => place.id === wishlistId(ahead))).toMatchObject({
          name: "Corrected legacy name", address: "Corrected legacy address", notes: "Original contribution note",
        });
        expect(projected.find((place) => place.id === wishlistId(newerNote))?.notes).toBe("Newer note from retained release");
        expect(projected.find((place) => place.id === wishlistId(originalIntake))?.notes).toBe("Sunset if possible");
        const placesAfter = await database.selectFrom("trip_places").selectAll().orderBy("id").execute();
        const proposalsAfter = await database.selectFrom("candidate_proposals").selectAll().orderBy("id").execute();
        const downgraded = await migrator.migrateTo("016_travel_places");
        if (downgraded.error) throw downgraded.error;
        expect(await database.selectFrom("trip_places").selectAll().orderBy("id").execute())
          .toEqual(placesAfter.map(({ selected_for_itinerary: _selected, unplaced_from_date: _unplaced, effort_level: _effort, ...place }) => place));
        expect(await database.selectFrom("candidate_proposals").selectAll().orderBy("id").execute())
          .toEqual(proposalsAfter.map(({ reopened_at: _reopenedAt, ...proposal }) => proposal));
      } finally {
        const restored = await migrator.migrateToLatest();
        if (restored.error) throw restored.error;
      }
    });

  it("archives only exclusively travel-used wishlist places in 016 and never rewrites formal itinerary content", async () => {
      const cookie = await login();
      const trip = await createTrip(cookie);
      const travel = await createPlace(cookie, trip.id, "legacy-travel-hotel", { name: "Legacy hotel", type: "lodging", timeZone: "Asia/Tokyo" });
      const mixed = await createPlace(cookie, trip.id, "legacy-mixed-hotel", { name: "Hotel with a visit", type: "lodging", timeZone: "Asia/Tokyo" });
      const placeRows = await database.selectFrom("trip_places").select(["id", "legacy_place_id"])
        .where("trip_id", "=", trip.id).execute();
      const travelTripPlaceId = placeRows.find((row) => row.legacy_place_id === travel.id)!.id;
      const mixedTripPlaceId = placeRows.find((row) => row.legacy_place_id === mixed.id)!.id;
      for (const [index, place] of [travel, mixed].entries()) {
        const checkInDay = 21 + index * 2;
        const checkOutDay = 23 + index * 2;
        await seedItem(trip.members[0]!.userId, trip.id, {
          type: "lodging", title: place.name, participantMemberIds: null,
          endpoints: [
            { role: "start", placeId: place.id, countryStopId: trip.countryStops[0]!.id, timeZone: "Asia/Tokyo", localDateTime: `2026-10-${checkInDay}T15:00` },
            { role: "end", placeId: place.id, countryStopId: trip.countryStops[0]!.id, timeZone: "Asia/Tokyo", localDateTime: `2026-10-${checkOutDay}T10:00` },
          ],
          details: { bookedBy: "Original booker", confirmationCode: "Original confirmation" }, constraints: [],
        });
      }
      await seedItem(trip.members[0]!.userId, trip.id, {
        type: "activity", title: "Hotel restaurant visit", participantMemberIds: null,
        endpoints: [{ role: "start", placeId: mixed.id, countryStopId: trip.countryStops[0]!.id, timeZone: "Asia/Tokyo", localDateTime: "2026-10-22T12:00" }],
        details: { durationMinutes: 60, bookedBy: null, confirmationStatus: null }, constraints: [],
      });
      const before = await readSkeleton(cookie, trip.id);
      const contributions = await database.selectFrom("trip_place_contributions").selectAll()
        .where("trip_place_id", "in", [travelTripPlaceId, mixedTripPlaceId]).orderBy("id").execute();
      try {
        const old = await migrator.migrateTo("015_member_votes");
        if (old.error) throw old.error;
        // Reconstruct pre-016 data, including an assignment made by a retained release.
        for (const tripPlaceId of [travelTripPlaceId, mixedTripPlaceId]) {
          await database.insertInto("trip_place_votes").values({
            trip_id: trip.id, trip_place_id: tripPlaceId, member_user_id: trip.members[0]!.userId,
          }).execute();
          await database.insertInto("trip_place_desired_days").values({
            trip_id: trip.id, trip_place_id: tripPlaceId, trip_day_id: trip.days[0]!.id,
          }).execute();
          await database.insertInto("trip_place_excluded_days").values({
            trip_id: trip.id, trip_place_id: tripPlaceId, trip_day_id: trip.days[1]!.id,
          }).execute();
        }
        const upgraded = await migrator.migrateToLatest();
        if (upgraded.error) throw upgraded.error;
        const wishlist = await app.request(`/api/trips/${trip.id}/trip-places`, { headers: { cookie } });
        expect(parseTripPlaceListResponse(await wishlist.json()).tripPlaces.map((place) => place.id)).toEqual([mixedTripPlaceId]);
        const after = await readSkeleton(cookie, trip.id);
        expect(after.items).toEqual(before.items);
        expect(after.places).toEqual(before.places);
        expect(after.days).toEqual(before.days);
        expect(await database.selectFrom("trip_place_contributions").selectAll()
          .where("trip_place_id", "in", [travelTripPlaceId, mixedTripPlaceId]).orderBy("id").execute()).toEqual(contributions);
        for (const table of ["trip_place_votes", "trip_place_day_assignments", "trip_place_desired_days", "trip_place_excluded_days"] as const) {
          expect(await database.selectFrom(table).selectAll().where("trip_place_id", "=", travelTripPlaceId).execute(), table).toEqual([]);
          expect(await database.selectFrom(table).select("trip_place_id").where("trip_place_id", "=", mixedTripPlaceId).execute(), table)
            .toEqual([{ trip_place_id: mixedTripPlaceId }]);
        }
        expect(await database.selectFrom("places").select(["id", "travel_only"]).where("id", "in", [travel.id, mixed.id]).orderBy("name").execute())
          .toEqual([{ id: mixed.id, travel_only: false }, { id: travel.id, travel_only: true }]);
        const downgraded = await migrator.migrateTo("015_member_votes");
        if (downgraded.error) throw downgraded.error;
        expect((await database.selectFrom("trip_places").select("archived_at")
          .where("id", "=", travelTripPlaceId).executeTakeFirstOrThrow()).archived_at).not.toBeNull();
      } finally {
        const restored = await migrator.migrateToLatest();
        if (restored.error) throw restored.error;
      }
    });

  it("clears old choices but keeps their table for a rolled-back release, and restores the delete guard on downgrade", async () => {
      const cookie = await login();
      const trip = await createTrip(cookie);
      await joinMember(cookie, trip.id, "migration-voter@example.test", "migration-voter");
      const place = await createPlace(cookie, trip.id, "vote-migration-place", {
        name: "Migration cafe", type: "activity", timeZone: "Asia/Tokyo",
      });
      const listed = await app.request(`/api/trips/${trip.id}/trip-places`, { headers: { cookie } });
      const tripPlace = parseTripPlaceListResponse(await listed.json()).tripPlaces[0]!;
      try {
        const old = await migrator.migrateTo("014_discovery_feedback_answers");
        if (old.error) throw old.error;
        await sql`
          insert into member_place_preferences (trip_id, trip_place_id, member_user_id, preference)
          values (${trip.id}, ${tripPlace.id}, ${trip.members[0]!.userId}, 'must')
        `.execute(database);
        await expect(database.deleteFrom("places").where("id", "=", place.id).execute()).rejects.toMatchObject({ code: "23503" });
        const upgraded = await migrator.migrateToLatest();
        if (upgraded.error) throw upgraded.error;
        expect((await sql`select * from member_place_preferences`.execute(database)).rows).toEqual([]);
        const after = await app.request(`/api/trips/${trip.id}/trip-places`, { headers: { cookie } });
        expect(parseTripPlaceListResponse(await after.json()).tripPlaces[0]).toMatchObject({
          voteCount: 0, ownVote: false, voters: [], votingAvailable: true,
        });
        expect((await mutate(cookie, `/api/trips/${trip.id}/trip-places/${tripPlace.id}/vote`, "migrated-vote", { voted: true }, "PUT")).status).toBe(200);
        const downgraded = await migrator.migrateTo("014_discovery_feedback_answers");
        if (downgraded.error) throw downgraded.error;
        expect((await sql`select * from member_place_preferences`.execute(database)).rows).toEqual([]);
        await sql`
          insert into member_place_preferences (trip_id, trip_place_id, member_user_id, preference)
          values (${trip.id}, ${tripPlace.id}, ${trip.members[0]!.userId}, 'want')
        `.execute(database);
        await expect(database.deleteFrom("places").where("id", "=", place.id).execute()).rejects.toMatchObject({ code: "23503" });
      } finally {
        const restored = await migrator.migrateToLatest();
        if (restored.error) throw restored.error;
      }
    });
    it("lets new proposals omit confidence in 018 while every row stays readable by the previous release", async () => {
      const cookie = await login();
      const trip = await createTrip(cookie);
      const ownerId = trip.members[0]!.userId;
      const run = await sql<{ id: string }>`
        insert into discovery_runs (trip_id, brief_version, policy_version, model_id, status, search_plan, created_by)
        values (${trip.id}, 1, 'confidence-free', 'test', 'completed', '{}'::jsonb, ${ownerId})
        returning id
      `.execute(database);
      const proposal = await sql<{ id: string; confidence: string | null }>`
        insert into candidate_proposals (
          trip_id, run_id, provider_place_id, name, place_type, recommendation,
          matched_needs, tradeoffs, unknowns
        ) values (
          ${trip.id}, ${run.rows[0]!.id}, 'confidence-free-place', 'Confidence-free place',
          'activity', 'Recommendation', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb
        ) returning id, confidence
      `.execute(database);
      // The previous release still parses high/medium/low, so omitted writes must not be null.
      expect(proposal.rows[0]?.confidence).toBe("medium");
      const columnDefault = () => sql<{ column_default: string | null }>`
        select column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'candidate_proposals' and column_name = 'confidence'
      `.execute(database);
      try {
        const downgraded = await migrator.migrateTo("017_wishlist_simplify");
        if (downgraded.error) throw downgraded.error;
        expect((await columnDefault()).rows[0]?.column_default).toBeNull();
      } finally {
        const restored = await migrator.migrateToLatest();
        if (restored.error) throw restored.error;
      }
      expect((await columnDefault()).rows[0]?.column_default).toContain("medium");
    });







  });
});
