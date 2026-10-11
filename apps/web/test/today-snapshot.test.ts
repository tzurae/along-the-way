// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { TodaySnapshotStore } from "../src/today-snapshot";
import { createTodayModel, type TodayModel } from "../src/today-model";
import type { TripDto } from "@along-the-way/contracts/private-trips";
import type { TripSkeletonDto } from "@along-the-way/contracts/trip-skeleton";
import { todayActivity, todaySkeleton, todayTrip, todayUser, todayWishlist } from "./today-fixtures";

const model: TodayModel = { tripId: "trip", tripName: "Private trip", tripVersion: 7, memberId: "member", items: [], days: [{ id: "day", date: "2026-10-21", timeZone: "Asia/Tokyo", itemIds: [], wishlist: [] }] };
const key = "along-the-way:today:account:trip";

describe("account-scoped read-only Today snapshots", () => {
  beforeEach(() => localStorage.clear());
  it("reopens the last successful formal version through a fresh store while offline", () => {
    const store = new TodaySnapshotStore(localStorage);
    store.save("account", model, Date.parse("2026-10-21T02:30Z"));
    const reopened = new TodaySnapshotStore(localStorage);
    expect(reopened.read("account", "trip")).toMatchObject({ schemaVersion: 3, fetchedAt: "2026-10-21T02:30:00.000Z", model: { tripVersion: 7, days: [{ timeZone: "Asia/Tokyo" }] } });
    expect(reopened.read("other-account", "trip")).toBeNull();
    expect(reopened.lastAccount()).toBe("account");
    store.save("account", { ...model, tripVersion: 8 });
    expect(reopened.read("account", "trip")?.model.tripVersion).toBe(8);
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
    const trip: TripDto = { id: "trip", name: "Trip", startDate: "2026-10-21", endDate: "2026-10-21", defaultCurrency: "JPY", countryStops: [{ id: "stop", countryCode: "JP", position: 0, timeZone: "Asia/Tokyo" }], days: [{ id: "day", date: "2026-10-21", title: null }], members: [{ id: "member", userId: "account", email: "private@example.test", displayName: "甲", role: "owner" }], invites: [{ id: "invite", email: "invite@example.test", role: "editor", status: "pending", expiresAt: "2026-12-01" }], memberCount: 1, dayCount: 1, role: "owner", version: 7 };
    const skeleton: TripSkeletonDto = { tripVersion: 7, places: [], days: [{ id: "day", date: "2026-10-21", entries: [] }], items: [], tripInformationItemIds: [] };
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
    expect(saved.model.items[0]!.participants).toEqual([{ id: "member", name: todayUser.email }, { id: "named", name: "旅伴" }]);
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
  it("migrates an accepted schema 2 snapshot without guessing missing place identities", () => {
    const trip = todayTrip();
    const store = new TodaySnapshotStore(localStorage);
    const current = store.save(todayUser.id, createTodayModel(trip, todaySkeleton(trip, [todayActivity()]), todayWishlist(), todayUser.id))!;
    const legacy = structuredClone(current) as unknown as {
      schemaVersion: number;
      model: {
        days: Array<{ wishlist: Array<Record<string, unknown>> }>;
        items: Array<{ title: string; endpoints: Array<{ place: Record<string, unknown> | null }> }>;
      };
    };
    legacy.schemaVersion = 2;
    for (const item of legacy.model.items) for (const endpoint of item.endpoints) if (endpoint.place) delete endpoint.place.id;
    localStorage.setItem(`along-the-way:today:${todayUser.id}:${trip.id}`, JSON.stringify(legacy));

    const migrated = store.read(todayUser.id, trip.id);
    expect(migrated).toMatchObject({ schemaVersion: 3, model: { items: [{ title: "activity", endpoints: [{ place: { id: null, name: "Park" } }] }] } });
    expect(migrated?.model.days[0]!.wishlist[0]).toEqual({ id: "FIRST", name: "FIRST" });
    expect(JSON.parse(localStorage.getItem(`along-the-way:today:${todayUser.id}:${trip.id}`)!).schemaVersion).toBe(3);
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
  it("keeps a readable legacy itinerary when persisting its migration exceeds storage quota", () => {
    const raw = JSON.stringify({ schemaVersion: 2, accountId: "account", fetchedAt: "2026-10-21T02:30:00.000Z", model });
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
    expect(reopened.read("account", "trip")?.model.tripVersion).toBe(7);
    expect(localStorage.getItem(key)).toBe(raw);
    expect(new TodaySnapshotStore(storage).read("account", "trip")?.model.tripName).toBe("Private trip");
  });
});
