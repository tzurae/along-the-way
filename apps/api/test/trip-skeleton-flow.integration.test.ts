import { parseTripHistoryResponse } from "@along-the-way/contracts/private-trips";
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
} from "@along-the-way/contracts/trip-skeleton";
import type { ItineraryItemDto } from "@along-the-way/contracts/trip-skeleton";
import { parseTripResponse } from "@along-the-way/contracts/private-trips";
import { parseTripPlaceListResponse } from "@along-the-way/contracts/trip-places";

import { createApp } from "../src/app";
import { PostgresPlaceDetailModule } from "../src/place-details/postgres-place-detail-module";
import { packagedPhotoRoot } from "../src/place-details/photo-assets";
import { createDatabase, type AlongTheWayDatabase } from "../src/database/database";
import { runMigrations } from "../src/database/migrate";
import { seedDatabase } from "../src/database/seed";
import { OpenAiResponsesDiscoveryModel } from "../src/discovery/openai-responses-discovery-model";
import { PostgresDiscoveryModule } from "../src/discovery/postgres-discovery-module";
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
    app = createApp({
      placeDetails: new PostgresPlaceDetailModule({ database, assetRoot: packagedPhotoRoot }),
      collaboration: new PostgresCollaborationModule(database),
      dayPlans: unrelatedDayPlanModule,
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
    const cookie = existingCookie ?? await login(address, token);
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

  it("creates a shared pair atomically, reuses travel airports and replays old flightless request bodies", async () => {
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
    expect((await mutate(cookie, `/api/trips/${trip.id}/items`, "shared-airport-visit", {
      type: "activity", title: "Airport observation deck", participantMemberIds: null,
      endpoints: [{ role: "start", countryStopId: trip.countryStops[0]!.id, placeId: sharedPlace.id,
        localDateTime: "2026-10-22T12:00", timeZone: "Asia/Tokyo" }],
      details: { durationMinutes: 60, bookedBy: null, confirmationStatus: null },
      expectedTripVersion: await currentTripVersion(cookie, trip.id),
    })).status).toBe(201);
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
    const endpoint = (placeId: string, localDateTime: string, role = "start") => ({
      role, placeId, countryStopId: trip.countryStops[0]!.id, timeZone: "Asia/Tokyo", localDateTime,
    });
    for (const place of [airport, hotel]) {
      expect((await mutate(cookie, `/api/trips/${trip.id}/items`, `visit-${place.id}`, {
        type: "activity", title: `Visit ${place.name}`, participantMemberIds: null,
        endpoints: [endpoint(place.id, "2026-10-22T12:00")], details: { durationMinutes: 30, bookedBy: null, confirmationStatus: null },
        expectedTripVersion: await currentTripVersion(cookie, trip.id),
      })).status).toBe(201);
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
    const stay = await mutate(cookie, `/api/trips/${trip.id}/items`, "legacy-stay", {
      type: "lodging", title: "Legacy booking", participantMemberIds: null,
      endpoints: [endpoint(hotel.id, "2026-10-21T15:00"), endpoint(hotel.id, "2026-10-23T10:00", "end")],
      details: { bookedBy: null, confirmationCode: null }, expectedTripVersion: await currentTripVersion(cookie, trip.id),
    });
    expect(stay.status).toBe(201);
    const lodging = parseItineraryItemResponse(await stay.json()).item;
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
    const secondResponse = await mutate(cookie, `/api/trips/${trip.id}/lodgings`, "shared-hotel-facts", {
      ...input, hotel: facts, expectedTripVersion: await currentTripVersion(cookie, trip.id),
    });
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
    expect((await mutate(cookie, `/api/trips/${trip.id}/items`, "hotel-nontravel-use", {
      type: "activity", title: "Hotel restaurant", participantMemberIds: null,
      endpoints: [{ role: "start", placeId, countryStopId: trip.countryStops[0]!.id, timeZone: "Asia/Tokyo", localDateTime: "2026-10-22T12:00" }],
      details: { durationMinutes: 60, bookedBy: null, confirmationStatus: null }, expectedTripVersion: await currentTripVersion(cookie, trip.id),
    })).status).toBe(201);
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

  it("reloads independent activities and changes a shared party without duplicating the item", async () => {
    const cookie = await login();
    const trip = await createTrip(cookie);
    const owner = trip.members[0]!;
    const initialItems = (await readSkeleton(cookie, trip.id)).items;
    const editor = await joinMember(cookie, trip.id, "second@example.test", "party-second");
    await joinMember(cookie, trip.id, "third@example.test", "party-third");
    const fourth = await joinMember(cookie, trip.id, "fourth@example.test", "party-fourth");
    const place = await createPlace(cookie, trip.id, "party-place", {
      name: "Meeting point", type: "activity", timeZone: "Asia/Tokyo",
    });
    const base = {
      type: "activity",
      title: "A / 甲",
      participantMemberIds: [owner.id],
      endpoints: [{
        role: "start", countryStopId: trip.countryStops[0]!.id, placeId: place.id,
        localDateTime: "2026-10-21T10:00", timeZone: "Asia/Tokyo",
      }],
      details: { durationMinutes: 120, bookedBy: null, confirmationStatus: "unknown" },
    };
    const createPayload = {
      ...base, expectedTripVersion: await currentTripVersion(cookie, trip.id),
    };
    const first = await mutate(cookie, `/api/trips/${trip.id}/items`, "party-a", createPayload);
    expect(first.status).toBe(201);
    const a = parseItineraryItemResponse(await first.json()).item;
    const second = await mutate(editor.cookie, `/api/trips/${trip.id}/items`, "party-b", {
      ...base,
      title: "B / 乙",
      participantMemberIds: [editor.member.id],
      endpoints: [{ ...base.endpoints[0], localDateTime: "2026-10-21T11:00" }],
      expectedTripVersion: await currentTripVersion(cookie, trip.id),
    });
    expect(second.status).toBe(201);
    const b = parseItineraryItemResponse(await second.json()).item;
    const pending = await mutate(cookie, `/api/trips/${trip.id}/items`, "party-pending", {
      ...base, title: "Unspecified", participantMemberIds: null,
      expectedTripVersion: await currentTripVersion(cookie, trip.id),
    });
    expect(pending.status).toBe(201);
    const unspecified = parseItineraryItemResponse(await pending.json()).item;

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
    const beforeReplay = await readSkeleton(cookie, trip.id);
    const createReplay = await mutate(cookie, `/api/trips/${trip.id}/items`, "party-a", createPayload);
    expect(createReplay.status).toBe(201);
    expect(parseItineraryItemResponse(await createReplay.json()).item).toEqual(a);
    const updateReplay = await mutate(
      cookie, `/api/trips/${trip.id}/items/${a.id}`, "party-shared", updatePayload, "PATCH",
    );
    expect(updateReplay.status).toBe(200);
    expect(parseItineraryItemResponse(await updateReplay.json()).item).toEqual(shared);
    const reloaded = await readSkeleton(editor.cookie, trip.id);
    expect(reloaded).toEqual(beforeReplay);
    expect(reloaded.items.map((item) => item.id).sort()).toEqual([...initialItems.map((item) => item.id), a.id, b.id, unspecified.id].sort());
    expect(reloaded.items.find((item) => item.id === a.id)).toEqual(locked);
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
    const invalidParties: unknown[] = [
      undefined, [], "not-an-array", [null], ["not-a-uuid"],
      [owner.id, owner.id], [owner.id, owner.id.toUpperCase()],
      [owner.userId], [foreignTrip.members[0]!.id],
      ["00000000-0000-4000-8000-000000000001"],
    ];
    for (const [index, participantMemberIds] of invalidParties.entries()) {
      const response = await mutate(cookie, `/api/trips/${trip.id}/items`, `invalid-party-${index}`, {
        ...base, participantMemberIds, expectedTripVersion: beforeInvalid.tripVersion,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "validation_error" } });
    }
    expect(await readSkeleton(cookie, trip.id)).toEqual(beforeInvalid);
    const createdResponse = await mutate(cookie, `/api/trips/${trip.id}/items`, "invalid-party-0", {
      ...base, expectedTripVersion: beforeInvalid.tripVersion,
    });
    expect(createdResponse.status).toBe(201);
    const item = parseItineraryItemResponse(await createdResponse.json()).item;
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
      email: "historical@example.test", removed: true,
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
    const inactiveCreate = await mutate(cookie, `/api/trips/${trip.id}/items`, "inactive-party", {
      ...base, expectedTripVersion: await currentTripVersion(cookie, trip.id),
    });
    expect(inactiveCreate.status).toBe(400);
    const rejoinedWithHistory = await joinMember(
      cookie, trip.id, editor.member.email, "historical-rejoin-with-reference", editor.cookie,
    );
    expect(rejoinedWithHistory.member.id).toBe(editor.member.id);
    expect((await readSkeleton(cookie, trip.id)).items.find((entry) => entry.id === item.id)).toMatchObject({
      id: item.id, version: retained.version,
      participants: [{ ...removedParticipant, removed: false }],
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
      cookie, trip.id, editor.member.email, "historical-rejoin", editor.cookie,
    );
    expect(rejoined.member.id).toBe(editor.member.id);
    const restoredResponse = await mutate(
      cookie, `/api/trips/${trip.id}/items/${item.id}`, "readd-inactive-party",
      { ...base, expectedVersion: cleared.version }, "PATCH",
    );
    expect(restoredResponse.status).toBe(200);
    const restored = parseItineraryItemResponse(await restoredResponse.json()).item;
    expect(restored).toMatchObject({
      id: item.id, participants: [{ ...removedParticipant, removed: false }],
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
    let pending: Promise<Response> | undefined;
    let settled = false;
    await database.transaction().execute(async (transaction) => {
      await transaction.selectFrom("trips").select("id").where("id", "=", trip.id)
        .forUpdate().executeTakeFirstOrThrow();
      pending = Promise.resolve(mutate(cookie, `/api/trips/${trip.id}/items`, "racing-party", {
        expectedTripVersion: before.tripVersion,
        type: "activity", title: "Must not add an inactive participant",
        participantMemberIds: [editor.member.id],
        endpoints: [{
          role: "start", countryStopId: trip.countryStops[0]!.id, placeId: place.id,
          localDateTime: "2026-10-21T10:00", timeZone: "Asia/Tokyo",
        }],
        details: { durationMinutes: 120, bookedBy: null, confirmationStatus: "unknown" },
      }));
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
    expect(projected?.sourceUrl).toBe(created.sourceUrl);

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
    expect(parseTripSkeletonResponse(await read.json()).skeleton.places.find((place) => place.id === updated.id)).toEqual(updated);
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
    ).tripPlaces.find((place) => place.placeId === assignedPlace.id)!;
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

    const rejectedCreate = await app.request(`/api/trips/${trip.id}/items`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "idempotency-key": "reject-assigned-item-create",
        origin: "https://app.example.test",
      },
      body: body({
        ...itemInput(assignedPlace.id, "Must remain untimed"),
        expectedTripVersion: await currentTripVersion(cookie, trip.id),
      }),
    });
    expect(rejectedCreate.status).toBe(409);
    expect(await rejectedCreate.json()).toMatchObject({
      error: {
        code: "conflict",
        message: "Remove the place from its unscheduled day before adding it to a timed itinerary item",
      },
    });

    const createdResponse = await app.request(`/api/trips/${trip.id}/items`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "idempotency-key": "create-other-timed-item",
        origin: "https://app.example.test",
      },
      body: body({
        ...itemInput(timedPlace.id, "Timed museum visit"),
        expectedTripVersion: await currentTripVersion(cookie, trip.id),
      }),
    });
    expect(createdResponse.status).toBe(201);
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
    const item = (localDateTime: string, utcOffset?: string) => ({
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

  it("bounds derived ends by their local date when a time zone repeats the previous date", async () => {
    // tzdb: America/St_Johns fell back at 2009-11-01 00:01 (-02:30) to 2009-10-31 23:01 (-03:30).
    const cookie = await login();
    interface StJohnsTarget { tripId: string; countryStopId: string; placeId: string }
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
      return { tripId: trip.id, countryStopId: trip.countryStops[0]!.id, placeId: place.id };
    }
    async function create(
      target: StJohnsTarget, key: string, localDateTime: string,
      durationMinutes: number, type: string, details: Record<string, unknown>,
    ) {
      return mutate(cookie, `/api/trips/${target.tripId}/items`, key, {
        type, title: key, notes: null, sourceUrl: null, money: null, participantMemberIds: null,
        endpoints: [{
          role: "start", countryStopId: target.countryStopId, placeId: target.placeId,
          localDateTime, timeZone: "America/St_Johns", utcOffset: "-02:30",
        }],
        details: { ...details, durationMinutes }, constraints: [],
        expectedTripVersion: await currentTripVersion(cookie, target.tripId),
      });
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
      expect(repeated.status, type).toBe(201);
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
      participantMemberIds: null,
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
    expect((await readSkeleton(cookie, trip.id)).items.map((item) => item.title).sort()).toEqual(["FIXTURE-OUT", "FIXTURE-RETURN"]);

    const lastMinute = await mutate(cookie, `/api/trips/${trip.id}/items`, "valid-duration-last-trip-minute", {
      ...base,
      details: { ...base.details, durationMinutes: 8039 },
      expectedTripVersion: await currentTripVersion(cookie, trip.id),
    });
    expect(lastMinute.status).toBe(201);
    expect(parseItineraryItemResponse(await lastMinute.json()).item.details)
      .toMatchObject({ durationMinutes: 8039 });
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
          participantMemberIds: null,
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
            participantMemberIds: null,
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

    // Inside the Japan stop, a Place without a time zone still takes the stop's time zone.
    const underJapan = await mutate(cookie, `/api/trips/${japanTrip.id}/items`, "outside-under-japan", {
      ...flight(japanStopId), expectedTripVersion: await currentTripVersion(cookie, japanTrip.id),
    });
    expect(underJapan.status).toBe(400);

    const created = await mutate(cookie, `/api/trips/${japanTrip.id}/items`, "outside-departure", {
      ...flight(null), expectedTripVersion: await currentTripVersion(cookie, japanTrip.id),
    });
    expect(created.status).toBe(201);
    const item = parseItineraryItemResponse(await created.json()).item;
    const departure = {
      role: "start", countryStopId: null, placeId: taoyuan.id,
      localDateTime: "2026-10-21T09:00", timeZone: "Asia/Taipei", utcOffset: "+08:00",
      instant: "2026-10-21T01:00:00.000Z",
    };
    expect(item.endpoints.find((endpoint) => endpoint.role === "start")).toMatchObject(departure);
    const reloaded = (await readSkeleton(cookie, japanTrip.id)).items.find((candidate) => candidate.id === item.id);
    expect(reloaded?.endpoints.find((endpoint) => endpoint.role === "start")).toMatchObject(departure);

    const transport = await mutate(cookie, `/api/trips/${japanTrip.id}/items`, "outside-transport", {
      ...flight(null),
      type: "transport",
      title: "Home to Taoyuan Airport",
      endpoints: [
        { role: "start", countryStopId: null, placeId: taoyuan.id, localDateTime: "2026-10-21T05:00", timeZone: "Asia/Taipei" },
        { role: "end", countryStopId: null, placeId: taoyuan.id, localDateTime: "2026-10-21T06:00", timeZone: "Asia/Taipei" },
      ],
      details: { mode: "bus", ticketInfo: null },
      expectedTripVersion: await currentTripVersion(cookie, japanTrip.id),
    });
    expect(transport.status).toBe(201);

    // Single-place items still belong to one of the trip's country stops.
    const looseActivity = await mutate(cookie, `/api/trips/${japanTrip.id}/items`, "outside-activity", {
      ...flight(null),
      type: "activity",
      title: "Airport lounge",
      endpoints: [{ role: "start", countryStopId: null, placeId: taoyuan.id, localDateTime: "2026-10-21T07:00", timeZone: "Asia/Taipei" }],
      details: { durationMinutes: 60, bookedBy: null, confirmationStatus: "unknown" },
      expectedTripVersion: await currentTripVersion(cookie, japanTrip.id),
    });
    expect(looseActivity.status).toBe(400);
    const looseLodging = await mutate(cookie, `/api/trips/${japanTrip.id}/items`, "outside-lodging", {
      ...flight(null),
      type: "lodging",
      title: "Airport hotel",
      endpoints: [
        { role: "start", countryStopId: null, placeId: taoyuan.id, localDateTime: "2026-10-21T15:00", timeZone: "Asia/Taipei" },
        { role: "end", countryStopId: null, placeId: taoyuan.id, localDateTime: "2026-10-22T10:00", timeZone: "Asia/Taipei" },
      ],
      details: { bookedBy: null, confirmationCode: null },
      expectedTripVersion: await currentTripVersion(cookie, japanTrip.id),
    });
    expect(looseLodging.status).toBe(400);
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
    const created: ItineraryItemDto[] = [];
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
          participantMemberIds: null,
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
    const addedItems = skeleton.items.filter((item) => created.some((added) => added.id === item.id));
    expect(addedItems.map((item) => item.type)).toEqual([
      "flight",
      "lodging",
      "transport",
      "reservation",
      "meal",
      "activity",
      "free-time",
    ]);
    expect(addedItems[2]?.constraints[0]).toMatchObject({
      type: "minimum_buffer",
      status: "unknown",
      minimumBufferMinutes: 30,
    });
    expect(addedItems[3]?.constraints[0]?.status).toBe("conflicted");
    expect(
      skeleton.days
        .find((day) => day.date === "2026-10-23")
        ?.entries.map((entry) => entry.itemId),
    ).toEqual([created[1]!.id, created[2]!.id, created[3]!.id]);
    expect(skeleton.tripInformationItemIds.filter((id) => created.some((item) => item.id === id))).toEqual([
      created[0]!.id,
      created[1]!.id,
      created[2]!.id,
    ]);
    expect(addedItems[0]?.money).toEqual({
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
        participantMemberIds: null,
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
      const before = await readSkeleton(cookie, trip.id);
      try {
        const old = await migrator.migrateTo("016_travel_places");
        if (old.error) throw old.error;
        // ac431b4 intake populated the legacy/contribution note, but left its equal-version mirror null.
        await database.updateTable("trip_places").set({ notes: null }).where("id", "=", originalIntake.id).execute();
        expect(await database.selectFrom("trip_places").select(["notes", "legacy_place_version"])
          .where("id", "=", originalIntake.id).executeTakeFirstOrThrow())
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
          await database.deleteFrom("trip_place_contributions").where("trip_place_id", "=", place.id).execute();
          for (const [index, note] of notes.entries()) {
            await database.insertInto("trip_place_contributions").values({
              trip_id: trip.id, trip_place_id: place.id, member_user_id: ownerId,
              intake_method: "manual", original_note: note, source_url: null,
              provider_observed_at: null, withdrawn_at: index === 1 ? historicalTime : null,
              created_at: new Date(`2026-09-${20 + index}T12:00:00.000Z`),
            }).execute();
          }
        }
        await database.updateTable("trip_places").set({ archived_at: historicalTime }).where("id", "=", ordered.id).execute();
        const run = await sql<{ id: string }>`
          insert into discovery_runs (trip_id, brief_version, policy_version, model_id, status, search_plan, created_by)
          values (${trip.id}, 1, 'migration-fixture', 'fixture', 'completed', '{}'::jsonb, ${ownerId})
          returning id
        `.execute(database);
        const proposals: Record<string, string> = {};
        for (const [state, placeId] of [["archived", ordered.id], ["missing", null], ["active", kept.id]] as const) {
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
            .where("id", "=", place.id).executeTakeFirstOrThrow();
          const legacy = await database.selectFrom("places").select(["notes", "version"])
            .where("id", "=", place.id).executeTakeFirstOrThrow();
          expect(wishlist.notes).toBe(notes);
          expect(legacy.notes).toBe(notes);
          expect(wishlist.legacy_place_version).toBe(place.version);
        }
        expect(await database.selectFrom("trip_places").select(["id", "version", "legacy_place_version"]).orderBy("id").execute())
          .toEqual(versionsBefore);
        expect(await database.selectFrom("places").select(["id", "version"]).orderBy("id").execute()).toEqual(legacyVersionsBefore);
        expect((await database.selectFrom("trip_places").select("notes").where("id", "=", newerNote.id).executeTakeFirstOrThrow()).notes)
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
          .toEqual({ status: "accepted", accepted_trip_place_id: kept.id, version: 4 });
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
        expect(projected.find((place) => place.id === capped.id)?.notes).toBe("x".repeat(10_000));
        expect(projected.find((place) => place.id === ahead.id)).toMatchObject({
          name: "Corrected legacy name", address: "Corrected legacy address", notes: "Original contribution note",
        });
        expect(projected.find((place) => place.id === newerNote.id)?.notes).toBe("Newer note from retained release");
        expect(projected.find((place) => place.id === originalIntake.id)?.notes).toBe("Sunset if possible");
        const placesAfter = await database.selectFrom("trip_places").selectAll().orderBy("id").execute();
        const proposalsAfter = await database.selectFrom("candidate_proposals").selectAll().orderBy("id").execute();
        const downgraded = await migrator.migrateTo("016_travel_places");
        if (downgraded.error) throw downgraded.error;
        expect(await database.selectFrom("trip_places").selectAll().orderBy("id").execute()).toEqual(placesAfter);
        expect(await database.selectFrom("candidate_proposals").selectAll().orderBy("id").execute())
          .toEqual(proposalsAfter.map(({ reopened_at: _reopenedAt, ...proposal }) => proposal));
      } finally {
        const restored = await migrator.migrateToLatest();
        if (restored.error) throw restored.error;
      }
    });

    it.each(["reopened", "pending", "rejected", "accepted"] as const)("canonicalizes historical acceptances in 017 (newest: %s)", async (newestStatus) => {
      const latestPending = newestStatus === "pending";
      const preserveDecision = newestStatus === "rejected" || newestStatus === "accepted";
      const cookie = await login();
      const trip = await createTrip(cookie);
      const ownerId = trip.members[0]!.userId;
      const place = await createPlace(cookie, trip.id, "historical-accepted-place", { name: "Historical place", type: "activity" });
      const second = await database.insertInto("users").values({
        email: "migration-voter@example.test", display_name: "Migration voter", status: "active",
      }).returning("id").executeTakeFirstOrThrow();
      const removed = await database.insertInto("users").values({
        email: "migration-removed@example.test", display_name: "Removed voter", status: "active",
      }).returning("id").executeTakeFirstOrThrow();
      await database.insertInto("trip_members").values([
        { trip_id: trip.id, user_id: second.id, role: "editor", removed_at: null },
        { trip_id: trip.id, user_id: removed.id, role: "editor", removed_at: new Date("2026-09-28T12:00:00.000Z") },
      ]).execute();
      try {
        const old = await migrator.migrateTo("016_travel_places");
        if (old.error) throw old.error;
        if (newestStatus !== "accepted") {
          await database.updateTable("trip_places").set({ archived_at: new Date("2026-09-28T12:00:00.000Z") })
            .where("id", "=", place.id).execute();
        }
        const proposalIds: string[] = [];
        const states = preserveDecision ? ["accepted", newestStatus]
          : latestPending ? ["accepted", "accepted", "pending"] : ["accepted", "accepted"];
        for (const [index, status] of states.entries()) {
          const run = await sql<{ id: string }>`
            insert into discovery_runs (trip_id, brief_version, policy_version, model_id, status, search_plan, created_by, created_at)
            values (${trip.id}, 1, 'migration-fixture', 'fixture', 'completed', '{}'::jsonb, ${ownerId},
              ${new Date(Date.UTC(2026, 8, 20 + index))})
            returning id
          `.execute(database);
          const proposal = await sql<{ id: string }>`
            insert into candidate_proposals (
              trip_id, run_id, provider_place_id, name, place_type, recommendation, matched_needs,
              tradeoffs, unknowns, confidence, status, decided_by, decided_at, accepted_trip_place_id, version, created_at
            ) values (
              ${trip.id}, ${run.rows[0]!.id}, 'historical-shared-identity', ${place.name}, 'activity', 'Historical recommendation',
              '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'medium', ${status},
              case when ${status} in ('accepted', 'rejected') then ${ownerId}::uuid else null end,
              case when ${status} in ('accepted', 'rejected') then now() else null end,
              case when ${status} = 'accepted' and not ${newestStatus === "accepted" && index === 0}
                then ${place.id}::uuid else null end,
              ${status === "pending" ? 1 : 4}, ${new Date(Date.UTC(2026, 8, 27 - index))}
            ) returning id
          `.execute(database);
          const id = proposal.rows[0]!.id;
          proposalIds.push(id);
          await database.insertInto("discovery_proposal_votes").values(
            (index === 0 ? [ownerId, second.id, removed.id] : [second.id])
              .map((member_user_id) => ({ trip_id: trip.id, proposal_id: id, member_user_id })),
          ).execute();
        }
        // A later unrelated run must not erase the authoritative decision for this identity.
        if (preserveDecision) {
          await sql`
            insert into discovery_runs (trip_id, brief_version, policy_version, model_id, status, search_plan, created_by, created_at)
            values (${trip.id}, 1, 'migration-fixture', 'fixture', 'completed', '{}'::jsonb, ${ownerId}, '2026-09-25T12:00:00Z')
          `.execute(database);
        }
        const canonicalId = proposalIds.at(-1)!;
        const decisionBefore = await database.selectFrom("candidate_proposals")
          .select(["status", "version", "decided_by", "decided_at", "accepted_trip_place_id", "updated_at"])
          .where("id", "=", canonicalId).executeTakeFirstOrThrow();
        const votesBefore = await database.selectFrom("discovery_proposal_votes").selectAll()
          .where("trip_id", "=", trip.id).orderBy("proposal_id").orderBy("member_user_id").execute();
        const upgraded = await migrator.migrateToLatest();
        if (upgraded.error) throw upgraded.error;
        const provider = new GooglePlacesProvider();
        const discovery = new PostgresDiscoveryModule({
          database, model: new OpenAiResponsesDiscoveryModel(), placeLookup: provider,
          tripPlaces: new PostgresTripPlaceModule({ database, provider }),
        });
        const workspace = await discovery.getWorkspace(ownerId, trip.id);
        if (preserveDecision) {
          expect(workspace.proposals).toEqual([]);
          expect(workspace.decided).toEqual([expect.objectContaining({ proposalId: canonicalId, status: newestStatus })]);
          expect(await database.selectFrom("candidate_proposals")
            .select(["status", "version", "decided_by", "decided_at", "accepted_trip_place_id", "updated_at"])
            .where("id", "=", canonicalId).executeTakeFirstOrThrow()).toEqual(decisionBefore);
          expect(await database.selectFrom("discovery_proposal_votes").selectAll()
            .where("trip_id", "=", trip.id).orderBy("proposal_id").orderBy("member_user_id").execute()).toEqual(votesBefore);
          expect((await database.selectFrom("trip_places").select("archived_at")
            .where("id", "=", place.id).executeTakeFirstOrThrow()).archived_at === null).toBe(newestStatus === "accepted");
        } else {
          expect(workspace.proposals).toHaveLength(1);
          const canonical = workspace.proposals[0]!;
          expect(canonical).toMatchObject({
            id: canonicalId, status: "pending", acceptedTripPlaceId: null,
            version: latestPending ? 1 : 5, ownVote: true, voteCount: 2,
          });
          expect(canonical.voters.map((voter) => voter.memberUserId).sort()).toEqual([ownerId, second.id].sort());
        }
        expect(await database.selectFrom("candidate_proposals").select("id")
          .where("trip_id", "=", trip.id).where("reopened_at", "is not", null).execute())
          .toEqual(newestStatus === "reopened" ? [{ id: proposalIds[1] }] : []);
        const reopenedIds = proposalIds.slice(0, preserveDecision ? 1 : 2);
        expect(await database.selectFrom("candidate_proposals")
          .select(["status", "version", "decided_by", "decided_at", "accepted_trip_place_id"])
          .where("id", "in", reopenedIds).execute())
          .toEqual(reopenedIds.map(() => ({
            status: "pending", version: 5, decided_by: null, decided_at: null, accepted_trip_place_id: null,
          })));
        expect(await database.selectFrom("discovery_proposal_votes").select("member_user_id")
          .where("proposal_id", "=", canonicalId).orderBy("member_user_id").execute())
          .toEqual((preserveDecision ? [second.id] : [ownerId, second.id]).sort().map((member_user_id) => ({ member_user_id })));
        expect(await database.selectFrom("change_events").select("target_id")
          .where("trip_id", "=", trip.id).where("event_type", "=", "discovery.proposal_reopened").orderBy("target_id").execute())
          .toEqual(reopenedIds.sort().map((target_id) => ({ target_id })));
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
      for (const place of [travel, mixed]) {
        const response = await mutate(cookie, `/api/trips/${trip.id}/items`, `stay-${place.id}`, {
          type: "lodging", title: place.name, participantMemberIds: null,
          endpoints: [
            { role: "start", placeId: place.id, countryStopId: trip.countryStops[0]!.id, timeZone: "Asia/Tokyo", localDateTime: "2026-10-21T15:00" },
            { role: "end", placeId: place.id, countryStopId: trip.countryStops[0]!.id, timeZone: "Asia/Tokyo", localDateTime: "2026-10-23T10:00" },
          ],
          details: { bookedBy: "Original booker", confirmationCode: "Original confirmation" },
          expectedTripVersion: await currentTripVersion(cookie, trip.id),
        });
        expect(response.status).toBe(201);
      }
      expect((await mutate(cookie, `/api/trips/${trip.id}/items`, "mixed-activity", {
        type: "activity", title: "Hotel restaurant visit", participantMemberIds: null,
        endpoints: [{ role: "start", placeId: mixed.id, countryStopId: trip.countryStops[0]!.id, timeZone: "Asia/Tokyo", localDateTime: "2026-10-22T12:00" }],
        details: { durationMinutes: 60, bookedBy: null, confirmationStatus: null },
        expectedTripVersion: await currentTripVersion(cookie, trip.id),
      })).status).toBe(201);
      const before = await readSkeleton(cookie, trip.id);
      const contributions = await database.selectFrom("trip_place_contributions").selectAll()
        .where("trip_place_id", "in", [travel.id, mixed.id]).orderBy("id").execute();
      try {
        const old = await migrator.migrateTo("015_member_votes");
        if (old.error) throw old.error;
        // Reconstruct pre-016 data, including an assignment made by a retained release.
        for (const place of [travel, mixed]) {
          await database.insertInto("trip_place_votes").values({
            trip_id: trip.id, trip_place_id: place.id, member_user_id: trip.members[0]!.userId,
          }).execute();
          await database.insertInto("trip_place_desired_days").values({
            trip_id: trip.id, trip_place_id: place.id, trip_day_id: trip.days[0]!.id,
          }).execute();
          await database.insertInto("trip_place_excluded_days").values({
            trip_id: trip.id, trip_place_id: place.id, trip_day_id: trip.days[1]!.id,
          }).execute();
        }
        const upgraded = await migrator.migrateToLatest();
        if (upgraded.error) throw upgraded.error;
        const wishlist = await app.request(`/api/trips/${trip.id}/trip-places`, { headers: { cookie } });
        expect(parseTripPlaceListResponse(await wishlist.json()).tripPlaces.map((place) => place.id)).toEqual([mixed.id]);
        const after = await readSkeleton(cookie, trip.id);
        expect(after.items).toEqual(before.items);
        expect(after.places).toEqual(before.places);
        expect(after.days).toEqual(before.days);
        expect(await database.selectFrom("trip_place_contributions").selectAll()
          .where("trip_place_id", "in", [travel.id, mixed.id]).orderBy("id").execute()).toEqual(contributions);
        for (const table of ["trip_place_votes", "trip_place_day_assignments", "trip_place_desired_days", "trip_place_excluded_days"] as const) {
          expect(await database.selectFrom(table).selectAll().where("trip_place_id", "=", travel.id).execute(), table).toEqual([]);
          expect(await database.selectFrom(table).select("trip_place_id").where("trip_place_id", "=", mixed.id).execute(), table)
            .toEqual([{ trip_place_id: mixed.id }]);
        }
        expect(await database.selectFrom("places").select(["id", "travel_only"]).where("id", "in", [travel.id, mixed.id]).orderBy("name").execute())
          .toEqual([{ id: mixed.id, travel_only: false }, { id: travel.id, travel_only: true }]);
        const downgraded = await migrator.migrateTo("015_member_votes");
        if (downgraded.error) throw downgraded.error;
        expect((await database.selectFrom("trip_places").select("archived_at").where("id", "=", travel.id).executeTakeFirstOrThrow()).archived_at).not.toBeNull();
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


    it("upgrades historical replies without substituting current members or item state and safely refuses missing targets", async () => {
      const cookie = await login();
      const trip = await createTrip(cookie);
      // The pre-012 schema forbids outside-route endpoints. Remove only the new fixture
      // flights through the public route before reconstructing this historical database.
      for (const flight of (await readSkeleton(cookie, trip.id)).items) {
        expect((await mutate(cookie, `/api/trips/${trip.id}/items/${flight.id}`, `remove-fixture-${flight.id}`,
          { expectedVersion: flight.version }, "DELETE")).status).toBe(204);
      }
      const owner = trip.members[0]!;
      const placeInput = { name: "Legacy place", type: "activity", timeZone: "Asia/Tokyo" };
      const placeVersion = await currentTripVersion(cookie, trip.id);
      const place = await createPlace(cookie, trip.id, "legacy-place", placeInput);
      const itemInput = {
        type: "activity", title: "Original historical activity", participantMemberIds: null,
        endpoints: [{
          role: "start", countryStopId: trip.countryStops[0]!.id, placeId: place.id,
          localDateTime: "2026-10-21T10:00", timeZone: "Asia/Tokyo",
        }],
        details: { durationMinutes: 120, bookedBy: null, confirmationStatus: "unknown" },
      };
      const replies: Array<{
        path: string; key: string; payload: unknown; method: string;
        status: number; item: ItineraryItemDto;
      }> = [];
      async function capture(
        requestPath: string, key: string, payload: unknown, method: string, status: number,
      ) {
        const response = await mutate(cookie, requestPath, key, payload, method);
        expect(response.status).toBe(status);
        const item = parseItineraryItemResponse(await response.json()).item;
        replies.push({ path: requestPath, key, payload, method, status, item });
        return item;
      }
      const itemsPath = `/api/trips/${trip.id}/items`;
      let item = await capture(itemsPath, "legacy-create", {
        ...itemInput, expectedTripVersion: await currentTripVersion(cookie, trip.id),
      }, "POST", 201);
      const itemPath = `${itemsPath}/${item.id}`;
      item = await capture(itemPath, "legacy-update", {
        ...itemInput, title: "Historical edited title", expectedVersion: item.version,
      }, "PATCH", 200);
      item = await capture(`${itemPath}/constraints`, "legacy-constraint-create", {
        expectedItemVersion: item.version, type: "minimum_buffer", status: "unknown",
        minimumBufferMinutes: 20,
      }, "POST", 201);
      const constraint = item.constraints[0]!;
      const constraintPath = `${itemPath}/constraints/${constraint.id}`;
      item = await capture(constraintPath, "legacy-constraint-update", {
        expectedItemVersion: item.version, expectedVersion: constraint.version,
        type: "minimum_buffer", status: "confirmed", minimumBufferMinutes: 45,
      }, "PATCH", 200);
      item = await capture(constraintPath, "legacy-constraint-delete", {
        expectedItemVersion: item.version, expectedVersion: item.constraints[0]!.version,
      }, "DELETE", 200);
      item = await capture(`${itemPath}/lock`, "legacy-lock", { expectedVersion: item.version }, "POST", 200);
      item = await capture(`${itemPath}/unlock`, "legacy-unlock", { expectedVersion: item.version }, "POST", 200);
      const deleted = await mutate(cookie, itemPath, "legacy-delete", {
        expectedVersion: item.version,
      }, "DELETE");
      expect(deleted.status).toBe(204);
      const live = await capture(itemsPath, "legacy-live", {
        ...itemInput, title: "Live legacy activity",
        expectedTripVersion: await currentTripVersion(cookie, trip.id),
      }, "POST", 201);
      const editor = await joinMember(cookie, trip.id, "migration-editor@example.test", "legacy-editor");

      // Reconstruct the pre-008 stored wire shape using genuine HTTP replies.
      await sql`
        update mutation_requests request
        set response = jsonb_set(response, '{members}', (
          select jsonb_agg(member.value - 'id' order by member.position)
          from jsonb_array_elements(response -> 'members')
            with ordinality as member(value, position)
        ))
        where operation = 'create_trip'
      `.execute(database);
      await sql`
        update mutation_requests set response = response - 'participants'
        where operation ~ '^(create_itinerary_item|iu|cc|cu|cd|il|in):'
      `.execute(database);
      await database.updateTable("trips").set({ name: "Current trip name" }).where("id", "=", trip.id).execute();
      await database.updateTable("users").set({ display_name: "Current owner label" })
        .where("id", "=", owner.userId).execute();
      const downgraded = await migrator.migrateTo("007_trip_place_day_assignments");
      if (downgraded.error) throw downgraded.error;

      await database.insertInto("mutation_requests").values({
        actor_id: owner.userId, operation: "create_trip", idempotency_key: "unresolvable-history",
        response: {
          ...trip,
          members: [{
            userId: "00000000-0000-4000-8000-000000000001",
            email: "missing-historical@example.test", displayName: null, role: "owner",
          }],
        },
      }).execute();
      const refused = await migrator.migrateToLatest();
      expect(refused.error).toBeDefined();
      await database.deleteFrom("mutation_requests")
        .where("actor_id", "=", owner.userId).where("operation", "=", "create_trip")
        .where("idempotency_key", "=", "unresolvable-history").execute();
      // A successful retry also proves that failed migration DDL was rolled back.
      const upgraded = await migrator.migrateToLatest();
      if (upgraded.error) throw upgraded.error;

      const currentTripResponse = await app.request(`/api/trips/${trip.id}`, { headers: { cookie } });
      expect(currentTripResponse.status).toBe(200);
      const currentTrip = parseTripResponse(await currentTripResponse.json()).trip;
      const currentOwner = currentTrip.members.find((member) => member.userId === owner.userId)!;
      const currentEditor = currentTrip.members.find((member) => member.userId === editor.member.userId)!;
      expect(currentTrip.members.map((member) => member.email).sort())
        .toEqual(["migration-editor@example.test", "owner@example.test"]);
      expect(currentOwner.id).not.toBe(owner.userId);
      expect(await createTrip(cookie)).toEqual({
        ...trip, members: [{ ...owner, id: currentOwner.id }],
      });
      expect(currentTrip.name).toBe("Current trip name");
      expect(currentOwner.displayName).toBe("Current owner label");
      const legacyRead = await readSkeleton(cookie, trip.id);
      expect(legacyRead.items).toEqual([live]);
      const selectedResponse = await mutate(cookie, `${itemsPath}/${live.id}`, "post-migration-party", {
        ...itemInput, expectedVersion: live.version, participantMemberIds: [currentEditor.id],
      }, "PATCH");
      expect(selectedResponse.status).toBe(200);
      const selected = parseItineraryItemResponse(await selectedResponse.json()).item;
      expect(selected.participants).toEqual([{
        memberId: currentEditor.id, email: currentEditor.email, displayName: null, removed: false,
      }]);
      const beforeReplay = await readSkeleton(cookie, trip.id);
      for (const reply of replies) {
        const replay = await mutate(cookie, reply.path, reply.key, reply.payload, reply.method);
        expect(replay.status).toBe(reply.status);
        expect(parseItineraryItemResponse(await replay.json()).item).toEqual(reply.item);
      }
      const placeReplay = await mutate(cookie, `/api/trips/${trip.id}/places`, "legacy-place", {
        ...placeInput, expectedTripVersion: placeVersion,
      });
      expect(placeReplay.status).toBe(201);
      expect(parsePlaceResponse(await placeReplay.json()).place).toEqual(place);
      const deleteReplay = await mutate(cookie, itemPath, "legacy-delete", {
        expectedVersion: item.version,
      }, "DELETE");
      expect(deleteReplay.status).toBe(204);
      expect(await readSkeleton(cookie, trip.id)).toEqual(beforeReplay);
      expect(beforeReplay.items).toEqual([selected]);

    });

    it("normalizes later legacy inserts once and replays their original parties after live state changes", async () => {
      const cookie = await login();
      const trip = await createTrip(cookie);
      const owner = trip.members[0]!;
      const traveler = await joinMember(cookie, trip.id, "cache-traveler@example.test", "cache-traveler");
      await joinMember(cookie, trip.id, "cache-unselected@example.test", "cache-unselected");
      await database.updateTable("users").set({ display_name: "Insert-time traveler" })
        .where("id", "=", traveler.member.userId).execute();
      await database.updateTable("users").set({ display_name: "Current owner" })
        .where("id", "=", owner.userId).execute();
      await database.updateTable("trips").set({ name: "Current trip name" })
        .where("id", "=", trip.id).execute();

      const tripKey = "create-trip-skeleton-trip-JP";
      await database.deleteFrom("mutation_requests")
        .where("actor_id", "=", owner.userId).where("operation", "=", "create_trip")
        .where("idempotency_key", "=", tripKey).execute();
      await database.insertInto("mutation_requests").values({
        actor_id: owner.userId, operation: "create_trip", idempotency_key: tripKey,
        response: {
          ...trip,
          members: trip.members.map(({ id: _id, ...member }) => member),
        },
      }).execute();
      const tripReplay = await createTrip(cookie);
      expect(tripReplay).toEqual(trip);
      expect(tripReplay.members[0]!.id).not.toBe(owner.userId);

      const place = await createPlace(cookie, trip.id, "cache-place", {
        name: "Cache venue", type: "activity", timeZone: "Asia/Tokyo",
      });
      const input = {
        type: "activity", title: "Insert-time activity", participantMemberIds: [traveler.member.id],
        endpoints: [{
          role: "start", countryStopId: trip.countryStops[0]!.id, placeId: place.id,
          localDateTime: "2026-10-21T10:00", timeZone: "Asia/Tokyo",
        }],
        details: { durationMinutes: 120, bookedBy: null, confirmationStatus: "unknown" },
      };
      const replies: Array<{
        path: string; key: string; payload: unknown; method: string; status: number;
        operation: string; item: ItineraryItemDto;
      }> = [];
      async function captureLegacy(
        requestPath: string, key: string, payload: unknown, method: string, status: number,
      ) {
        const response = await mutate(cookie, requestPath, key, payload, method);
        expect(response.status).toBe(status);
        const item = parseItineraryItemResponse(await response.json()).item;
        const stored = await database.selectFrom("mutation_requests").select("operation")
          .where("actor_id", "=", owner.userId).where("idempotency_key", "=", key)
          .executeTakeFirstOrThrow();
        await database.deleteFrom("mutation_requests")
          .where("actor_id", "=", owner.userId).where("operation", "=", stored.operation)
          .where("idempotency_key", "=", key).execute();
        const { participants: _participants, ...legacy } = item;
        await database.insertInto("mutation_requests").values({
          actor_id: owner.userId, operation: stored.operation, idempotency_key: key, response: legacy,
        }).execute();
        replies.push({ path: requestPath, key, payload, method, status, operation: stored.operation, item });
        return item;
      }
      const itemsPath = `/api/trips/${trip.id}/items`;
      let item = await captureLegacy(itemsPath, "cache-create", {
        ...input, expectedTripVersion: await currentTripVersion(cookie, trip.id),
      }, "POST", 201);
      const itemPath = `${itemsPath}/${item.id}`;
      const removed = await mutate(
        cookie, `/api/trips/${trip.id}/members/${traveler.member.userId}`, "cache-remove", {}, "DELETE",
      );
      expect(removed.status).toBe(204);
      item = await captureLegacy(itemPath, "cache-update", {
        ...input, expectedVersion: item.version,
      }, "PATCH", 200);
      item = await captureLegacy(`${itemPath}/constraints`, "cache-constraint-create", {
        expectedItemVersion: item.version, type: "minimum_buffer", status: "unknown",
        minimumBufferMinutes: 20,
      }, "POST", 201);
      const constraintPath = `${itemPath}/constraints/${item.constraints[0]!.id}`;
      item = await captureLegacy(constraintPath, "cache-constraint-update", {
        expectedItemVersion: item.version, expectedVersion: item.constraints[0]!.version,
        type: "minimum_buffer", status: "confirmed", minimumBufferMinutes: 45,
      }, "PATCH", 200);
      item = await captureLegacy(constraintPath, "cache-constraint-delete", {
        expectedItemVersion: item.version, expectedVersion: item.constraints[0]!.version,
      }, "DELETE", 200);
      item = await captureLegacy(`${itemPath}/lock`, "cache-lock", { expectedVersion: item.version }, "POST", 200);
      item = await captureLegacy(`${itemPath}/unlock`, "cache-unlock", { expectedVersion: item.version }, "POST", 200);

      await database.updateTable("users").set({ display_name: "Current traveler" })
        .where("id", "=", traveler.member.userId).execute();
      const currentResponse = await mutate(cookie, itemPath, "cache-current", {
        ...input, title: "Current activity", participantMemberIds: null, expectedVersion: item.version,
      }, "PATCH");
      expect(currentResponse.status).toBe(200);
      const current = parseItineraryItemResponse(await currentResponse.json()).item;
      expect(current.participants).toBeNull();
      const beforeReplay = await readSkeleton(cookie, trip.id);
      for (const reply of replies) {
        const replay = await mutate(cookie, reply.path, reply.key, reply.payload, reply.method);
        expect(replay.status).toBe(reply.status);
        const historical = parseItineraryItemResponse(await replay.json()).item;
        expect(historical.id).toBe(current.id);
        expect(historical.version).toBe(reply.item.version);
        expect(historical.title).toBe("Insert-time activity");
        expect(historical.participants).toEqual([{
          memberId: traveler.member.id, email: "cache-traveler@example.test",
          displayName: "Insert-time traveler", removed: reply.key !== "cache-create",
        }]);
      }

      // A complete historical reply must not be overwritten by current parties.
      const complete = replies[1]!;
      await database.insertInto("mutation_requests").values({
        actor_id: owner.userId, operation: complete.operation,
        idempotency_key: "cache-complete", response: complete.item,
      }).execute();
      const completeReplay = await mutate(
        cookie, complete.path, "cache-complete", complete.payload, complete.method,
      );
      expect(completeReplay.status).toBe(complete.status);
      expect(parseItineraryItemResponse(await completeReplay.json()).item).toEqual(complete.item);
      expect(await readSkeleton(cookie, trip.id)).toEqual(beforeReplay);
    });
  });
});
