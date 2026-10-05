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

  it("reloads independent activities and changes a shared party without duplicating the item", async () => {
    const cookie = await login();
    const trip = await createTrip(cookie);
    const owner = trip.members[0]!;
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
    expect(reloaded.items.map((item) => item.id).sort()).toEqual([a.id, b.id, unspecified.id].sort());
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
    expect(removedRead.items[0]?.participants).toEqual([removedParticipant]);
    expect(removedRead.items[0]?.id).toBe(item.id);
    await expect(database.deleteFrom("trip_members")
      .where("trip_id", "=", trip.id).where("id", "=", editor.member.id).execute())
      .rejects.toMatchObject({ code: "23503" });
    expect((await readSkeleton(cookie, trip.id)).items[0]?.participants).toEqual([removedParticipant]);

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
    expect((await readSkeleton(cookie, trip.id)).items[0]).toMatchObject({
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
    expect((await readSkeleton(cookie, trip.id)).items).toEqual([]);
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
    expect((await readSkeleton(cookie, novemberFirst.tripId)).items).toEqual([]);
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
    expect((await readSkeleton(cookie, trip.id)).items).toEqual([]);

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
      expect(refused.results).toEqual([
        { migrationName: "008_activity_participants", direction: "Up", status: "Error" },
        { migrationName: "009_day_place_order", direction: "Up", status: "NotExecuted" },
        { migrationName: "010_grounded_recommendations", direction: "Up", status: "NotExecuted" },
        { migrationName: "011_day_plan_window", direction: "Up", status: "NotExecuted" },
        { migrationName: "012_endpoints_outside_route", direction: "Up", status: "NotExecuted" },
        { migrationName: "013_discovery_claims", direction: "Up", status: "NotExecuted" },
        { migrationName: "014_discovery_feedback_answers", direction: "Up", status: "NotExecuted" },
        { migrationName: "015_member_votes", direction: "Up", status: "NotExecuted" },
      ]);
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
