import { PostgresCollaborationModule } from "../src/private-trips/postgres-collaboration-module";
import { createHash } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql, type Kysely } from "kysely";
import { MAX_TRIP_COUNTRY_STOPS } from "@along-the-way/contracts/countries";
import type { Hono } from "hono";
import {
  parseInviteResponse,
  parseMagicLinkConsumeResponse,
  parseTripListResponse,
  parseTripResponse,
} from "@along-the-way/contracts/private-trips";

import { createApp, type AppDependencies } from "../src/app";
import { PostgresPlaceDetailModule } from "../src/place-details/postgres-place-detail-module";
import { packagedPhotoRoot } from "../src/place-details/photo-assets";
import {
  createDatabase,
  type AlongTheWayDatabase,
} from "../src/database/database";
import { runMigrations } from "../src/database/migrate";
import { seedDatabase } from "../src/database/seed";
import { down as downgradeAuth, up as upgradeAuth } from "../src/database/migrations/029_auth_hardening";
import type { EmailSender } from "../src/private-trips/email-sender";
import { SmtpEmailSender } from "../src/private-trips/smtp-email-sender";
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

const { sendMail } = vi.hoisted(() => ({
  sendMail: vi.fn(async (_message: { to: { address: string; name: string }; subject: string; text: string }) => {}),
}));
vi.mock("nodemailer", () => ({ default: { createTransport: () => ({ sendMail }) } }));

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");

interface CapturedMessage {
  to: string;
  url: string;
  tripName?: string;
  inviterName?: string;
  code?: string;
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
class ScriptedEmailSender implements EmailSender {
  attempts = 0;

  constructor(private readonly failures: unknown[]) {}

  private async deliver() {
    const failure = this.failures[this.attempts];
    this.attempts += 1;
    if (failure) throw failure;
  }

  async sendMagicLink() {
    await this.deliver();
  }

  async sendTripInvite() {
    await this.deliver();
  }
}

function smtpError(responseCode: number, response = `SMTP ${responseCode}`) {
  return Object.assign(new Error(response), { responseCode, response });
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
  let tokenIssuer: TokenIssuer;
  let app: Hono;
  let appDependencies: AppDependencies;
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
    email = new CapturingEmailSender();
    now = new Date("2026-09-27T12:00:00.000Z");
    tokenNumber = 0;
    const tokenSecret = "integration-test-token-secret-at-least-thirty-two-bytes";
    tokenIssuer = new TokenIssuer(tokenSecret);
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
    appDependencies = {
      placeDetails: new PostgresPlaceDetailModule({ database, assetRoot: packagedPhotoRoot }),
      collaboration: new PostgresCollaborationModule(database),
      dayPlans: unrelatedDayPlanModule,
      discovery: unrelatedDiscoveryModule,
      identityAccess,
      rateLimiter: new PostgresRateLimiter(
        database,
        tokenSecret,
        () => new Date(now),
      ),
      readiness: new PostgresReadinessProbe(database, () => new Date(now)),
      siteAddress: "HTTPS://app.example.test",
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
    };
    app = createApp(appDependencies);
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

  async function requestInviteMagicLink(inviteToken: string) {
    return app.request("/api/auth/invite-magic-links", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://app.example.test",
      },
      body: body({ inviteToken }),
    });
  }

  async function consumeMagicLink(token: string) {
    return app.request("/api/auth/magic-links/consume", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://app.example.test",
      },
      body: body({ token, confirm: true }),
    });
  }

  async function login(address: string) {
    // These older membership scenarios start with an independently approved active account.
    await database.updateTable("users").set({ status: "active" }).where("email", "=", address).execute();
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
        cookie: cookieFrom(request),
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
        flights: tripFlights(),
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

  function authPost(path: string, payload: unknown, cookie = "") {
    return app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://app.example.test", cookie },
      body: body(payload),
    });
  }

  it.each([
    "http://app.example.test", "http://192.0.2.1", "http://localhost.example.test",
    "http://[2001:db8::1]", "ftp://localhost",
  ])("SEC-05 refuses insecure non-loopback startup at %s", (siteAddress) => {
    expect(() => createApp({ ...appDependencies, siteAddress })).toThrow(
      "SITE_ADDRESS must use HTTPS, except HTTP on localhost, 127.0.0.1 or ::1.",
    );
  });

  it.each([
    "http://localhost", "http://localhost:8080", "http://127.0.0.1:8080",
    "http://[::1]:8080", "https://app.example.test",
  ])("SEC-05 permits secure or local startup at %s", async (siteAddress) => {
    const configuredApp = createApp({ ...appDependencies, siteAddress });
    expect((await configuredApp.request("/health")).status).toBe(200);
    const response = await configuredApp.request("/api/auth/magic-links", {
      method: "POST", headers: { origin: new URL(siteAddress).origin, "content-type": "application/json" },
      body: body({ email: "unknown@example.test" }),
    });
    expect(response.status).toBe(202);
    if (siteAddress.startsWith("https:")) {
      expect(response.headers.get("set-cookie")).toContain("__Host-along_the_way_login_nonce=");
      expect(response.headers.get("set-cookie")).toContain("Secure");
    } else {
      expect(response.headers.get("set-cookie")).toMatch(/^along_the_way_login_nonce=/);
      expect(response.headers.get("set-cookie")).not.toContain("Secure");
    }
  });

  it("SEC-02 disabling an account rejects every session and already-issued sign-in credential", async () => {
    const first = await login("owner@example.test");
    const second = await login("owner@example.test");
    const requested = await requestMagicLink("owner@example.test");
    const message = email.magicLinks.at(-1)!;
    const token = linkToken(message.url, "magicToken")!;
    await database.updateTable("users").set({ status: "disabled" }).where("email", "=", message.to).execute();
    for (const cookie of [first.cookie, second.cookie]) {
      for (const path of ["/api/session", "/api/trips"]) {
        expect((await app.request(path, { headers: { cookie } })).status).toBe(401);
      }
      expect((await authPost("/api/trips", {}, cookie)).status).toBe(401);
    }
    const count = email.magicLinks.length;
    expect((await authPost("/api/auth/magic-links", { email: message.to })).status).toBe(202);
    expect(await emailWorker.runOnce()).toBe(false);
    expect(email.magicLinks).toHaveLength(count);
    expect((await authPost("/api/auth/magic-links/consume", { token, confirm: true }, cookieFrom(requested))).status).toBe(400);
    expect((await authPost("/api/auth/magic-links/verify-code", { email: message.to, code: message.code }, cookieFrom(requested))).status).toBe(400);
    expect((await database.selectFrom("users").select("status").where("email", "=", message.to).executeTakeFirstOrThrow()).status).toBe("disabled");
  });

  it("SEC-02 disabled invitees cannot receive new invitations or activate through an existing invitation", async () => {
    const owner = await login("owner@example.test");
    const trip = (await createTrip(owner.cookie, "disabled-invite-trip")).trip;
    const secondTrip = (await createTrip(owner.cookie, "disabled-other-trip")).trip;
    const invitation = await invite(owner.cookie, trip.id, "disabled@example.test", "disabled-invite");
    const requested = await requestInviteMagicLink(invitation.token);
    await emailWorker.runOnce();
    const message = email.magicLinks.at(-1)!;
    await database.updateTable("users").set({ status: "disabled" }).where("email", "=", message.to).execute();
    const count = email.magicLinks.length;
    expect((await requestInviteMagicLink(invitation.token)).status).toBe(202);
    expect(await emailWorker.runOnce()).toBe(false);
    expect(email.magicLinks).toHaveLength(count);
    const token = linkToken(message.url, "magicToken")!;
    expect((await authPost("/api/auth/magic-links/consume", { token, confirm: true }, cookieFrom(requested))).status).toBe(400);
    const response = await app.request(`/api/trips/${secondTrip.id}/invites`, {
      method: "POST", headers: { cookie: owner.cookie, origin: "https://app.example.test", "content-type": "application/json", "idempotency-key": "disabled-new-invite" },
      body: body({ email: message.to }),
    });
    expect(response.status).toBe(403);
    expect((await database.selectFrom("users").select("status").where("email", "=", message.to).executeTakeFirstOrThrow()).status).toBe("disabled");
    expect(await emailWorker.runOnce()).toBe(false);
  });

  it("SEC-02 queued magic-link and invitation email is skipped after its recipient is disabled", async () => {
    const owner = await login("owner@example.test");
    const tripId = (await createTrip(owner.cookie)).trip.id;
    await database.insertInto("users").values({ email: "queued-disabled@example.test", display_name: null, status: "active" }).execute();
    expect((await authPost("/api/auth/magic-links", { email: "queued-disabled@example.test" })).status).toBe(202);
    const invited = await app.request(`/api/trips/${tripId}/invites`, {
      method: "POST", headers: { cookie: owner.cookie, origin: "https://app.example.test", "content-type": "application/json", "idempotency-key": "queued-disabled" },
      body: body({ email: "queued-disabled@example.test" }),
    });
    expect(invited.status).toBe(201);
    await database.updateTable("users").set({ status: "disabled" }).where("email", "=", "queued-disabled@example.test").execute();
    expect(await emailWorker.runOnce()).toBe(true);
    expect(await emailWorker.runOnce()).toBe(true);
    expect(email.magicLinks).toHaveLength(1);
    expect(email.invites).toHaveLength(0);
  });

  it("SEC-02 disabling an account closes an existing SSE stream before its next private payload", async () => {
    const owner = await login("owner@example.test");
    const tripId = (await createTrip(owner.cookie)).trip.id;
    const invitation = await invite(owner.cookie, tripId, "stream-disabled@example.test", "stream-disabled");
    const member = await login("stream-disabled@example.test");
    expect((await accept(member.cookie, invitation.token, "accept-stream-disabled")).status).toBe(200);
    const version = await (await app.request(`/api/trips/${tripId}/version`, { headers: { cookie: member.cookie } })).json() as { lastEventId: string };
    const controller = new AbortController();
    const response = await app.request(`/api/trips/${tripId}/events`, {
      headers: { cookie: member.cookie, "last-event-id": version.lastEventId }, signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    try {
      const connected = await reader.read();
      expect(new TextDecoder().decode(connected.value)).toContain(": connected");
      await database.updateTable("users").set({ status: "disabled" }).where("email", "=", "stream-disabled@example.test").execute();
      await invite(owner.cookie, tripId, "stream-event@example.test", "stream-event");
      const next = await reader.read();
      expect(next.done).toBe(true);
      expect((await app.request(`/api/trips/${tripId}/events`, { headers: { cookie: member.cookie } })).status).toBe(401);
    } finally {
      controller.abort();
      await reader.cancel();
    }
  });

  it("SEC-01 requires confirmation for a foreign browser without consuming the link", async () => {
    await requestMagicLink("owner@example.test");
    const token = linkToken(email.magicLinks.at(-1)!.url, "magicToken")!;
    const foreign = await authPost("/api/auth/magic-links/consume", { token });
    expect(foreign.status).toBe(409);
    expect(await foreign.json()).toMatchObject({
      error: { code: "confirmation_required" },
      targetEmail: "ow***@example.test",
      currentEmail: null,
    });
    expect((await database.selectFrom("magic_link_tokens").select("used_at").executeTakeFirstOrThrow()).used_at).toBeNull();
    const confirmed = await authPost("/api/auth/magic-links/consume", { token, confirm: true });
    expect(confirmed.status).toBe(200);
    expect((await app.request("/api/session", { headers: { cookie: cookieFrom(confirmed) } })).status).toBe(200);
  });

  it("SEC-01/05 binds same-browser links and issues host-only nonce and session cookies", async () => {
    const unknown = await requestMagicLink("unknown@example.test");
    const requested = await requestMagicLink("owner@example.test");
    for (const response of [unknown, requested]) {
      expect(response.status).toBe(202);
      const header = response.headers.get("set-cookie")!;
      expect(header).toMatch(/^__Host-along_the_way_login_nonce=/);
      expect(header).toContain("HttpOnly");
      expect(header).toContain("Secure");
      expect(header).toContain("SameSite=Lax");
      expect(header).toContain("Max-Age=900");
      expect(header).not.toContain("Domain=");
    }
    const token = linkToken(email.magicLinks.at(-1)!.url, "magicToken")!;
    const consumed = await authPost("/api/auth/magic-links/consume", { token }, cookieFrom(requested));
    expect(consumed.status).toBe(200);
    const cookie = cookieFrom(consumed);
    expect(cookie).toMatch(/^__Host-along_the_way_session=/);
    expect((await app.request("/api/session", { headers: { cookie } })).status).toBe(200);
    const legacy = cookie.replace("__Host-", "");
    expect((await app.request("/api/session", { headers: { cookie: legacy } })).status).toBe(401);
  });

  it("SEC-01 requires account-switch confirmation even with the nonce and revokes the replaced session", async () => {
    const original = await login("owner@example.test");
    await database.insertInto("users").values({ email: "new@example.test", display_name: null, status: "active" }).execute();
    const requested = await requestMagicLink("new@example.test");
    const token = linkToken(email.magicLinks.at(-1)!.url, "magicToken")!;
    const cookies = `${original.cookie}; ${cookieFrom(requested)}`;
    const response = await authPost("/api/auth/magic-links/consume", { token }, cookies);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ targetEmail: "ne***@example.test", currentEmail: "ow***@example.test" });
    expect((await app.request("/api/session", { headers: { cookie: original.cookie } })).status).toBe(200);
    const confirmed = await authPost("/api/auth/magic-links/consume", { token, confirm: true }, cookies);
    expect(confirmed.status).toBe(200);
    expect(parseMagicLinkConsumeResponse(await confirmed.json()).user.email).toBe("new@example.test");
    expect((await app.request("/api/session", { headers: { cookie: original.cookie } })).status).toBe(401);
  });

  it("SEC-01 verifies a one-time code only in the requesting browser", async () => {
    const requested = await requestMagicLink("owner@example.test");
    const message = email.magicLinks.at(-1)!;
    expect(message.code).toMatch(/^\d{6}$/);
    const payload = { email: " OWNER@example.test ", code: message.code };
    const foreign = await authPost("/api/auth/magic-links/verify-code", payload);
    expect(foreign.status).toBe(400);
    const wrongNonce = await requestMagicLink("unknown@example.test");
    expect((await authPost("/api/auth/magic-links/verify-code", { ...payload, confirm: true }, cookieFrom(wrongNonce))).status).toBe(400);
    const verified = await authPost("/api/auth/magic-links/verify-code", payload, cookieFrom(requested));
    expect(verified.status).toBe(200);
    expect(parseMagicLinkConsumeResponse(await verified.json()).user.email).toBe("owner@example.test");
    const token = linkToken(message.url, "magicToken")!;
    expect((await authPost("/api/auth/magic-links/consume", { token, confirm: true })).status).toBe(400);
    expect((await authPost("/api/auth/magic-links/verify-code", payload, cookieFrom(requested))).status).toBe(400);
  });

  it("SEC-01 revokes both the link and code after five wrong codes", async () => {
    const requested = await requestMagicLink("owner@example.test");
    const message = email.magicLinks.at(-1)!;
    const wrongCode = message.code === "000000" ? "000001" : "000000";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await authPost("/api/auth/magic-links/verify-code", { email: message.to, code: wrongCode }, cookieFrom(requested));
      expect(response.status).toBe(400);
    }
    const correct = await authPost("/api/auth/magic-links/verify-code", { email: message.to, code: message.code }, cookieFrom(requested));
    expect(correct.status).toBe(400);
    const token = linkToken(message.url, "magicToken")!;
    const response = await authPost("/api/auth/magic-links/consume", { token, confirm: true });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "revoked_magic_link" } });
  });

  it("SEC-01 expires codes and rate-limits code guesses", async () => {
    const requested = await requestMagicLink("owner@example.test");
    const message = email.magicLinks.at(-1)!;
    now = new Date(now.valueOf() + 15 * 60 * 1_000);
    expect((await authPost("/api/auth/magic-links/verify-code", { email: message.to, code: message.code }, cookieFrom(requested))).status).toBe(400);
    for (let attempt = 0; attempt < 9; attempt += 1) {
      expect((await authPost("/api/auth/magic-links/verify-code", { email: message.to, code: "000000" })).status).toBe(400);
    }
    const limited = await authPost("/api/auth/magic-links/verify-code", { email: message.to, code: "000000" });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
  });

  it("SEC-02 keeps invited users inactive until an invite-linked sign-in accepts membership", async () => {
    const owner = await login("owner@example.test");
    const trip = (await createTrip(owner.cookie)).trip;
    const invitation = await invite(owner.cookie, trip.id, "pending@example.test", "pending");
    const before = email.magicLinks.length;
    expect((await requestMagicLink("pending@example.test")).status).toBe(202);
    expect(email.magicLinks).toHaveLength(before);
    const requested = await requestInviteMagicLink(invitation.token);
    await emailWorker.runOnce();
    const token = linkToken(email.magicLinks.at(-1)!.url, "magicToken")!;
    const accepted = await authPost("/api/auth/magic-links/consume", { token }, cookieFrom(requested));
    expect(accepted.status).toBe(200);
    expect(parseMagicLinkConsumeResponse(await accepted.json())).toMatchObject({ acceptedTripId: trip.id, inviteOutcome: "accepted" });
    expect((await app.request(`/api/trips/${trip.id}`, { headers: { cookie: cookieFrom(accepted) } })).status).toBe(200);
    const count = email.magicLinks.length;
    expect((await requestMagicLink("pending@example.test")).status).toBe(202);
    expect(email.magicLinks).toHaveLength(count + 1);
  });

  it("SEC-02 enforces one daily outbound email budget across magic links and invitations", async () => {
    const owner = await login("owner@example.test");
    const trip = (await createTrip(owner.cookie)).trip;
    await database.updateTable("rate_limit_windows").set({ request_count: 300 }).where("scope", "=", "email_send:ip").execute();
    const previous = email.magicLinks.length;
    const known = await requestMagicLink("owner@example.test");
    const unknown = await requestMagicLink("unknown@example.test");
    expect(known.status).toBe(202);
    expect(await known.json()).toEqual(await unknown.json());
    expect(email.magicLinks).toHaveLength(previous);
    const response = await app.request(`/api/trips/${trip.id}/invites`, {
      method: "POST", headers: { cookie: owner.cookie, origin: "https://app.example.test", "content-type": "application/json", "idempotency-key": "budget" },
      body: body({ email: "new@example.test" }),
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBeTruthy();
    expect(await emailWorker.runOnce()).toBe(false);
    now = new Date("2026-09-28T00:00:00Z");
    expect((await requestMagicLink("owner@example.test")).status).toBe(202);
    expect(email.magicLinks).toHaveLength(previous + 1);
  });

  it("SEC-02 rolls back email budget when enqueueing fails", async () => {
    await requestMagicLink("owner@example.test");
    const existingToken = linkToken(email.magicLinks.at(-1)!.url, "magicToken")!;
    await database.updateTable("rate_limit_windows").set({ request_count: 299 }).where("scope", "=", "email_send:ip").execute();
    // A duplicate token makes the real insert fail after the budget reservation.
    const issuer = vi.spyOn(tokenIssuer, "issue").mockReturnValueOnce(existingToken);
    expect((await requestMagicLink("owner@example.test")).status).toBe(500);
    issuer.mockRestore();
    expect(email.magicLinks).toHaveLength(1);
    expect((await requestMagicLink("owner@example.test")).status).toBe(202);
    expect(email.magicLinks).toHaveLength(2);
    expect((await requestMagicLink("owner@example.test")).status).toBe(202);
    expect(email.magicLinks).toHaveLength(2);
  });

  it("SEC-02 sanitizes untrusted trip and inviter labels before email delivery", async () => {
    const owner = await login("owner@example.test");
    const trip = (await createTrip(owner.cookie)).trip;
    await database.updateTable("trips").set({ name: `Plan https://evil.example/login www.bad.test bad.example\n${"長".repeat(100)}` }).where("id", "=", trip.id).execute();
    await database.updateTable("users").set({ display_name: "Name http://bad.test www.bad.test bad.example\n你好" }).where("email", "=", "owner@example.test").execute();
    await invite(owner.cookie, trip.id, "safe@example.test", "sanitized");
    const message = email.invites.at(-1)!;
    expect(message.tripName).toMatch(/^Plan 長/);
    expect(message.tripName!.length).toBeLessThanOrEqual(60);
    expect(message.inviterName).toBe("Name 你好");
    expect(`${message.tripName} ${message.inviterName}`).not.toMatch(/http|www\.|bad\.|evil\.|[\r\n]/);
    expect(new URL(message.url).origin).toBe("https://app.example.test");
  });

  it("SEC-01/02/04 delivers the real email template with a usable code and literal recipient", async () => {
    sendMail.mockClear();
    const smtpWorker = new PostgresEmailWorker({
      database, tokenIssuer, siteAddress: "https://app.example.test", now: () => new Date(now),
      emailSender: new SmtpEmailSender({
        host: "unused.example.test", port: 465, from: "official@example.test", requireTls: true, secure: true,
      }),
    });
    const requested = await authPost("/api/auth/magic-links", { email: " OWNER@example.test " });
    expect(requested.status).toBe(202);
    await smtpWorker.runOnce();
    const message = sendMail.mock.calls[0]![0];
    expect(message.to).toEqual({ address: "owner@example.test", name: "" });
    const code = /一次性登入碼：(\d{6})/.exec(message.text)?.[1];
    expect(code).toMatch(/^\d{6}$/);
    expect(message.text).toContain("請在你索取連結的瀏覽器");
    const verified = await authPost("/api/auth/magic-links/verify-code", { email: message.to.address, code }, cookieFrom(requested));
    expect(verified.status).toBe(200);
    const trip = (await createTrip(cookieFrom(verified))).trip;
    await database.updateTable("trips").set({ name: "Trip https://evil.example" }).where("id", "=", trip.id).execute();
    const invited = await app.request(`/api/trips/${trip.id}/invites`, {
      method: "POST", headers: { cookie: cookieFrom(verified), origin: "https://app.example.test", "content-type": "application/json", "idempotency-key": "smtp-template" },
      body: body({ email: "new@example.test" }),
    });
    expect(invited.status).toBe(201);
    await smtpWorker.runOnce();
    const invitation = sendMail.mock.calls[1]![0];
    expect(invitation.to).toEqual({ address: "new@example.test", name: "" });
    expect(invitation.subject).toBe("邀請你加入旅程｜Along the Way");
    expect(invitation.text).toContain("「Trip」");
    expect(invitation.text).not.toContain("evil.example");
  });

  it("SEC-03 revokes every session through logout-everywhere", async () => {
    const first = await login("owner@example.test");
    const second = await login("owner@example.test");
    const response = await authPost("/api/logout-everywhere", {}, first.cookie);
    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toContain("__Host-along_the_way_session=;");
    for (const cookie of [first.cookie, second.cookie]) {
      expect((await app.request("/api/session", { headers: { cookie } })).status).toBe(401);
      expect((await app.request("/api/trips", { headers: { cookie } })).status).toBe(401);
    }
  });

  it("SEC-03 caps sliding sessions at an absolute ninety days", async () => {
    const signedIn = await login("owner@example.test");
    const created = now.valueOf();
    for (const days of [29, 58, 87, 89]) {
      now = new Date(created + days * 24 * 60 * 60 * 1_000);
      expect((await app.request("/api/session", { headers: { cookie: signedIn.cookie } })).status).toBe(200);
    }
    now = new Date(created + 90 * 24 * 60 * 60 * 1_000);
    expect((await app.request("/api/session", { headers: { cookie: signedIn.cookie } })).status).toBe(401);
  });

  it("SEC-04 rejects address-list syntax and normalizes a single plain address", async () => {
    const owner = await login("owner@example.test");
    const trip = (await createTrip(owner.cookie)).trip;
    for (const [index, address] of ["1<victim@x.com>", '"victim"@x.com', "a,b@x.com", "a;b@x.com", "a b@x.com", "a@@x.com", ".a@x.com", "a@-x.com"].entries()) {
      const response = await app.request(`/api/trips/${trip.id}/invites`, {
        method: "POST", headers: { cookie: owner.cookie, origin: "https://app.example.test", "content-type": "application/json", "idempotency-key": `strict-${index}` },
        body: body({ email: address }),
      });
      expect(response.status, address).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "validation_error" } });
    }
    await invite(owner.cookie, trip.id, " Ｎｅｗ+tag@EXAMPLE.test ", "normalized");
    expect(email.invites.at(-1)!.to).toBe("new+tag@example.test");
  });

  it("SEC-02 applies daily invitation and trip-creation caps", async () => {
    const owner = await login("owner@example.test");
    let firstTripId = "";
    for (let index = 0; index < 5; index += 1) {
      const trip = (await createTrip(owner.cookie, `daily-trip-${index}`)).trip;
      firstTripId ||= trip.id;
    }
    expect((await authPost("/api/trips", {}, owner.cookie)).status).toBe(429);
    for (let index = 0; index < 10; index += 1) {
      await invite(owner.cookie, firstTripId, `daily-${index}@example.test`, `daily-invite-${index}`);
    }
    const limited = await app.request(`/api/trips/${firstTripId}/invites`, {
      method: "POST", headers: { cookie: owner.cookie, origin: "https://app.example.test", "content-type": "application/json", "idempotency-key": "daily-overflow" },
      body: body({ email: "overflow@example.test" }),
    });
    expect(limited.status).toBe(429);
    now = new Date("2026-09-28T00:00:00Z");
    await createTrip(owner.cookie, "next-day");
    await invite(owner.cookie, firstTripId, "next-day@example.test", "next-day");
  });

  it("SEC-02 supports auth migration down/up without activating invited or disabled users", async () => {
    const owner = await login("owner@example.test");
    const trip = (await createTrip(owner.cookie)).trip;
    const invitation = await invite(owner.cookie, trip.id, "unaccepted@example.test", "downgrade");
    const invitee = await database.selectFrom("users").select(["id", "status"])
      .where("email", "=", "unaccepted@example.test").executeTakeFirstOrThrow();
    await database.updateTable("users").set({ status: "disabled" }).where("email", "=", "owner@example.test").execute();
    await downgradeAuth(database);
    expect(await database.selectFrom("users").select(["id", "status"])
      .where("email", "=", "unaccepted@example.test").executeTakeFirst()).toEqual(invitee);
    expect((await app.request("/api/session", { headers: { cookie: owner.cookie } })).status).toBe(401);
    await upgradeAuth(database);
    const count = email.magicLinks.length;
    await requestMagicLink("unaccepted@example.test");
    expect(email.magicLinks).toHaveLength(count);
    const requested = await requestInviteMagicLink(invitation.token);
    expect(requested.status).toBe(202);
    await emailWorker.runOnce();
    expect(email.magicLinks).toHaveLength(count + 1);
    const token = linkToken(email.magicLinks.at(-1)!.url, "magicToken")!;
    const consumed = await authPost("/api/auth/magic-links/consume", { token }, cookieFrom(requested));
    expect(consumed.status).toBe(200);
    expect(parseMagicLinkConsumeResponse(await consumed.json())).toMatchObject({
      user: { id: invitee.id }, acceptedTripId: trip.id, inviteOutcome: "accepted",
    });
    expect((await app.request(`/api/trips/${trip.id}`, { headers: { cookie: cookieFrom(consumed) } })).status).toBe(200);
    expect((await app.request("/api/session", { headers: { cookie: owner.cookie } })).status).toBe(401);
    await requestMagicLink("owner@example.test");
    expect(email.magicLinks).toHaveLength(count + 1);
  });

  it("rejects oversized API bodies before auth work or route parsing", async () => {
    const oversizedAuth = await app.request("/api/auth/magic-links", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://app.example.test",
      },
      body: body({ email: `${"a".repeat(9 * 1_024)}@example.test` }),
    });
    expect(oversizedAuth.status).toBe(413);
    expect(await oversizedAuth.json()).toMatchObject({
      error: { code: "payload_too_large" },
    });
    expect(Number((await database
      .selectFrom("rate_limit_windows")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow()).count)).toBe(0);
    expect(Number((await database
      .selectFrom("magic_link_tokens")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow()).count)).toBe(0);

    const normalAuth = await requestMagicLink("owner@example.test");
    expect(normalAuth.status).toBe(202);
    const token = linkToken(email.magicLinks.at(-1)!.url, "magicToken")!;
    const consume = await consumeMagicLink(token);
    expect(consume.status).toBe(200);

    const oversizedTrip = await app.request("/api/trips", {
      method: "POST",
      headers: {
        cookie: cookieFrom(consume),
        "content-type": "application/json",
        "idempotency-key": "oversized-trip",
        origin: "https://app.example.test",
      },
      body: body({ name: "x".repeat(2 * 1_024 * 1_024 + 1) }),
    });
    expect(oversizedTrip.status).toBe(413);
    expect(await oversizedTrip.json()).toMatchObject({
      error: { code: "payload_too_large" },
    });
    const largeButAllowedTrip = await app.request("/api/trips", {
      method: "POST",
      headers: {
        cookie: cookieFrom(consume),
        "content-type": "application/json",
        "idempotency-key": "large-allowed-trip",
        origin: "https://app.example.test",
      },
      body: body({ name: "x".repeat(1_500_000) }),
    });
    expect(largeButAllowedTrip.status).toBe(400);
    expect(await largeButAllowedTrip.json()).toMatchObject({
      error: { code: "validation_error" },
    });
  });

  it("SEC-02 bounds delivery-day sends across an outage backlog and defers excess until tomorrow", async () => {
    await login("owner@example.test");
    now = new Date("2026-09-28T12:00:00Z");
    let firstOwnerCookie = "";
    let firstTripId = "";
    for (let account = 0; account < 30; account += 1) {
      const owner = await database.insertInto("users")
        .values({ email: `queue-owner-${account}@example.test`, display_name: null, status: "active" })
        .returning("id").executeTakeFirstOrThrow();
      const token = `backlog-owner-${account}`;
      await database.insertInto("sessions").values({
        user_id: owner.id, token_hash: createHash("sha256").update(token).digest("hex"),
        created_at: now, last_seen_at: now, expires_at: "2026-10-28T12:00:00Z", revoked_at: null,
      }).execute();
      const cookie = `__Host-along_the_way_session=${token}`;
      const tripId = (await createTrip(cookie, `backlog-trip-${account}`)).trip.id;
      if (account === 0) { firstOwnerCookie = cookie; firstTripId = tripId; }
      for (let recipient = 0; recipient < 10; recipient += 1) {
        const response = await app.request(`/api/trips/${tripId}/invites`, {
          method: "POST",
          headers: { cookie, origin: "https://app.example.test", "content-type": "application/json",
            "idempotency-key": `queued-${recipient}`, "x-forwarded-for": `203.0.113.${account + 1}` },
          body: body({ email: `recipient-${account}-${recipient}@example.test` }),
        });
        expect(response.status).toBe(201);
      }
    }
    expect(email.invites).toHaveLength(0);
    now = new Date("2026-09-29T12:00:00Z");
    const todayInvite = await app.request(`/api/trips/${firstTripId}/invites`, {
      method: "POST",
      headers: { cookie: firstOwnerCookie, origin: "https://app.example.test", "content-type": "application/json", "idempotency-key": "today-invite" },
      body: body({ email: "today-recipient@example.test" }),
    });
    expect(todayInvite.status).toBe(201);
    expect((await authPost("/api/auth/magic-links", { email: "owner@example.test" })).status).toBe(202);
    while (await emailWorker.runOnce()) { /* Drain only jobs eligible today. */ }
    expect(email.invites).toHaveLength(300);
    expect(email.magicLinks).toHaveLength(1);
    expect(email.invites.some((message) => message.to === "today-recipient@example.test")).toBe(false);
    const deferred = await database.selectFrom("email_jobs").select(["kind", "available_at", "failed_at", "attempt_count"])
      .where("delivered_at", "is", null).execute();
    expect(deferred).toHaveLength(2);
    for (const job of deferred) {
      expect(job.available_at.toISOString()).toBe("2026-09-30T00:00:00.000Z");
      expect(job.failed_at).toBeNull();
      expect(job.attempt_count).toBe(0);
    }
    now = new Date("2026-09-30T00:00:00Z");
    while (await emailWorker.runOnce()) { /* Expired magic links are skipped; live invitations remain deliverable. */ }
    expect(email.invites).toHaveLength(301);
    expect(email.invites.at(-1)!.to).toBe("today-recipient@example.test");
    expect(email.magicLinks).toHaveLength(1);
  }, 60_000);

  it.each([
    [550, "550 5.4.5 Daily user sending limit exceeded"],
    [550, "550 Daily sending quota exceeded"],
    [450, "450 4.7.0 Temporary rate limit"],
  ])("SEC-02 retries SMTP quota/transient response %s %s", async (responseCode, responseText) => {
    const owner = await login("owner@example.test");
    const tripId = (await createTrip(owner.cookie)).trip.id;
    const response = await app.request(`/api/trips/${tripId}/invites`, {
      method: "POST",
      headers: { cookie: owner.cookie, origin: "https://app.example.test", "content-type": "application/json", "idempotency-key": "quota-retry" },
      body: body({ email: "quota-recipient@example.test" }),
    });
    expect(response.status).toBe(201);
    const sender = new ScriptedEmailSender([smtpError(responseCode, responseText)]);
    const worker = new PostgresEmailWorker({ database, tokenIssuer, emailSender: sender, siteAddress: "https://app.example.test", now: () => new Date(now) });
    expect(await worker.runOnce()).toBe(true);
    expect(await worker.runOnce()).toBe(false);
    const job = await database.selectFrom("email_jobs").select(["failed_at", "delivered_at", "attempt_count", "available_at"])
      .where("recipient", "=", "quota-recipient@example.test").executeTakeFirstOrThrow();
    expect(job.failed_at).toBeNull();
    expect(job.delivered_at).toBeNull();
    expect(job.attempt_count).toBe(1);
    expect(job.available_at.valueOf()).toBe(now.valueOf() + 30_000);
    now = new Date(now.valueOf() + 30_000);
    expect(await worker.runOnce()).toBe(true);
    expect(sender.attempts).toBe(2);
    const delivered = await database.selectFrom("email_jobs").select(["failed_at", "delivered_at"])
      .where("recipient", "=", "quota-recipient@example.test").executeTakeFirstOrThrow();
    expect(delivered.failed_at).toBeNull();
    expect(delivered.delivered_at).not.toBeNull();
  });

  it("SEC-03 targeted logout leaves a replacement account session and cookie untouched", async () => {
    const original = await login("owner@example.test");
    const originalUser = parseMagicLinkConsumeResponse(await (await app.request("/api/session", { headers: { cookie: original.cookie } })).json()).user;
    await database.insertInto("users").values({ email: "replacement@example.test", display_name: null, status: "active" }).execute();
    const replacement = await login("replacement@example.test");
    const replacementUser = parseMagicLinkConsumeResponse(await (await app.request("/api/session", { headers: { cookie: replacement.cookie } })).json()).user;
    const staleLogout = await authPost("/api/logout", { userId: originalUser.id }, replacement.cookie);
    expect(staleLogout.status).toBe(409);
    expect(await staleLogout.json()).toMatchObject({ error: { code: "logout_target_mismatch" } });
    expect(staleLogout.headers.get("set-cookie")).toBeNull();
    expect((await app.request("/api/session", { headers: { cookie: replacement.cookie } })).status).toBe(200);
    expect((await app.request("/api/session", { headers: { cookie: original.cookie } })).status).toBe(200);
    const matchingLogout = await authPost("/api/logout", { userId: replacementUser.id }, replacement.cookie);
    expect(matchingLogout.status).toBe(204);
    expect(matchingLogout.headers.get("set-cookie")).toContain("__Host-along_the_way_session=;");
    expect((await app.request("/api/session", { headers: { cookie: replacement.cookie } })).status).toBe(401);
    expect((await authPost("/api/logout", { userId: originalUser.id })).status).toBe(204);
    expect((await app.request("/api/logout", { method: "POST", headers: { origin: "https://app.example.test", cookie: original.cookie } })).status).toBe(204);
  });

  it("keeps retrying transient email failures and delivers after recovery", async () => {
    const owner = await login("owner@example.test");
    const trip = (await createTrip(owner.cookie, "transient-email-failure")).trip;
    const queued = await app.request(`/api/trips/${trip.id}/invites`, {
      method: "POST",
      headers: {
        cookie: owner.cookie,
        "content-type": "application/json",
        "idempotency-key": "transient-email-failure",
        origin: "https://app.example.test",
      },
      body: body({ email: "temporarily-unavailable@example.test" }),
    });
    expect(queued.status).toBe(201);

    const scriptedEmail = new ScriptedEmailSender(
      Array.from({ length: 5 }, () => smtpError(451)),
    );
    const retryingWorker = new PostgresEmailWorker({
      database,
      emailSender: scriptedEmail,
      siteAddress: "https://app.example.test",
      tokenIssuer,
      now: () => new Date(now),
    });
    for (const delaySeconds of [30, 120, 600, 3_600, 21_600]) {
      expect(await retryingWorker.runOnce()).toBe(true);
      now = new Date(now.valueOf() + delaySeconds * 1_000);
    }
    expect(await retryingWorker.runOnce()).toBe(true);
    const deliveredJob = await database
      .selectFrom("email_jobs")
      .select(["attempt_count", "delivered_at", "failed_at"])
      .where("recipient", "=", "temporarily-unavailable@example.test")
      .executeTakeFirstOrThrow();
    expect(deliveredJob.attempt_count).toBe(5);
    expect(deliveredJob.delivered_at).not.toBeNull();
    expect(deliveredJob.failed_at).toBeNull();
    expect(scriptedEmail.attempts).toBe(6);
  });

  it("terminal-fails a definitive permanent SMTP rejection immediately", async () => {
    const owner = await login("owner@example.test");
    const trip = (await createTrip(owner.cookie, "permanent-email-failure")).trip;
    const queued = await app.request(`/api/trips/${trip.id}/invites`, {
      method: "POST",
      headers: {
        cookie: owner.cookie,
        "content-type": "application/json",
        "idempotency-key": "permanent-email-failure",
        origin: "https://app.example.test",
      },
      body: body({ email: "undeliverable@example.test" }),
    });
    expect(queued.status).toBe(201);

    const scriptedEmail = new ScriptedEmailSender([smtpError(550, "550 5.1.1 No such recipient")]);
    const failingWorker = new PostgresEmailWorker({
      database,
      emailSender: scriptedEmail,
      siteAddress: "https://app.example.test",
      tokenIssuer,
      now: () => new Date(now),
    });
    expect(await failingWorker.runOnce()).toBe(true);
    const failedJob = await database
      .selectFrom("email_jobs")
      .select(["attempt_count", "delivered_at", "failed_at"])
      .where("recipient", "=", "undeliverable@example.test")
      .executeTakeFirstOrThrow();
    expect(failedJob.attempt_count).toBe(1);
    expect(failedJob.delivered_at).toBeNull();
    expect(failedJob.failed_at).not.toBeNull();
    expect(scriptedEmail.attempts).toBe(1);

    now = new Date(now.valueOf() + 24 * 60 * 60 * 1_000);
    expect(await failingWorker.runOnce()).toBe(false);
    expect(scriptedEmail.attempts).toBe(1);
  });

  it("rate-limits invalid magic-link consumption by IP without blocking a later valid link", async () => {
    expect((await requestMagicLink("owner@example.test")).status).toBe(202);
    const validToken = linkToken(email.magicLinks.at(-1)!.url, "magicToken")!;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const invalid = await consumeMagicLink(`invalid-token-${attempt}`);
      expect(invalid.status).toBe(400);
    }

    const limited = await consumeMagicLink("invalid-token-limited");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect(await limited.json()).toMatchObject({
      error: { code: "rate_limited" },
    });

    now = new Date(now.valueOf() + 10 * 60 * 1_000);
    const valid = await consumeMagicLink(validToken);
    expect(valid.status).toBe(200);
    expect(parseMagicLinkConsumeResponse(await valid.json()).user.email)
      .toBe("owner@example.test");
  });

  it("keeps a session valid for 30 days after a request inside the persistence interval", async () => {
    const initial = new Date(now);
    const owner = await login("owner@example.test");

    now = new Date(initial.valueOf() + 11 * 60 * 60 * 1_000);
    expect((await app.request("/api/session", {
      headers: { cookie: owner.cookie },
    })).status).toBe(200);

    now = new Date(initial.valueOf() + 30 * 24 * 60 * 60 * 1_000);
    expect((await app.request("/api/session", {
      headers: { cookie: owner.cookie },
    })).status).toBe(200);
    await database.updateTable("sessions")
      .set({ expires_at: new Date(now.valueOf() - 1) })
      .execute();
    expect((await app.request("/api/session", {
      headers: { cookie: owner.cookie },
    })).status).toBe(401);
  });

  it("gives a session stored by the previous release a full 30 days after its next use", async () => {
    const initial = new Date(now);
    const owner = await login("owner@example.test");
    // Previous-release row shape: expiry exactly 30 days after last_seen_at, no slack.
    await database.updateTable("sessions")
      .set({ last_seen_at: initial, expires_at: new Date(initial.valueOf() + 30 * 24 * 60 * 60 * 1_000) })
      .execute();

    now = new Date(initial.valueOf() + 23 * 60 * 60 * 1_000);
    expect((await app.request("/api/session", { headers: { cookie: owner.cookie } })).status).toBe(200);

    // 29 days 13 hours after that last use: still inside the promised 30-day idle window.
    now = new Date(initial.valueOf() + 30 * 24 * 60 * 60 * 1_000 + 12 * 60 * 60 * 1_000);
    expect((await app.request("/api/session", { headers: { cookie: owner.cookie } })).status).toBe(200);
  });

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
        cookie: cookieFrom(known),
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
    const persistedSession = await database
      .selectFrom("sessions")
      .select(["last_seen_at", "expires_at"])
      .executeTakeFirstOrThrow();
    now = new Date("2026-10-10T13:00:00.000Z");
    expect((await app.request("/api/session", { headers: { cookie } })).status).toBe(200);
    const repeatedSession = await database
      .selectFrom("sessions")
      .select(["last_seen_at", "expires_at"])
      .executeTakeFirstOrThrow();
    expect(repeatedSession).toEqual(persistedSession);

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

  it("delivers invite login generically and accepts the linked invitation only on consume", async () => {
    const owner = await login("owner@example.test");
    const trip = (await createTrip(owner.cookie, "linked-invite-trip")).trip;
    const wifeInvite = await invite(
      owner.cookie,
      trip.id,
      "wife@example.test",
      "linked-invite-wife",
    );

    const valid = await requestInviteMagicLink(wifeInvite.token);
    const invalid = await requestInviteMagicLink("not-a-real-invite");
    expect(valid.status).toBe(202);
    expect(invalid.status).toBe(202);
    expect(await valid.clone().json()).toEqual(await invalid.json());
    await emailWorker.runOnce();
    expect(email.magicLinks).toHaveLength(2);
    const firstLink = email.magicLinks.at(-1)!;
    expect(firstLink.to).toBe("wife@example.test");
    expect(linkToken(firstLink.url, "inviteToken")).toBeNull();

    const beforeConsume = await database
      .selectFrom("trip_members")
      .innerJoin("users", "users.id", "trip_members.user_id")
      .select("trip_members.user_id")
      .where("trip_members.trip_id", "=", trip.id)
      .where("users.email", "=", "wife@example.test")
      .where("trip_members.removed_at", "is", null)
      .executeTakeFirst();
    expect(beforeConsume).toBeUndefined();

    expect((await requestInviteMagicLink(wifeInvite.token)).status).toBe(202);
    await emailWorker.runOnce();
    const secondLink = email.magicLinks.at(-1)!;
    const firstToken = linkToken(firstLink.url, "magicToken")!;
    const secondToken = linkToken(secondLink.url, "magicToken")!;

    const firstConsume = await consumeMagicLink(firstToken);
    expect(firstConsume.status).toBe(200);
    expect(parseMagicLinkConsumeResponse(await firstConsume.json())).toMatchObject({
      acceptedTripId: trip.id,
      inviteOutcome: "accepted",
      user: { email: "wife@example.test" },
    });

    const secondConsume = await consumeMagicLink(secondToken);
    expect(secondConsume.status).toBe(200);
    expect(parseMagicLinkConsumeResponse(await secondConsume.json())).toMatchObject({
      acceptedTripId: trip.id,
      inviteOutcome: "already-member",
      user: { email: "wife@example.test" },
    });

    const acceptedTrip = parseTripResponse(
      await (await app.request(`/api/trips/${trip.id}`, {
        headers: { cookie: cookieFrom(secondConsume) },
      })).json(),
    ).trip;
    expect(acceptedTrip.members.filter((member) => member.email === "wife@example.test"))
      .toHaveLength(1);
    expect(acceptedTrip.invites).not.toContainEqual(
      expect.objectContaining({ id: wifeInvite.inviteId, status: "pending" }),
    );

    const deliveredCount = email.magicLinks.length;
    expect((await requestInviteMagicLink(wifeInvite.token)).status).toBe(202);
    expect((await requestInviteMagicLink(wifeInvite.token)).status).toBe(202);
    expect((await requestInviteMagicLink(wifeInvite.token)).status).toBe(202);
    const inviteRateLimited = await requestInviteMagicLink(wifeInvite.token);
    expect(inviteRateLimited.status).toBe(429);
    expect(await inviteRateLimited.json()).toMatchObject({
      error: { code: "rate_limited" },
    });
    await emailWorker.runOnce();
    expect(email.magicLinks).toHaveLength(deliveredCount);

    const expiredInvite = await invite(
      owner.cookie,
      trip.id,
      "expired-race@example.test",
      "linked-invite-expired-race",
    );
    expect((await requestInviteMagicLink(expiredInvite.token)).status).toBe(202);
    await emailWorker.runOnce();
    const expiredMagicToken = linkToken(email.magicLinks.at(-1)!.url, "magicToken")!;
    await database
      .updateTable("invites")
      .set({ expires_at: new Date(now.valueOf() - 1_000) })
      .where("id", "=", expiredInvite.inviteId)
      .execute();
    const expiredConsume = await consumeMagicLink(expiredMagicToken);
    expect(expiredConsume.status).toBe(400);
    expect(await expiredConsume.json()).toMatchObject({ error: { code: "invalid_invite" } });
    expect(await database
      .selectFrom("trip_members")
      .innerJoin("users", "users.id", "trip_members.user_id")
      .select("trip_members.user_id")
      .where("trip_members.trip_id", "=", trip.id)
      .where("users.email", "=", "expired-race@example.test")
      .where("trip_members.removed_at", "is", null)
      .executeTakeFirst()).toBeUndefined();

    const revokedInvite = await invite(
      owner.cookie,
      trip.id,
      "revoked-race@example.test",
      "linked-invite-revoked-race",
    );
    expect((await requestInviteMagicLink(revokedInvite.token)).status).toBe(202);
    await emailWorker.runOnce();
    const revokedMagicToken = linkToken(email.magicLinks.at(-1)!.url, "magicToken")!;
    const revoke = await app.request(
      `/api/trips/${trip.id}/invites/${revokedInvite.inviteId}`,
      {
        method: "DELETE",
        headers: {
          cookie: owner.cookie,
          "idempotency-key": "linked-invite-revoke-race",
          origin: "https://app.example.test",
        },
      },
    );
    expect(revoke.status).toBe(204);
    const revokedConsume = await consumeMagicLink(revokedMagicToken);
    expect(revokedConsume.status).toBe(400);
    expect(await revokedConsume.json()).toMatchObject({ error: { code: "invalid_invite" } });
    expect(await database
      .selectFrom("trip_members")
      .innerJoin("users", "users.id", "trip_members.user_id")
      .select("trip_members.user_id")
      .where("trip_members.trip_id", "=", trip.id)
      .where("users.email", "=", "revoked-race@example.test")
      .where("trip_members.removed_at", "is", null)
      .executeTakeFirst()).toBeUndefined();

    const deliveredAfterRaces = email.magicLinks.length;
    expect((await requestInviteMagicLink(expiredInvite.token)).status).toBe(202);
    expect((await requestInviteMagicLink(revokedInvite.token)).status).toBe(202);
    await emailWorker.runOnce();
    expect(email.magicLinks).toHaveLength(deliveredAfterRaces);
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
      owner.cookie, first.id, joined.email!, "membership-reinvite",
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
        flights: tripFlights("2027-01-01", "2027-01-02"),
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
        flights: tripFlights("2027-01-01", "2027-01-02"),
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
        flights: tripFlights("2027-03-05", "2027-03-07"),
      }),
    });
    expect(second.status).toBe(201);
    expect(parseTripResponse(await second.json()).trip).toMatchObject({
      defaultCurrency: "JPY",
      countryStops: [
        { countryCode: "JP", position: 0, timeZone: "Asia/Tokyo" },
      ],
    });
    // The preceding validation/replay scenarios used today's five creation attempts.
    now = new Date(now.valueOf() + 24 * 60 * 60 * 1_000);
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
        flights: tripFlights("2027-04-10", "2027-04-11", "America/Los_Angeles"),
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
    const ownerWithPendingInvite = parseTripResponse(
      await (await app.request(`/api/trips/${tripId}`, {
        headers: { cookie: owner.cookie },
      })).json(),
    ).trip;
    expect(ownerWithPendingInvite.invites).toContainEqual(
      expect.objectContaining({ id: outsiderInvite.inviteId, email: "outsider@example.test" }),
    );
    const editorWithPendingInvite = parseTripResponse(
      await (await app.request(`/api/trips/${tripId}`, {
        headers: { cookie: editorSessions[0]!.cookie },
      })).json(),
    ).trip;
    expect(editorWithPendingInvite.invites).toEqual([]);
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
      `/api/trips/${tripId.toUpperCase()}/invites/${revokedInvite.inviteId.toUpperCase()}`,
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
