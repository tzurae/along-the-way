import { createHash } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import { MAX_TRIP_COUNTRY_STOPS } from "@along-the-way/contracts/countries";
import type { Hono } from "hono";
import {
  parseInviteResponse,
  parseTripListResponse,
  parseTripResponse,
} from "@along-the-way/contracts/private-trips";

import { createApp } from "../src/app";
import {
  createDatabase,
  type AlongTheWayDatabase,
} from "../src/database/database";
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

interface CapturedMessage {
  to: string;
  url: string;
  tripName?: string;
}

class CapturingEmailSender implements EmailSender {
  readonly magicLinks: CapturedMessage[] = [];
  readonly invites: CapturedMessage[] = [];

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
  const header = response.headers.get("set-cookie");
  if (!header) throw new Error("Expected session cookie");
  const cookie = header.split(";", 1)[0];
  if (!cookie) throw new Error("Session cookie was empty");
  return cookie;
}

function linkToken(url: string, name: "magicToken" | "inviteToken") {
  return new URLSearchParams(new URL(url).hash.slice(1)).get(name);
}

describe("private trip flow through HTTP and PostgreSQL", () => {
  let database: Kysely<AlongTheWayDatabase>;
  let email: CapturingEmailSender;
  let now: Date;
  let tokenNumber: number;
  let app: Hono;
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
    email = new CapturingEmailSender();
    now = new Date("2026-09-27T12:00:00.000Z");
    tokenNumber = 0;
    const tokenSecret = "integration-test-token-secret-at-least-thirty-two-bytes";
    const tokenIssuer = new TokenIssuer(tokenSecret);
    const identityAccess = new PostgresIdentityAccessModule({
      database,
      tokenIssuer,
      now: () => new Date(now),
      randomSessionToken: () => `test-token-${++tokenNumber}`,
    });
    const tripWorkspace = new PostgresTripWorkspaceModule({
      database,
      now: () => new Date(now),
    });
    emailWorker = new PostgresEmailWorker({
      database,
      emailSender: email,
      siteAddress: "https://app.example.test",
      tokenIssuer,
      now: () => new Date(now),
    });
    app = createApp({
      discovery: unrelatedDiscoveryModule,
      identityAccess,
      rateLimiter: new PostgresRateLimiter(
        database,
        tokenSecret,
        () => new Date(now),
      ),
      readiness: new PostgresReadinessProbe(database, () => new Date(now)),
      siteAddress: "https://app.example.test",
      tripSkeleton: new PostgresTripSkeletonModule({
        database,
        now: () => new Date(now),
      }),
      tripPlaces: new PostgresTripPlaceModule({
        database,
        provider: new GooglePlacesProvider(),
        now: () => new Date(now),
      }),
      tripWorkspace,
    });
  });

  afterAll(async () => {
    await database.destroy();
  });

  async function requestMagicLink(address: string) {
    const response = await app.request("/api/auth/magic-links", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://app.example.test",
      },
      body: body({ email: address }),
    });
    await emailWorker.runOnce();
    return response;
  }

  async function login(address: string) {
    const previousCount = email.magicLinks.length;
    const request = await requestMagicLink(address);
    expect(request.status).toBe(202);
    const message = email.magicLinks[previousCount];
    if (!message) throw new Error(`No magic link sent to ${address}`);
    const token = linkToken(message.url, "magicToken");
    if (!token) throw new Error("Magic link omitted token");
    const consume = await app.request("/api/auth/magic-links/consume", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://app.example.test",
      },
      body: body({ token }),
    });
    expect(consume.status).toBe(200);
    return { cookie: cookieFrom(consume), token };
  }

  async function createTrip(cookie: string, key = "create-osaka-kyoto") {
    const response = await app.request("/api/trips", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "idempotency-key": key,
        origin: "https://app.example.test",
      },
      body: body({
        name: "日本韓國家庭旅行",
        startDate: "2026-10-21",
        endDate: "2026-10-27",
        countryCodes: ["JP", "KR", "JP"],
      }),
    });
    expect(response.status).toBe(201);
    return parseTripResponse(await response.json());
  }

  async function invite(cookie: string, tripId: string, address: string, key: string) {
    const previousCount = email.invites.length;
    const response = await app.request(`/api/trips/${tripId}/invites`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "idempotency-key": key,
        origin: "https://app.example.test",
      },
      body: body({ email: address }),
    });
    expect(response.status).toBe(201);
    const payload = parseInviteResponse(await response.json());
    await emailWorker.runOnce();
    const message = email.invites[previousCount];
    if (!message) throw new Error(`No invitation sent to ${address}`);
    const token = linkToken(message.url, "inviteToken");
    if (!token) throw new Error("Invitation omitted token");
    return { inviteId: payload.invite.id, token };
  }

  async function accept(cookie: string, token: string, key: string) {
    return app.request("/api/invites/accept", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "idempotency-key": key,
        origin: "https://app.example.test",
      },
      body: body({ token }),
    });
  }

  it("uses indistinguishable requests, hashed one-time links, sliding sessions, and logout", async () => {
    const unknown = await requestMagicLink("unknown@example.test");
    const known = await requestMagicLink("owner@example.test");
    expect(unknown.status).toBe(202);
    expect(await unknown.json()).toEqual(await known.clone().json());
    expect(email.magicLinks).toHaveLength(1);

    const token = linkToken(email.magicLinks[0]!.url, "magicToken")!;
    const stored = await database
      .selectFrom("magic_link_tokens")
      .select("token_hash")
      .executeTakeFirstOrThrow();
    expect(stored.token_hash).toBe(
      createHash("sha256").update(token).digest("hex"),
    );
    expect(stored.token_hash).not.toContain(token);

    const consume = await app.request("/api/auth/magic-links/consume", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://app.example.test",
      },
      body: body({ token }),
    });
    expect(consume.status).toBe(200);
    const setCookie = consume.headers.get("set-cookie")!;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Max-Age=2592000");
    const cookie = cookieFrom(consume);

    const replay = await app.request("/api/auth/magic-links/consume", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://app.example.test",
      },
      body: body({ token }),
    });
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: { code: "used_magic_link" } });

    now = new Date("2026-10-10T12:00:00.000Z");
    const session = await app.request("/api/session", { headers: { cookie } });
    expect(session.status).toBe(200);
    expect(session.headers.get("set-cookie")).toContain("Max-Age=2592000");

    const missingOrigin = await app.request("/api/logout", {
      method: "POST",
      headers: { cookie },
    });
    expect(missingOrigin.status).toBe(403);
    expect(await missingOrigin.json()).toMatchObject({
      error: { code: "forbidden" },
    });

    const logout = await app.request("/api/logout", {
      method: "POST",
      headers: { cookie, origin: "https://app.example.test" },
    });
    expect(logout.status).toBe(204);
    expect((await app.request("/api/session", { headers: { cookie } })).status).toBe(401);

    now = new Date("2026-10-11T12:00:00.000Z");
    await requestMagicLink("owner@example.test");
    const expiringToken = linkToken(
      email.magicLinks.at(-1)!.url,
      "magicToken",
    )!;
    now = new Date("2026-10-11T12:16:00.000Z");
    const expired = await app.request("/api/auth/magic-links/consume", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://app.example.test",
      },
      body: body({ token: expiringToken }),
    });
    expect(await expired.json()).toMatchObject({ error: { code: "expired_magic_link" } });

    const invalid = await app.request("/api/auth/magic-links/consume", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://app.example.test",
      },
      body: body({ token: "not-a-real-token" }),
    });
    expect(await invalid.json()).toMatchObject({
      error: { code: "invalid_magic_link" },
    });

    now = new Date("2026-10-12T12:00:00.000Z");
    await requestMagicLink("owner@example.test");
    const revokedToken = linkToken(
      email.magicLinks.at(-1)!.url,
      "magicToken",
    )!;
    await database
      .updateTable("magic_link_tokens")
      .set({ revoked_at: now })
      .where(
        "token_hash",
        "=",
        createHash("sha256").update(revokedToken).digest("hex"),
      )
      .execute();
    const revoked = await app.request("/api/auth/magic-links/consume", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://app.example.test",
      },
      body: body({ token: revokedToken }),
    });
    expect(await revoked.json()).toMatchObject({
      error: { code: "revoked_magic_link" },
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await requestMagicLink("limited@example.test")).status).toBe(202);
    }
    const limited = await requestMagicLink("limited@example.test");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect(await limited.json()).toMatchObject({
      error: { code: "rate_limited" },
    });
  });

  it("keeps membership identity stable through removal and rejoin without sharing it across trips", async () => {
    const owner = await login("owner@example.test");
    const first = (await createTrip(owner.cookie, "membership-first-trip")).trip;
    const second = (await createTrip(owner.cookie, "membership-second-trip")).trip;
    expect(first.members[0]!.id).not.toBe(first.members[0]!.userId);
    expect(second.members[0]!.userId).toBe(first.members[0]!.userId);
    expect(second.members[0]!.id).not.toBe(first.members[0]!.id);
    expect((await createTrip(owner.cookie, "membership-first-trip")).trip.members)
      .toEqual(first.members);

    const invitation = await invite(
      owner.cookie, first.id, "returning@example.test", "membership-invite",
    );
    const editor = await login("returning@example.test");
    const acceptance = await accept(editor.cookie, invitation.token, "membership-accept");
    expect(acceptance.status).toBe(200);
    const joined = parseTripResponse(await acceptance.json()).trip.members
      .find((member) => member.email === "returning@example.test")!;
    expect(joined.id).not.toBe(joined.userId);

    const removed = await app.request(`/api/trips/${first.id}/members/${joined.userId}`, {
      method: "DELETE",
      headers: {
        cookie: owner.cookie,
        "idempotency-key": "membership-remove",
        origin: "https://app.example.test",
      },
    });
    expect(removed.status).toBe(204);
    const afterRemoval = await app.request(`/api/trips/${first.id}`, {
      headers: { cookie: owner.cookie },
    });
    expect(parseTripResponse(await afterRemoval.json()).trip.members).toEqual(first.members);

    const reinvitation = await invite(
      owner.cookie, first.id, joined.email, "membership-reinvite",
    );
    const reaccepted = await accept(editor.cookie, reinvitation.token, "membership-reaccept");
    expect(reaccepted.status).toBe(200);
    expect(parseTripResponse(await reaccepted.json()).trip.members
      .find((member) => member.userId === joined.userId)).toEqual(joined);
    const reloaded = await app.request(`/api/trips/${first.id}`, {
      headers: { cookie: editor.cookie },
    });
    expect(reloaded.status).toBe(200);
    expect(parseTripResponse(await reloaded.json()).trip.members
      .find((member) => member.userId === joined.userId)?.id).toBe(joined.id);
  });

  it("creates generic trips transactionally and replays creation without duplicates", async () => {
    const unauthenticated = await app.request("/api/trips");
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toMatchObject({
      error: { code: "unauthenticated" },
    });

    const { cookie } = await login("owner@example.test");
    const invalidTripId = await app.request("/api/trips/not-a-uuid", {
      headers: { cookie },
    });
    expect(invalidTripId.status).toBe(400);
    expect(await invalidTripId.json()).toMatchObject({
      error: { code: "validation_error" },
    });

    const tooManyStops = await app.request("/api/trips", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "idempotency-key": "too-many-country-stops",
        origin: "https://app.example.test",
      },
      body: body({
        name: "Unbounded route",
        startDate: "2027-01-01",
        endDate: "2027-01-02",
        countryCodes: Array.from(
          { length: MAX_TRIP_COUNTRY_STOPS + 1 },
          (_, index) => (index % 2 === 0 ? "JP" : "KR"),
        ),
      }),
    });
    expect(tooManyStops.status).toBe(400);
    expect(await tooManyStops.json()).toMatchObject({
      error: { code: "validation_error" },
    });
    const emptyList = await app.request("/api/trips", { headers: { cookie } });
    expect(parseTripListResponse(await emptyList.json()).trips).toEqual([]);

    const adjacentCountries = await app.request("/api/trips", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "idempotency-key": "adjacent-countries",
        origin: "https://app.example.test",
      },
      body: body({
        name: "Invalid route",
        startDate: "2027-01-01",
        endDate: "2027-01-02",
        countryCodes: ["JP", "JP"],
      }),
    });
    expect(adjacentCountries.status).toBe(400);
    expect(await adjacentCountries.json()).toMatchObject({
      error: { code: "adjacent_country_stops" },
    });
    const first = await createTrip(cookie);
    const replay = await createTrip(cookie);

    expect(replay.trip.id).toBe(first.trip.id);
    expect(first.trip).toMatchObject({
      name: "日本韓國家庭旅行",
      defaultCurrency: null,
      memberCount: 1,
      dayCount: 7,
      members: [{ email: "owner@example.test", role: "owner" }],
      countryStops: [
        { countryCode: "JP", position: 0, timeZone: "Asia/Tokyo" },
        { countryCode: "KR", position: 1, timeZone: "Asia/Seoul" },
        { countryCode: "JP", position: 2, timeZone: "Asia/Tokyo" },
      ],
    });
    expect(first.trip.days.map((day) => day.date)).toEqual([
      "2026-10-21",
      "2026-10-22",
      "2026-10-23",
      "2026-10-24",
      "2026-10-25",
      "2026-10-26",
      "2026-10-27",
    ]);

    const second = await app.request("/api/trips", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "idempotency-key": "create-seoul",
        origin: "https://app.example.test",
      },
      body: body({
        name: "日本週末",
        startDate: "2027-03-05",
        endDate: "2027-03-07",
        countryCodes: ["JP"],
      }),
    });
    expect(second.status).toBe(201);
    expect(parseTripResponse(await second.json()).trip).toMatchObject({
      defaultCurrency: "JPY",
      countryStops: [
        { countryCode: "JP", position: 0, timeZone: "Asia/Tokyo" },
      ],
    });
    const ambiguousTimeZone = await app.request("/api/trips", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "idempotency-key": "create-united-states",
        origin: "https://app.example.test",
      },
      body: body({
        name: "美國公路旅行",
        startDate: "2027-04-10",
        endDate: "2027-04-11",
        countryCodes: ["US"],
      }),
    });
    expect(ambiguousTimeZone.status).toBe(201);
    expect(parseTripResponse(await ambiguousTimeZone.json()).trip).toMatchObject({
      defaultCurrency: "USD",
      countryStops: [{ countryCode: "US", position: 0, timeZone: null }],
    });
    const compatibilityRows = await database
      .selectFrom("trips")
      .select(["time_zone", "currency"])
      .orderBy("start_date")
      .execute();
    expect(
      compatibilityRows.map((trip) => ({
        timeZone: trip.time_zone.trim(),
        currency: trip.currency.trim(),
      })),
    ).toEqual([
      { timeZone: "", currency: "" },
      { timeZone: "Asia/Tokyo", currency: "JPY" },
      { timeZone: "", currency: "USD" },
    ]);
    const list = await app.request("/api/trips", { headers: { cookie } });
    const listBody = parseTripListResponse(await list.json());
    expect(listBody.trips.map((trip) => trip.dayCount)).toEqual([7, 3, 2]);

    const counts = await database
      .selectFrom("trips")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow();
    expect(Number(counts.count)).toBe(3);
    const legacy = await sql<{ count: number }>`
      select count(*)::int as count from trip_summaries
    `.execute(database);
    expect(legacy.rows[0]?.count).toBe(0);
  });

  it("supports arbitrary editors and enforces invite, ownership, and removal rules", async () => {
    const owner = await login("owner@example.test");
    const created = await createTrip(owner.cookie);
    const tripId = created.trip.id;

    const overlongInvite = await app.request(`/api/trips/${tripId}/invites`, {
      method: "POST",
      headers: {
        cookie: owner.cookie,
        "content-type": "application/json",
        "idempotency-key": "overlong-invite",
        origin: "https://app.example.test",
      },
      body: body({ email: `${"a".repeat(310)}@example.test` }),
    });
    expect(overlongInvite.status).toBe(400);
    expect(await overlongInvite.json()).toMatchObject({
      error: { code: "validation_error" },
    });

    const editorSessions: Array<{
      acceptKey: string;
      cookie: string;
      token: string;
      userId: string;
    }> = [];
    for (const [index, address] of [
      "wife@example.test",
      "mother@example.test",
      "friend@example.test",
    ].entries()) {
      const invitation = await invite(
        owner.cookie,
        tripId,
        address,
        `invite-${index}`,
      );
      if (index === 0) {
        const sentCount = email.invites.length;
        const replayedInvite = await app.request(
          `/api/trips/${tripId}/invites`,
          {
            method: "POST",
            headers: {
              cookie: owner.cookie,
              "content-type": "application/json",
              "idempotency-key": `invite-${index}`,
              origin: "https://app.example.test",
            },
            body: body({ email: address }),
          },
        );
        const replayedPayload = parseInviteResponse(
          await replayedInvite.json(),
        );
        expect(replayedPayload.invite.id).toBe(invitation.inviteId);
        expect(email.invites).toHaveLength(sentCount);
        const storedInvite = await database
          .selectFrom("invites")
          .select("token_hash")
          .where("id", "=", invitation.inviteId)
          .executeTakeFirstOrThrow();
        expect(storedInvite.token_hash).toBe(
          createHash("sha256").update(invitation.token).digest("hex"),
        );
      }
      const editor = await login(address);
      const accepted = await accept(
        editor.cookie,
        invitation.token,
        `accept-${index}`,
      );
      expect(accepted.status).toBe(200);
      const acceptedBody = parseTripResponse(await accepted.json());
      editorSessions.push({
        acceptKey: `accept-${index}`,
        cookie: editor.cookie,
        token: invitation.token,
        userId: acceptedBody.trip.members.find((member) => member.email === address)!
          .userId,
      });
      if (index === 0) {
        expect(
          (await accept(editor.cookie, invitation.token, `accept-${index}`))
            .status,
        ).toBe(200);
        const used = await accept(
          editor.cookie,
          invitation.token,
          "accept-used-token",
        );
        expect(await used.json()).toMatchObject({
          error: { code: "used_invite" },
        });
      }
    }

    const secondTrip = await createTrip(owner.cookie, "create-second-invite-scope");
    const secondInvitation = await invite(
      owner.cookie,
      secondTrip.trip.id,
      "wife@example.test",
      "invite-wife-second-trip",
    );
    const secondAcceptance = await accept(
      editorSessions[0]!.cookie,
      secondInvitation.token,
      editorSessions[0]!.acceptKey,
    );
    expect(secondAcceptance.status).toBe(200);
    expect(parseTripResponse(await secondAcceptance.json()).trip.id).toBe(
      secondTrip.trip.id,
    );

    const ownerView = await app.request(`/api/trips/${tripId}`, {
      headers: { cookie: owner.cookie },
    });
    const ownerBody = parseTripResponse(await ownerView.json());
    expect(ownerBody.trip.memberCount).toBe(4);

    const ownerRemoval = await app.request(
      `/api/trips/${tripId}/members/${created.trip.members[0]!.userId}`,
      {
        method: "DELETE",
        headers: {
          cookie: owner.cookie,
          origin: "https://app.example.test",
          "idempotency-key": "reject-owner-removal",
        },
      },
    );
    expect(ownerRemoval.status).toBe(403);
    expect(await ownerRemoval.json()).toMatchObject({
      error: { code: "forbidden" },
    });
    expect(ownerBody.trip.members).toHaveLength(4);

    const editorInviteAttempt = await app.request(`/api/trips/${tripId}/invites`, {
      method: "POST",
      headers: {
        cookie: editorSessions[0]!.cookie,
        "content-type": "application/json",
        "idempotency-key": "editor-cannot-invite",
        origin: "https://app.example.test",
      },
      body: body({ email: "blocked@example.test" }),
    });
    expect(await editorInviteAttempt.json()).toMatchObject({
      error: { code: "forbidden" },
    });

    const outsiderInvite = await invite(
      owner.cookie,
      tripId,
      "outsider@example.test",
      "invite-outsider",
    );
    const outsider = await login("outsider@example.test");
    const hidden = await app.request(`/api/trips/${tripId}`, {
      headers: { cookie: outsider.cookie },
    });
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toMatchObject({ error: { code: "trip_not_found" } });

    const mismatchInvite = await invite(
      owner.cookie,
      tripId,
      "intended@example.test",
      "invite-intended",
    );
    const mismatch = await accept(
      outsider.cookie,
      mismatchInvite.token,
      "accept-wrong-email",
    );
    expect(mismatch.status).toBe(403);
    expect(await mismatch.json()).toMatchObject({
      error: { code: "invite_email_mismatch" },
    });

    const revokedInvite = await invite(
      owner.cookie,
      tripId,
      "revoked@example.test",
      "invite-revoked",
    );
    const revoke = await app.request(
      `/api/trips/${tripId}/invites/${revokedInvite.inviteId}`,
      {
        method: "DELETE",
        headers: {
          cookie: owner.cookie,
          "idempotency-key": "revoke-editor-invite",
          origin: "https://app.example.test",
        },
      },
    );
    expect(revoke.status).toBe(204);
    const replayedRevoke = await app.request(
      `/api/trips/${tripId}/invites/${revokedInvite.inviteId}`,
      {
        method: "DELETE",
        headers: {
          cookie: owner.cookie,
          "idempotency-key": "revoke-editor-invite",
          origin: "https://app.example.test",
        },
      },
    );
    expect(replayedRevoke.status).toBe(204);
    const revokedUser = await login("revoked@example.test");
    const revoked = await accept(
      revokedUser.cookie,
      revokedInvite.token,
      "accept-revoked",
    );
    expect(await revoked.json()).toMatchObject({ error: { code: "revoked_invite" } });

    const expiredInvite = await invite(
      owner.cookie,
      tripId,
      "expired@example.test",
      "invite-expired",
    );
    const expiredUser = await login("expired@example.test");
    now = new Date(now.valueOf() + 8 * 24 * 60 * 60 * 1_000);
    const expired = await accept(
      expiredUser.cookie,
      expiredInvite.token,
      "accept-expired",
    );
    expect(await expired.json()).toMatchObject({ error: { code: "expired_invite" } });

    const removed = editorSessions[0]!;
    const remove = await app.request(
      `/api/trips/${tripId}/members/${removed.userId}`,
      {
        method: "DELETE",
        headers: {
          cookie: owner.cookie,
          "idempotency-key": "remove-editor",
          origin: "https://app.example.test",
        },
      },
    );
    expect(remove.status).toBe(204);
    const replayedRemove = await app.request(
      `/api/trips/${tripId}/members/${removed.userId}`,
      {
        method: "DELETE",
        headers: {
          cookie: owner.cookie,
          "idempotency-key": "remove-editor",
          origin: "https://app.example.test",
        },
      },
    );
    expect(replayedRemove.status).toBe(204);
    expect(
      (
        await app.request(`/api/trips/${tripId}`, {
          headers: { cookie: removed.cookie },
        })
      ).status,
    ).toBe(404);
    const replayAfterRemoval = await accept(
      removed.cookie,
      removed.token,
      removed.acceptKey,
    );
    expect(replayAfterRemoval.status).toBe(404);
    expect(await replayAfterRemoval.json()).toMatchObject({
      error: { code: "trip_not_found" },
    });
    expect(
      (await app.request("/api/session", { headers: { cookie: removed.cookie } }))
        .status,
    ).toBe(200);

    const events = await database
      .selectFrom("change_events")
      .select(["event_type", "summary"])
      .where("trip_id", "=", tripId)
      .execute();
    expect(events.map((event) => event.event_type)).toContain("member.removed");
    expect(JSON.stringify(events)).not.toContain("test-token");
    expect(outsiderInvite.token).not.toBe("");
  });
});
