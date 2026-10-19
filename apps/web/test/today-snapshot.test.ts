// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { TodaySnapshotStore } from "../src/today-snapshot";
import { createTodayModel, type TodayModel } from "../src/today-model";
import type { TripDto } from "@along-the-way/contracts/private-trips";
import type { TripSkeletonDto } from "@along-the-way/contracts/trip-skeleton";
import { todayActivity, todaySkeleton, todayTrip, todayUser, todayWishlist } from "./today-fixtures";

const model: TodayModel = { tripId: "trip", tripName: "Private trip", tripVersion: 7, memberId: "member", items: [], days: [{ id: "day", date: "2026-10-21", timeZone: "Asia/Tokyo", itemIds: [], wishlist: [] }] };
const key = "along-the-way:today:account:trip";

const legacyV2 = {
  schemaVersion: 2,
  accountId: "account",
  fetchedAt: "2026-10-21T02:30:00.000Z",
  model: {
    tripId: "trip",
    tripName: "V2 trip",
    tripVersion: 2,
    memberId: "member",
    days: [{
      id: "day",
      date: "2026-10-21",
      timeZone: "Asia/Tokyo",
      itemIds: ["legacy-v2"],
      wishlist: [{ id: "wish-v2", name: "V2 wishlist place" }],
    }],
    items: [{
      id: "legacy-v2",
      title: "V2 transport",
      type: "transport",
      start: "2026-10-21T01:00:00Z",
      end: "2026-10-21T02:00:00Z",
      endpoints: [{
        role: "start",
        instant: "2026-10-21T01:00:00Z",
        timeZone: "Asia/Tokyo",
        place: { name: "V2 station", address: null, latitude: 35, longitude: 139 },
      }],
      participants: [{ id: "member", name: "V2 traveler" }],
      locked: false,
      constraints: [],
      facts: [],
      notes: null,
      sourceUrl: null,
    }],
  },
};

const legacyV3 = {
  schemaVersion: 3,
  accountId: "account",
  fetchedAt: "2026-10-21T02:30:00.000Z",
  model: {
    tripId: "trip",
    tripName: "V3 trip",
    tripVersion: 3,
    memberId: "member",
    days: [{
      id: "day",
      date: "2026-10-21",
      timeZone: "Asia/Tokyo",
      itemIds: ["legacy-v3"],
      wishlist: [{ id: "wish-v3", name: "V3 wishlist place" }],
    }],
    items: [{
      id: "legacy-v3",
      title: "V3 transport",
      type: "transport",
      start: "2026-10-21T01:00:00Z",
      end: "2026-10-21T02:00:00Z",
      endpoints: [{
        role: "start",
        instant: "2026-10-21T01:00:00Z",
        timeZone: "Asia/Tokyo",
        place: { id: "station-v3", name: "V3 station", address: null, latitude: 35, longitude: 139 },
      }],
      participants: [{ id: "member", name: "V3 traveler" }],
      locked: false,
      constraints: [],
      facts: [],
      notes: null,
      sourceUrl: null,
    }],
  },
};

const legacyV4 = {
  schemaVersion: 4,
  accountId: "account",
  fetchedAt: "2026-10-21T02:30:00.000Z",
  model: {
    tripId: "trip",
    tripName: "V4 trip",
    tripVersion: 4,
    memberId: "member",
    days: [{
      id: "day",
      date: "2026-10-21",
      timeZone: "Asia/Tokyo",
      itemIds: ["legacy-v4"],
      wishlist: [{ id: "wish-v4", name: "V4 wishlist place" }],
    }],
    items: [{
      id: "legacy-v4",
      title: "V4 transport",
      type: "transport",
      start: "2026-10-21T01:00:00Z",
      end: "2026-10-21T02:00:00Z",
      endpoints: [{
        role: "start",
        instant: "2026-10-21T01:00:00Z",
        timeZone: "Asia/Tokyo",
        place: { id: "station-v4", name: "V4 station", address: null, latitude: 35, longitude: 139 },
      }],
      participants: [{ id: "former-member", name: "V4 former traveler", removed: true }],
      locked: false,
      constraints: [],
      facts: [],
      notes: null,
      sourceUrl: null,
    }],
  },
};

const legacyV5 = {
  ...legacyV4,
  schemaVersion: 5,
  model: {
    ...legacyV4.model,
    tripName: "V5 trip",
    tripVersion: 5,
    days: [{
      ...legacyV4.model.days[0]!,
      itemIds: ["legacy-v5"],
      wishlist: [{ id: "wish-v5", name: "V5 wishlist place", latitude: 35, longitude: 139, providerPlaceId: "google-v5" }],
    }],
    items: [{
      ...legacyV4.model.items[0]!,
      id: "legacy-v5",
      title: "V5 transport",
      endpoints: [{
        ...legacyV4.model.items[0]!.endpoints[0]!,
        place: { id: "station-v5", name: "V5 station", address: null, latitude: 35, longitude: 139 },
      }],
    }],
  },
};

describe("account-scoped read-only Today snapshots", () => {
  beforeEach(() => localStorage.clear());
  it("reopens the last successful formal version through a fresh store while offline", () => {
    const store = new TodaySnapshotStore(localStorage);
    store.save("account", model, Date.parse("2026-10-21T02:30Z"));
    const reopened = new TodaySnapshotStore(localStorage);
    expect(reopened.read("account", "trip")).toMatchObject({ schemaVersion: 6, fetchedAt: "2026-10-21T02:30:00.000Z", model: { tripVersion: 7, days: [{ timeZone: "Asia/Tokyo" }] } });
    expect(reopened.read("other-account", "trip")).toBeNull();
    expect(reopened.lastAccount()).toBe("account");
    store.save("account", { ...model, tripVersion: 8 });
    expect(reopened.read("account", "trip")?.model.tripVersion).toBe(8);
  });
  it("drops snapshots at the earlier of fourteen days after fetch and seven full days after the trip ends", () => {
    const store = new TodaySnapshotStore(localStorage);
    const fetchedAt = Date.parse("2026-10-01T12:00:00Z");
    store.save("account", model, fetchedAt);

    expect(store.read("account", "trip", Date.parse("2026-10-15T12:00:00Z"))).not.toBeNull();
    expect(store.read("account", "trip", Date.parse("2026-10-15T12:00:00.001Z"))).toBeNull();
    expect(localStorage.getItem(key)).toBeNull();

    store.save("account", model, Date.parse("2026-10-20T12:00:00Z"));
    expect(store.read("account", "trip", Date.parse("2026-10-29T00:00:00Z"))).toBeNull();
    expect(localStorage.getItem(key)).toBeNull();
  });
  it("clears one trip on denied access and all account snapshots on logout, not another account's", () => {
    const store = new TodaySnapshotStore(localStorage);
    store.save("other", model);
    store.save("account", model);
    store.save("account", { ...model, tripId: "second" });
    store.clearTrip("account", "trip");
    expect(store.read("account", "trip")).toBeNull();
    expect(store.forAccount("account").map((snapshot) => snapshot.model.tripId)).toEqual(["second"]);
    store.clearAccount("account");
    expect(store.forAccount("account")).toEqual([]);
    expect(store.read("other", "trip")?.model.tripName).toBe("Private trip");
    expect(store.lastAccount()).toBeNull();
  });
  it("clears every account-scoped Along the Way key without deleting another account or the signed-out marker", () => {
    const store = new TodaySnapshotStore(localStorage);
    store.save("account", model);
    localStorage.setItem("along-the-way:place-filters:account:trip:wishlist", "{\"query\":\"secret\"}");
    localStorage.setItem("along-the-way:trip-onboarding:account:trip", "dismissed");
    localStorage.setItem("along-the-way:place-filters:other:trip:wishlist", "{\"query\":\"keep\"}");
    localStorage.setItem("along-the-way:locally-signed-out", "true");

    store.clearAccount("account");

    expect([...Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))]
      .filter((entry): entry is string => entry !== null && entry.includes(":account:"))).toEqual([]);
    expect(localStorage.getItem("along-the-way:place-filters:other:trip:wishlist")).toBe("{\"query\":\"keep\"}");
    expect(localStorage.getItem("along-the-way:locally-signed-out")).toBe("true");
  });
  it("discards incompatible, corrupt, wrong-account and extra-field snapshots", () => {
    const store = new TodaySnapshotStore(localStorage);
    const valid = store.save("account", model)!;
    for (const invalid of [{ ...valid, schemaVersion: 1 }, { ...valid, accountId: "other" }, { ...valid, token: "secret" }, { ...valid, model: { ...model, days: [{ ...model.days[0], timeZone: "not/a-zone" }] } }]) {
      localStorage.setItem(key, JSON.stringify(invalid));
      expect(store.read("account", "trip")).toBeNull();
      expect(localStorage.getItem(key)).toBeNull();
    }
    localStorage.setItem(key, "{broken");
    expect(store.read("account", "trip")).toBeNull();
  });
  it("persists only the allowlisted Today read model, not private API metadata or drafts", () => {
    const trip: TripDto = { id: "trip", name: "Trip", startDate: "2026-10-21", endDate: "2026-10-21", defaultCurrency: "JPY", countryStops: [{ id: "stop", countryCode: "JP", position: 0, timeZone: "Asia/Tokyo" }], days: [{ id: "day", date: "2026-10-21", title: null }], members: [{ id: "member", userId: "account", email: "private@example.test", displayName: "甲", role: "owner" }], invites: [{ id: "invite", email: "invite@example.test", role: "editor", status: "pending", expiresAt: "2026-12-01" }], memberCount: 1, dayCount: 1, role: "owner", version: 7, editorsCanSchedule: false };
    const skeleton: TripSkeletonDto = { tripVersion: 7, places: [], days: [{ id: "day", date: "2026-10-21", title: null, note: null, detailsVersion: 1, alternativeTripPlaceIds: [], alternativesVersion: 1, entries: [] }], items: [] };
    const enriched = Object.assign(skeleton, { draft: "unaccepted suggestion", token: "session secret", providerKey: "key", healthNotes: "private health" });
    const readModel = createTodayModel(trip, enriched, [], "account");
    const store = new TodaySnapshotStore(localStorage);
    store.save("account", readModel);
    const raw = localStorage.getItem(key)!;
    for (const forbidden of ["private@example", "invite@example", "draft", "token", "providerKey", "healthNotes", "unsaved", "members", "invites"]) expect(raw).not.toContain(forbidden);
    expect(JSON.parse(raw).model.days[0].timeZone).toBe("Asia/Tokyo");
    expect(store.save("account", Object.assign({}, readModel, { token: "not allowed" }))).toBeNull();
  });
  it("stores recognizable participant labels without unused member profile emails", () => {
    const trip = todayTrip();
    trip.members.push({ id: "unused", userId: "unused-account", displayName: null, email: "unused@example.test", role: "editor" });
    const item = todayActivity();
    item.participants!.push({ memberId: "named", displayName: "旅伴", email: "hidden-name@example.test", removed: true });
    const readModel = createTodayModel(trip, todaySkeleton(trip, [item]), [], todayUser.id);
    const store = new TodaySnapshotStore(localStorage);
    store.save(todayUser.id, readModel);
    const saved = store.read(todayUser.id, trip.id)!;
    expect(saved.model.items[0]!.participants).toEqual([{ id: "member", name: todayUser.email, removed: false }, { id: "named", name: "旅伴", removed: true }]);
    expect(JSON.stringify(saved)).not.toContain("unused@example.test");
    expect(JSON.stringify(saved)).not.toContain("hidden-name@example.test");
  });
  it("keeps only reference IDs needed to reopen Today place details", () => {
    const trip = todayTrip();
    const readModel = createTodayModel(trip, todaySkeleton(trip, [todayActivity()]), todayWishlist(), todayUser.id);
    const store = new TodaySnapshotStore(localStorage);
    const saved = store.save(todayUser.id, readModel);

    expect(saved?.model.items[0]!.endpoints[0]!.place?.id).toBe("place");

    const incompatible = structuredClone(saved!);
    delete (incompatible.model.items[0]!.endpoints[0]!.place as Partial<{ id: string | null }>).id;
    localStorage.setItem(`along-the-way:today:${todayUser.id}:${trip.id}`, JSON.stringify(incompatible));
    expect(store.read(todayUser.id, trip.id)).toBeNull();
  });
  it("saves and reopens every fresh wishlist routing field", () => {
    const trip = todayTrip();
    const wishlist = todayWishlist();
    wishlist[0]!.providerPlaceId = "google-FIRST";
    wishlist[1]!.latitude = null;
    wishlist[1]!.longitude = null;
    const readModel = createTodayModel(trip, todaySkeleton(trip), wishlist, todayUser.id);
    const store = new TodaySnapshotStore(localStorage);

    const saved = store.save(todayUser.id, readModel);

    expect(saved).not.toBeNull();
    expect(saved?.schemaVersion).toBe(6);
    expect(new TodaySnapshotStore(localStorage).read(todayUser.id, trip.id)?.model.days[0]!.wishlist).toEqual([
      { id: "FIRST", name: "FIRST", type: "activity", latitude: 34, longitude: 135, providerPlaceId: "google-FIRST" },
      { id: "SECOND", name: "SECOND", type: "activity", latitude: null, longitude: null, providerPlaceId: null },
    ]);
  });
  it.each([
    { version: 2, snapshot: legacyV2, endpointId: null, removed: null, latitude: null, longitude: null, providerPlaceId: null },
    { version: 3, snapshot: legacyV3, endpointId: "station-v3", removed: null, latitude: null, longitude: null, providerPlaceId: null },
    { version: 4, snapshot: legacyV4, endpointId: "station-v4", removed: true, latitude: null, longitude: null, providerPlaceId: null },
    { version: 5, snapshot: legacyV5, endpointId: "station-v5", removed: true, latitude: 35, longitude: 139, providerPlaceId: "google-v5" },
  ])("migrates a genuine schema $version snapshot to schema 6 without inventing historical fields", ({
    snapshot, endpointId, removed, latitude, longitude, providerPlaceId,
  }) => {
    localStorage.setItem(key, JSON.stringify(snapshot));
    const migrated = new TodaySnapshotStore(localStorage).read("account", "trip");

    expect(migrated?.schemaVersion).toBe(6);
    expect(migrated?.model.days[0]!.wishlist[0]).toEqual({
      id: snapshot.model.days[0]!.wishlist[0]!.id,
      name: snapshot.model.days[0]!.wishlist[0]!.name,
      type: null,
      latitude,
      longitude,
      providerPlaceId,
    });
    expect(migrated?.model.items[0]!.endpoints[0]!.place).toMatchObject({ id: endpointId, type: null });
    expect(migrated?.model.items[0]!.participants?.[0]?.removed).toBe(removed);
    expect(JSON.parse(localStorage.getItem(key)!).schemaVersion).toBe(6);
  });
  it("rejects a purported legacy snapshot carrying a place identity outside the legacy format", () => {
    const trip = todayTrip();
    const store = new TodaySnapshotStore(localStorage);
    const current = store.save(todayUser.id, createTodayModel(trip, todaySkeleton(trip, [todayActivity()]), [], todayUser.id))!;
    const snapshotKey = `along-the-way:today:${todayUser.id}:${trip.id}`;
    localStorage.setItem(snapshotKey, JSON.stringify({ ...current, schemaVersion: 2 }));

    expect(store.read(todayUser.id, trip.id)).toBeNull();
    expect(localStorage.getItem(snapshotKey)).toBeNull();
  });
  it("does not leave a private snapshot orphaned when the account marker cannot be stored", () => {
    localStorage.setItem("along-the-way:today-account", "other-account");
    const storage: Storage = {
      get length() { return localStorage.length; },
      key: (index) => localStorage.key(index),
      getItem: (name) => localStorage.getItem(name),
      removeItem: (name) => localStorage.removeItem(name),
      clear: () => localStorage.clear(),
      setItem: (name, value) => {
        if (name === "along-the-way:today-account") {
          throw new DOMException("Storage quota exceeded", "QuotaExceededError");
        }
        localStorage.setItem(name, value);
      },
    };

    const store = new TodaySnapshotStore(storage);
    expect(store.save("account", model)).toBeNull();
    expect(localStorage.getItem(key)).toBeNull();
    expect(store.lastAccount()).toBe("other-account");
  });
  it("keeps a readable legacy itinerary when persisting its migration exceeds storage quota", () => {
    const raw = JSON.stringify(legacyV2);
    localStorage.setItem(key, raw);
    const storage: Storage = {
      get length() { return localStorage.length; },
      key: (index) => localStorage.key(index),
      getItem: (name) => localStorage.getItem(name),
      removeItem: (name) => localStorage.removeItem(name),
      clear: () => localStorage.clear(),
      setItem: () => { throw new DOMException("Storage quota exceeded", "QuotaExceededError"); },
    };

    const reopened = new TodaySnapshotStore(storage);
    expect(reopened.read("account", "trip")?.model.tripVersion).toBe(2);
    expect(localStorage.getItem(key)).toBe(raw);
    expect(new TodaySnapshotStore(storage).read("account", "trip")?.model.tripName).toBe("V2 trip");
  });
});
