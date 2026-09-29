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
import { parseTripResponse } from "@along-the-way/contracts/private-trips";
import {
  parsePlaceResponse,
  parseTripSkeletonResponse,
} from "@along-the-way/contracts/trip-skeleton";

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
import { hashToken, TokenIssuer } from "../src/private-trips/token-issuer";
import { PostgresTripSkeletonModule } from "../src/trip-skeleton/postgres-trip-skeleton-module";
import {
  ProviderUnavailableError,
  type PlaceProvider,
} from "../src/trip-places/google-places-provider";
import { PostgresTripPlaceModule } from "../src/trip-places/postgres-trip-place-module";

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
  const now = () => new Date("2026-09-28T12:00:00.000Z");

  beforeAll(async () => {
    database = createDatabase(databaseUrl);
    await runMigrations(database);
  });

  beforeEach(async () => {
    await sql`
      truncate table
        trip_place_duplicate_suggestions,
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
    app = createApp({
      identityAccess,
      rateLimiter: new PostgresRateLimiter(
        database,
        "trip-place-rate-secret-at-least-32-bytes",
        now,
      ),
      readiness: new PostgresReadinessProbe(database, now),
      siteAddress: "https://app.example.test",
      tripPlaces: new PostgresTripPlaceModule({
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
      }),
      tripSkeleton: new PostgresTripSkeletonModule({ database, now }),
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

  it("flags uncertain duplicates, enforces planning day scope, and merges only with current versions", async () => {
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

    const invalidPlanning = await app.request(
      `/api/trips/${trip.id}/trip-places/${first.id}/planning`,
      {
        method: "PATCH",
        headers: {
          cookie: owner.cookie,
          "content-type": "application/json",
          "idempotency-key": "cross-trip-day",
          origin: "https://app.example.test",
        },
        body: json({
          expectedVersion: first.version,
          durationMinutes: null,
          desiredDayIds: [otherTrip.days[0]!.id],
          excludedDayIds: [],
          budgetAmountMinor: null,
          budgetCurrency: null,
          notes: null,
        }),
      },
    );
    expect(invalidPlanning.status).toBe(400);

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
      desiredDayIds: string[],
      excludedDayIds: string[],
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
            desiredDayIds,
            excludedDayIds,
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
      "exclude-merge-day",
      [],
      [trip.days[0]!.id],
      "Source planning note",
    );
    const plannedTarget = await planning(
      beforePlanning.find((entry) => entry.id === first.id)!,
      "desire-merge-day",
      [trip.days[0]!.id],
      [],
      "Target planning note",
    );
    const conflictingMerge = await app.request(
      `/api/trips/${trip.id}/trip-places/${plannedSource.id}/merge`,
      {
        method: "POST",
        headers: {
          cookie: owner.cookie,
          "content-type": "application/json",
          "idempotency-key": "conflicting-day-merge",
          origin: "https://app.example.test",
        },
        body: json({
          targetTripPlaceId: plannedTarget.id,
          expectedSourceVersion: plannedSource.version,
          expectedTargetVersion: plannedTarget.version,
        }),
      },
    );
    expect(conflictingMerge.status).toBe(409);
    const afterConflict = await list(owner.cookie, trip.id);
    expect(afterConflict).toHaveLength(2);
    expect(afterConflict.find((entry) => entry.id === plannedSource.id)?.excludedDayIds)
      .toEqual([trip.days[0]!.id]);
    await planning(plannedSource, "clear-excluded-merge-day", [], [], "Source planning note");

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
    expect(await list(owner.cookie, trip.id)).toHaveLength(1);

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
            desiredDayIds: [],
            excludedDayIds: [],
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
          desiredDayIds: [],
          excludedDayIds: [],
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
