import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { sql, type Kysely } from "kysely";
import { parseTripResponse } from "@along-the-way/contracts/private-trips";
import {
  parseTripPlaceMustItemListResponse,
  parseTripPlaceMustItemResponse,
  parseTripPlaceResponse,
  type MustItemKind,
  type TripPlaceDto,
  type TripPlaceMustItemDto,
} from "@along-the-way/contracts/trip-places";

import { createApp } from "../src/app";
import { createDatabase, type AlongTheWayDatabase } from "../src/database/database";
import { runMigrations } from "../src/database/migrate";
import {
  down as downgradePermissions,
  up as upgradePermissions,
} from "../src/database/migrations/030_permission_hardening";
import { PostgresPlaceDetailModule } from "../src/place-details/postgres-place-detail-module";
import { packagedPhotoRoot } from "../src/place-details/photo-assets";
import { PostgresCollaborationModule } from "../src/private-trips/postgres-collaboration-module";
import { replayed } from "../src/private-trips/postgres-private-trip-store";
import { PostgresIdentityAccessModule } from "../src/private-trips/postgres-identity-access-module";
import { PostgresRateLimiter } from "../src/private-trips/postgres-rate-limiter";
import { PostgresRapidApiKeysModule } from "../src/private-trips/postgres-rapidapi-keys-module";
import { RapidApiKeyCipher } from "../src/private-trips/rapidapi-key-cipher";
import { PostgresReadinessProbe } from "../src/private-trips/postgres-readiness-probe";
import { PostgresTripWorkspaceModule } from "../src/private-trips/postgres-trip-workspace-module";
import { hashToken, TokenIssuer } from "../src/private-trips/token-issuer";
import { PostgresTripSkeletonModule } from "../src/trip-skeleton/postgres-trip-skeleton-module";
import type { PlaceProvider } from "../src/trip-places/google-places-provider";
import { PostgresTripPlaceModule } from "../src/trip-places/postgres-trip-place-module";
import { unrelatedDayPlanModule } from "./day-plan-test-support";
import { unrelatedDiscoveryModule } from "./discovery-test-support";
import { tripFlights } from "./travel-test-support";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required; use an isolated verification database");
const now = () => new Date("2026-10-14T12:00:00.000Z");
const origin = "https://app.example.test";

interface Actor {
  id: string;
  cookie: string;
}

describe("trip-place must-items through HTTP and PostgreSQL", () => {
  let database: Kysely<AlongTheWayDatabase>;
  let app: Hono;
  let owner: Actor;
  let tripId: string;
  let place: TripPlaceDto;
  const createdTripIds: string[] = [];
  const createdUserIds: string[] = [];
  const createdPlaceIdentityIds: string[] = [];

  beforeAll(async () => {
    database = createDatabase(databaseUrl);
    await runMigrations(database);
  });

  beforeEach(async () => {
    const provider: PlaceProvider = {
      available: true,
      attribution: "Controlled test provider",
      async search() { return []; },
      async getPlace(providerPlaceId) {
        return {
          provider: "google",
          providerPlaceId,
          name: "Controlled shared place",
          type: "restaurant",
          typeLabel: null,
          address: "Kyoto",
          latitude: 35,
          longitude: 135,
          timeZone: "Asia/Tokyo",
          sourceUrl: `https://maps.google.com/?place_id=${providerPlaceId}`,
          attribution: "Controlled test provider",
          observedAt: "2026-10-14T12:00:00.000Z",
          expiresAt: "2026-11-14T12:00:00.000Z",
          photo: null,
        };
      },
      async getPhotos() { return []; },
    };
    const tripPlaces = new PostgresTripPlaceModule({ database, provider, now });
    app = createApp({
      rapidApiKeys: new PostgresRapidApiKeysModule(database, new RapidApiKeyCipher(Buffer.alloc(32, 7).toString("base64"))),
      collaboration: new PostgresCollaborationModule(database),
      dayPlans: unrelatedDayPlanModule,
      discovery: unrelatedDiscoveryModule,
      identityAccess: new PostgresIdentityAccessModule({
        database,
        now,
        tokenIssuer: new TokenIssuer("must-items-integration-secret-at-least-32-bytes"),
      }),
      placeDetails: new PostgresPlaceDetailModule({ database, assetRoot: packagedPhotoRoot }),
      rateLimiter: new PostgresRateLimiter(database, "must-items-rate-secret-at-least-32-bytes", now),
      readiness: new PostgresReadinessProbe(database, now),
      siteAddress: origin,
      tripWorkspace: new PostgresTripWorkspaceModule({ database, now }),
      tripSkeleton: new PostgresTripSkeletonModule({ database, now }),
      tripPlaces,
    });
    owner = await createActor("owner");
    tripId = await createTrip(owner.cookie);
    place = await addPlace(owner.cookie, tripId, "Must-item test place");
  });

  afterEach(async () => {
    if (createdTripIds.length) {
      await database.deleteFrom("itinerary_items").where("trip_id", "in", createdTripIds).execute();
      await database.deleteFrom("trips").where("id", "in", createdTripIds.splice(0)).execute();
    }
    if (createdPlaceIdentityIds.length) {
      await database.deleteFrom("place_identities")
        .where("id", "in", createdPlaceIdentityIds.splice(0))
        .execute();
    }
    if (createdUserIds.length) {
      await database.deleteFrom("users").where("id", "in", createdUserIds.splice(0)).execute();
    }
  });

  afterAll(async () => {
    await database.destroy();
  });

  async function createActor(label: string): Promise<Actor> {
    const token = randomUUID();
    const user = await database.insertInto("users").values({
      email: `${label}-${token}@example.test`,
      display_name: label,
      status: "active",
    }).returning("id").executeTakeFirstOrThrow();
    createdUserIds.push(user.id);
    await database.insertInto("sessions").values({
      user_id: user.id,
      token_hash: hashToken(token),
      expires_at: "2026-11-01T00:00:00Z",
      last_seen_at: now(),
      revoked_at: null,
    }).execute();
    return { id: user.id, cookie: `__Host-along_the_way_session=${token}` };
  }

  async function createTrip(cookie: string) {
    const response = await app.request("/api/trips", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
        origin,
      },
      body: JSON.stringify({
        name: `Must-item test ${randomUUID()}`,
        startDate: "2026-10-20",
        endDate: "2026-10-22",
        countryCodes: ["JP"],
        flights: tripFlights("2026-10-20", "2026-10-22", "Asia/Tokyo"),
      }),
    });
    expect(response.status).toBe(201);
    const id = parseTripResponse(await response.json()).trip.id;
    createdTripIds.push(id);
    return id;
  }

  async function addPlace(cookie: string, targetTripId: string, name: string) {
    const response = await app.request(`/api/trips/${targetTripId}/trip-places`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
        origin,
      },
      body: JSON.stringify({
        method: "manual",
        name,
        type: "restaurant",
        address: "Kyoto",
        latitude: 35,
        longitude: 135,
        timeZone: "Asia/Tokyo",
      }),
    });
    expect(response.status).toBe(201);
    const created = parseTripPlaceResponse(await response.json()).tripPlace;
    createdPlaceIdentityIds.push(created.placeId);
    return created;
  }

  async function addProviderPlace(cookie: string, targetTripId: string, providerPlaceId: string) {
    const response = await app.request(`/api/trips/${targetTripId}/trip-places`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
        origin,
      },
      body: JSON.stringify({ method: "search", providerPlaceId }),
    });
    expect(response.status).toBe(201);
    const created = parseTripPlaceResponse(await response.json()).tripPlace;
    createdPlaceIdentityIds.push(created.placeId);
    return created;
  }

  async function addEditor(targetTripId: string, actor: Actor) {
    await database.insertInto("trip_members").values({
      trip_id: targetTripId,
      user_id: actor.id,
      role: "editor",
      removed_at: null,
    }).execute();
  }

  function mustItemsRequest(
    actor: Actor,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path = "",
    body?: unknown,
    key: string = randomUUID(),
    targetPlace = place,
    targetTripId = tripId,
  ) {
    return app.request(`/api/trips/${targetTripId}/trip-places/${targetPlace.id}/must-items${path}`, {
      method,
      headers: {
        cookie: actor.cookie,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(method === "GET" ? {} : { "idempotency-key": key, origin }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function createMustItem(
    actor: Actor,
    kind: MustItemKind,
    label: string,
    targetPlace = place,
    key: string = randomUUID(),
  ): Promise<{ response: Response; item: TripPlaceMustItemDto | null }> {
    const response = await mustItemsRequest(actor, "POST", "", { kind, label }, key, targetPlace);
    const item = response.status === 201
      ? parseTripPlaceMustItemResponse(await response.json()).item
      : null;
    return { response, item };
  }

  it("creates, lists, updates and removes a must-item while recording collaboration events", async () => {
    const created = await mustItemsRequest(owner, "POST", "", { kind: "eat", label: "  湯豆腐  " });
    expect(created.status).toBe(201);
    const createdItem = parseTripPlaceMustItemResponse(await created.json()).item;
    expect(createdItem).toMatchObject({ kind: "eat", label: "湯豆腐", version: 1 });

    const listed = await mustItemsRequest(owner, "GET");
    expect(listed.status).toBe(200);
    expect(parseTripPlaceMustItemListResponse(await listed.json()).items).toEqual([createdItem]);

    const updated = await mustItemsRequest(owner, "PATCH", `/${createdItem.id}`, {
      kind: "buy",
      label: "宇治茶",
      expectedVersion: 1,
    });
    expect(updated.status).toBe(200);
    const updatedItem = parseTripPlaceMustItemResponse(await updated.json()).item;
    expect(updatedItem).toMatchObject({
      id: createdItem.id,
      kind: "buy",
      label: "宇治茶",
      version: 2,
    });

    const removed = await mustItemsRequest(owner, "DELETE", `/${createdItem.id}`, {
      expectedVersion: 2,
    });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ removed: true });
    expect(parseTripPlaceMustItemListResponse(
      await (await mustItemsRequest(owner, "GET")).json(),
    ).items).toEqual([]);
    const events = await database.selectFrom("change_events")
      .select("event_type")
      .where("trip_id", "=", tripId)
      .where("event_type", "like", "trip_place.must_item_%")
      .orderBy("event_order")
      .execute();
    expect(events.map(({ event_type }) => event_type)).toEqual([
      "trip_place.must_item_created",
      "trip_place.must_item_updated",
      "trip_place.must_item_removed",
    ]);
  });

  it("copies pre-deploy replay keys for both binaries without allowing cross-trip replay", async () => {
    const key = "legacy-must-item-replay";
    const created = await createMustItem(owner, "eat", "Legacy noodles", place, key);
    expect(created.response.status).toBe(201);
    const original = created.item!;
    const currentOperation = `tmc:${tripId}:${place.id}`;
    const legacyOperation = `tp:must:create:${place.id}`;

    await sql`
      insert into mutation_requests (actor_id, operation, idempotency_key, response, created_at)
      select actor_id, ${legacyOperation}, idempotency_key, response, created_at
      from mutation_requests
      where actor_id = ${owner.id}
        and operation = ${currentOperation}
        and idempotency_key = ${key}
    `.execute(database);
    await database.deleteFrom("mutation_requests")
      .where("actor_id", "=", owner.id)
      .where("operation", "=", currentOperation)
      .where("idempotency_key", "=", key)
      .execute();
    await database.updateTable("trip_place_must_items")
      .set({ label: "Changed after first response" })
      .where("id", "=", original.id)
      .execute();

    await upgradePermissions(database);
    expect((await database.selectFrom("mutation_requests").select("operation")
      .where("actor_id", "=", owner.id)
      .where("idempotency_key", "=", key)
      .orderBy("operation")
      .execute()).map((row) => row.operation)).toEqual([
      currentOperation,
      legacyOperation,
    ]);
    expect(await replayed(database, owner.id, legacyOperation, key)).toEqual(original);

    const replay = await createMustItem(owner, "eat", "Legacy noodles", place, key);
    expect(replay.response.status).toBe(201);
    expect(replay.item).toEqual(original);
    expect(await database.selectFrom("trip_place_must_items")
      .select("id")
      .where("trip_place_id", "=", place.id)
      .execute()).toHaveLength(1);

    const otherTripId = await createTrip(owner.cookie);
    const crossTrip = await mustItemsRequest(
      owner,
      "POST",
      "",
      { kind: "eat", label: "Legacy noodles" },
      key,
      place,
      otherTripId,
    );
    expect(crossTrip.status).toBe(404);

    await downgradePermissions(database);
    expect((await database.selectFrom("mutation_requests").select("operation")
      .where("actor_id", "=", owner.id)
      .where("idempotency_key", "=", key)
      .execute()).map((row) => row.operation)).toEqual([legacyOperation]);
    await upgradePermissions(database);
  });

  it("lets editors write while denying non-members", async () => {
    const editor = await createActor("editor");
    const outsider = await createActor("outsider");
    await addEditor(tripId, editor);

    const created = await createMustItem(editor, "drink", "抹茶");
    expect(created.response.status).toBe(201);
    const item = created.item!;
    const updated = await mustItemsRequest(editor, "PATCH", `/${item.id}`, {
      kind: "eat",
      label: "蕨餅",
      expectedVersion: item.version,
    });
    expect(updated.status).toBe(200);
    const updatedItem = parseTripPlaceMustItemResponse(await updated.json()).item;
    const removed = await mustItemsRequest(editor, "DELETE", `/${item.id}`, {
      expectedVersion: updatedItem.version,
    });
    expect(removed.status).toBe(200);

    const outsiderRead = await mustItemsRequest(outsider, "GET");
    expect(outsiderRead.status).toBe(404);
    expect(await outsiderRead.json()).toMatchObject({ error: { code: "trip_not_found" } });
    const outsiderWrite = await createMustItem(outsider, "buy", "Forbidden");
    expect(outsiderWrite.response.status).toBe(404);
    expect(await outsiderWrite.response.json()).toMatchObject({
      error: { code: "trip_not_found" },
    });
  });

  it("validates kind and the trimmed 1-to-80-character label boundary", async () => {
    const cases = [
      { kind: "see", label: "Temple" },
      { kind: "buy", label: "   " },
      { kind: "eat", label: "x".repeat(81) },
    ];
    for (const input of cases) {
      const response = await mustItemsRequest(owner, "POST", "", input);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "validation_error" } });
    }
    const boundary = await createMustItem(owner, "buy", "界".repeat(80));
    expect(boundary.response.status).toBe(201);
    expect(boundary.item?.label).toHaveLength(80);
  });

  it("rejects normalized duplicates and lists buy, eat and drink groups in order", async () => {
    expect((await createMustItem(owner, "drink", "Water")).response.status).toBe(201);
    expect((await createMustItem(owner, "eat", "Tofu")).response.status).toBe(201);
    expect((await createMustItem(owner, "buy", "Matcha   Latte")).response.status).toBe(201);
    const duplicate = await createMustItem(owner, "buy", "  ＭＡＴＣＨＡ latte ");
    expect(duplicate.response.status).toBe(409);
    expect(await duplicate.response.json()).toMatchObject({
      error: { code: "must_item_duplicate" },
    });
    const listed = parseTripPlaceMustItemListResponse(
      await (await mustItemsRequest(owner, "GET")).json(),
    ).items;
    expect(listed.map((item) => item.kind)).toEqual(["buy", "eat", "drink"]);
  });

  it("caps each active place at 24 must-items", async () => {
    for (let index = 1; index <= 24; index++) {
      const created = await createMustItem(owner, "buy", `Item ${index}`);
      expect(created.response.status).toBe(201);
    }
    const excess = await createMustItem(owner, "eat", "Item 25");
    expect(excess.response.status).toBe(409);
    expect(await excess.response.json()).toMatchObject({
      error: { code: "must_item_limit" },
    });
  });

  it("surfaces a stale expected version as conflict HTTP 409", async () => {
    const created = (await createMustItem(owner, "buy", "Original")).item!;
    const changed = await mustItemsRequest(owner, "PATCH", `/${created.id}`, {
      kind: "eat",
      label: "Changed",
      expectedVersion: 1,
    });
    expect(changed.status).toBe(200);
    const stale = await mustItemsRequest(owner, "PATCH", `/${created.id}`, {
      kind: "drink",
      label: "Stale",
      expectedVersion: 1,
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: { code: "conflict", currentVersion: 2 },
    });
  });

  it("serializes concurrent 24th and 25th items and same-label creation by two members", async () => {
    const editor = await createActor("concurrent-editor");
    await addEditor(tripId, editor);
    for (let index = 1; index <= 23; index++) {
      expect((await createMustItem(owner, "buy", `Existing ${index}`)).response.status)
        .toBe(201);
    }
    const atLimit = await Promise.all([
      createMustItem(owner, "eat", "Owner final item"),
      createMustItem(editor, "drink", "Editor final item"),
    ]);
    expect(atLimit.map(({ response }) => response.status).sort()).toEqual([201, 409]);
    const limitFailure = atLimit.find(({ response }) => response.status === 409)!.response;
    expect(await limitFailure.json()).toMatchObject({ error: { code: "must_item_limit" } });
    expect(parseTripPlaceMustItemListResponse(
      await (await mustItemsRequest(owner, "GET")).json(),
    ).items).toHaveLength(24);

    const duplicatePlace = await addPlace(owner.cookie, tripId, "Concurrent duplicate place");
    const sameLabel = await Promise.all([
      createMustItem(owner, "buy", "  Matcha Set ", duplicatePlace),
      createMustItem(editor, "buy", "ＭＡＴＣＨＡ   set", duplicatePlace),
    ]);
    expect(sameLabel.map(({ response }) => response.status).sort()).toEqual([201, 409]);
    const duplicateFailure = sameLabel.find(({ response }) => response.status === 409)!.response;
    expect(await duplicateFailure.json()).toMatchObject({
      error: { code: "must_item_duplicate" },
    });
  });

  it("deletes must-items when a wishlist place is removed and does not restore them on re-add", async () => {
    const providerPlaceId = `controlled-${randomUUID()}`;
    const sharedPlace = await addProviderPlace(owner.cookie, tripId, providerPlaceId);
    expect((await createMustItem(owner, "eat", "Old item", sharedPlace)).response.status)
      .toBe(201);
    const removed = await app.request(
      `/api/trips/${tripId}/trip-places/${sharedPlace.id}/remove`,
      {
        method: "POST",
        headers: {
          cookie: owner.cookie,
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
          origin,
        },
        body: JSON.stringify({ expectedVersion: sharedPlace.version }),
      },
    );
    expect(removed.status).toBe(204);
    const readded = await addProviderPlace(owner.cookie, tripId, providerPlaceId);
    const listed = await mustItemsRequest(owner, "GET", "", undefined, randomUUID(), readded);
    expect(listed.status).toBe(200);
    expect(parseTripPlaceMustItemListResponse(await listed.json()).items).toEqual([]);
  });

  it("moves source must-items into the merge target and removes normalized duplicates", async () => {
    const source = await addPlace(owner.cookie, tripId, "Merge source");
    const target = await addPlace(owner.cookie, tripId, "Merge target");
    expect((await createMustItem(owner, "buy", "MATCHA set", target)).response.status)
      .toBe(201);
    expect((await createMustItem(owner, "buy", "Ｍａｔｃｈａ   set", source)).response.status)
      .toBe(201);
    expect((await createMustItem(owner, "drink", "Roasted tea", source)).response.status)
      .toBe(201);
    const merged = await app.request(
      `/api/trips/${tripId}/trip-places/${source.id}/merge`,
      {
        method: "POST",
        headers: {
          cookie: owner.cookie,
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
          origin,
        },
        body: JSON.stringify({
          targetTripPlaceId: target.id,
          expectedSourceVersion: source.version,
          expectedTargetVersion: target.version,
        }),
      },
    );
    expect(merged.status).toBe(200);
    const listed = parseTripPlaceMustItemListResponse(
      await (await mustItemsRequest(owner, "GET", "", undefined, randomUUID(), target)).json(),
    ).items;
    expect(listed.map(({ kind, label, tripPlaceId }) => ({ kind, label, tripPlaceId })))
      .toEqual([
        { kind: "buy", label: "MATCHA set", tripPlaceId: target.id },
        { kind: "drink", label: "Roasted tea", tripPlaceId: target.id },
      ]);
  });

  it("replays a create idempotency key without applying a different payload twice", async () => {
    const key = randomUUID();
    const first = await createMustItem(owner, "buy", "First payload", place, key);
    expect(first.response.status).toBe(201);
    const replay = await createMustItem(owner, "drink", "Ignored payload", place, key);
    expect(replay.response.status).toBe(201);
    expect(replay.item).toEqual(first.item);
    expect(parseTripPlaceMustItemListResponse(
      await (await mustItemsRequest(owner, "GET")).json(),
    ).items).toEqual([first.item]);
    const events = await database.selectFrom("change_events")
      .select("id")
      .where("trip_id", "=", tripId)
      .where("event_type", "=", "trip_place.must_item_created")
      .execute();
    expect(events).toHaveLength(1);
  });

  it("keeps duration, budget and currency when saving a reason with their round-tripped values", async () => {
    const savePlanning = (
      expectedVersion: number,
      key: string,
      notes: string,
      durationMinutes: number,
      budgetAmountMinor: number,
      budgetCurrency: string,
    ) => app.request(`/api/trips/${tripId}/trip-places/${place.id}/planning`, {
      method: "PATCH",
      headers: {
        cookie: owner.cookie,
        "content-type": "application/json",
        "idempotency-key": key,
        origin,
      },
      body: JSON.stringify({
        expectedVersion,
        notes,
        durationMinutes,
        budgetAmountMinor,
        budgetCurrency,
      }),
    });
    const initial = await savePlanning(place.version, randomUUID(), "Initial reason", 90, 2500, "JPY");
    expect(initial.status).toBe(200);
    const withPlanning = parseTripPlaceResponse(await initial.json()).tripPlace;
    // The endpoint treats omitted planning fields as null, so the reason-saving caller must
    // round-trip the existing values. This test protects that exact server/client contract.
    const reasonSaved = await savePlanning(
      withPlanning.version,
      randomUUID(),
      "Updated reason",
      withPlanning.durationMinutes!,
      withPlanning.budgetAmountMinor!,
      withPlanning.budgetCurrency!,
    );
    expect(reasonSaved.status).toBe(200);
    expect(parseTripPlaceResponse(await reasonSaved.json()).tripPlace).toMatchObject({
      notes: "Updated reason",
      durationMinutes: 90,
      budgetAmountMinor: 2500,
      budgetCurrency: "JPY",
    });
  });
});
