// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TripHistoryResponse } from "@along-the-way/contracts/private-trips";
import { App } from "../src/App";
import { createTodayModel } from "../src/today-model";
import { TodaySnapshotStore } from "../src/today-snapshot";
import { todayActivity, todaySkeleton, todayTrip, todayUser, todayWishlist } from "./today-fixtures";

let root: Root;
let host: HTMLDivElement;
let trips = [todayTrip(), todayTrip("B", "11")];
let skeleton = todaySkeleton(trips[0]);
let tripHistory: TripHistoryResponse = { events: [], nextCursor: null };
let dayVersion = 1;
let savedOrder = false;
let gate: Promise<void> | null = null;
let requests: string[] = [];
let liveVersion = 0;
let liveSources: Array<EventTarget & { url: string }> = [];
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  localStorage.clear();
  trips = [todayTrip(), todayTrip("B", "11")];
  skeleton = todaySkeleton(trips[0]);
  tripHistory = { events: [], nextCursor: null };
  dayVersion = 1;
  savedOrder = false; gate = null; requests = [];
  liveVersion = 0; liveSources = [];
  history.replaceState({}, "", "/?trip=A&tab=today&day=2026-10-21");
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", class extends EventTarget {
    constructor(readonly url: string) { super(); liveSources.push(this); }
    close = vi.fn();
  });
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    requests.push(input);
    if (gate && input.startsWith("/api/trips/A")) await gate;
    if (input === "/api/session") return reply({ user: todayUser });
    if (input === "/api/trips") return reply({ trips });
    if (input === "/api/invites/accept") return reply({ error: { code: "used_invite", message: "This invitation was already used" } }, 409);
    const trip = trips.find((entry) => input.startsWith(`/api/trips/${entry.id}`));
    if (!trip) return reply({ error: { code: "trip_not_found", message: "Trip unavailable" } }, 404);
    if (input === `/api/trips/${trip.id}`) return reply({ trip });
    if (input.endsWith("/history")) return reply(trip.id === "A" ? tripHistory : { events: [], nextCursor: null });
    if (input.endsWith("/version")) return reply({ tripVersion: liveVersion, lastEventId: liveVersion ? "latest-event" : null });
    if (input.endsWith("/skeleton")) return reply({ skeleton: trip.id === "A" ? skeleton : todaySkeleton(trip) });
    if (input.endsWith("/trip-places")) return reply({ tripPlaces: trip.id === "A" ? todayWishlist(savedOrder) : [] });
    if (input.endsWith("/place-order")) {
      savedOrder = true;
      return reply({ orderedTripPlaceIds: ["SECOND", "FIRST"], version: ++dayVersion });
    }
    if (input.endsWith("/timetable")) {
      const body: unknown = JSON.parse(String(init?.body));
      if (!body || typeof body !== "object" || !("order" in body) || typeof body.order !== "string") throw new Error("Missing timetable order");
      const order = body.order;
      return reply({ timetable: { dayId: "day21", date: "2026-10-21", window: { startMinute: 540, endMinute: 1140, version: dayVersion }, order,
        orderedTripPlaceIds: order === "suggested" ? ["SECOND", "FIRST"] : ["FIRST", "SECOND"], startsAt: null, endsAt: null, rows: [], unscheduled: [],
        load: { busyMinutes: 120, windowMinutes: 600, level: "relaxed" } } });
    }
    if (input.endsWith("/discovery")) return reply({ discovery: { brief: null, latestRun: null, proposals: [], decided: [], feedback: [], modelAvailable: false, placeProviderAvailable: false } });
    throw new Error(`Unexpected request: ${input}`);
  }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const mount = () => act(async () => root.render(<App />));
function button(text: string, container: ParentNode = document): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent?.trim() === text);
  expect(found, `button ${text}`).toBeDefined();
  return found!;
}
const click = (element: HTMLElement) => act(async () => element.click());
async function switchTrip(name: string) {
  const trigger = document.querySelector<HTMLButtonElement>('button[aria-label$="切換旅程"]');
  expect(trigger).toBeInTheDocument();
  await click(trigger!);
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  expect(dialog).toBeInTheDocument();
  const option = [...dialog!.querySelectorAll<HTMLButtonElement>("button")]
    .find((element) => element.querySelector("strong")?.textContent === name);
  expect(option).toBeDefined();
  await click(option!);
}
const snapshot = () => new TodaySnapshotStore(localStorage).read(todayUser.id, "A")!;
async function travelHistory(direction: "back" | "forward") {
  await act(async () => {
    const changed = new Promise<void>((resolve) => window.addEventListener("popstate", () => resolve(), { once: true }));
    history[direction](); await changed;
  });
}

it("purges an unselected revoked snapshot after an authorized trip-list refresh", async () => {
  const store = new TodaySnapshotStore(localStorage);
  for (const trip of trips) store.save(todayUser.id, createTodayModel(trip, todaySkeleton(trip), [], todayUser.id));
  trips = [trips[0]!];
  await mount();
  expect(store.forAccount(todayUser.id).map((entry) => entry.model.tripId)).toEqual(["A"]);
  await act(async () => { window.dispatchEvent(new Event("offline")); });
  expect(document.body).not.toHaveTextContent("Trip B");
});

it("keeps valid authentication and other trips when a bookmarked trip is inaccessible", async () => {
  history.replaceState({}, "", "/?trip=revoked&tab=today");
  await mount();
  expect(document.querySelector('input[type="email"]')).toBeNull();
  await switchTrip("Trip A");
  expect(document.querySelector('[data-trip-tab="today"]')).toBeInTheDocument();
  expect(snapshot().model.tripId).toBe("A");
});

it("preserves destination dates and forward history while a cross-trip Back read is pending", async () => {
  await mount();
  const select = document.querySelector<HTMLSelectElement>('#trip-panel-today select')!;
  await act(async () => { select.value = "2026-10-22"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await switchTrip("Trip B");
  expect(new URLSearchParams(location.search).get("day")).toBe("2026-11-21");
  let release!: () => void;
  gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    await travelHistory("back");
    expect(new URLSearchParams(location.search).get("trip")).toBe("A");
    expect(new URLSearchParams(location.search).get("day")).toBe("2026-10-22");
  } finally { await act(async () => { gate = null; release(); }); }
  expect(document.querySelector("#trip-panel-today select")).toHaveValue("2026-10-22");
  await travelHistory("forward");
  expect(new URLSearchParams(location.search).get("trip")).toBe("B");
  expect(document.querySelector("#trip-panel-today select")).toHaveValue("2026-11-21");
});

it("refreshes mounted itinerary, lodging and recent changes after explicit Today sync without a reload loop", async () => {
  const lodging = { ...todayActivity("REMOVED_LODGING"), type: "lodging" as const, details: { bookedBy: null, confirmationCode: null } };
  skeleton = todaySkeleton(trips[0], [todayActivity("REMOVED_ACTIVITY"), lodging]);
  await mount();
  expect(document.getElementById("itinerary-segment-panel-daily")).toHaveTextContent("REMOVED_ACTIVITY");
  expect(document.getElementById("itinerary-segment-panel-lodging")).toHaveTextContent("REMOVED_LODGING");
  trips[0] = { ...trips[0]!, version: 8 };
  skeleton = todaySkeleton(trips[0]);
  tripHistory = { events: [{
    id: "new-event", actorId: todayUser.id, actorDisplayName: "History editor", actorEmail: todayUser.email,
    eventType: "itinerary_item.deleted", targetType: "itinerary_item", targetId: "REMOVED_ACTIVITY", targetName: null,
    summary: "Deleted an itinerary item", createdAt: "2026-10-21T03:00:00Z", reappliedFromVersion: null,
  }], nextCursor: null };
  const sync = [...host.querySelectorAll<HTMLButtonElement>("#trip-panel-today button")].find((element) => /重新.*同步/.test(element.textContent ?? ""))!;
  await click(sync);
  expect(document.getElementById("trip-panel-today")).toHaveTextContent("正式行程版本 8");
  expect(document.getElementById("itinerary-segment-panel-daily")).not.toHaveTextContent("REMOVED_ACTIVITY");
  expect(document.getElementById("itinerary-segment-panel-lodging")).not.toHaveTextContent("REMOVED_LODGING");
  expect(document.getElementById("trip-panel-members")).toHaveTextContent("刪除了固定行程");
  expect(document.getElementById("trip-panel-members")).toHaveTextContent("History editor");
  expect(document.getElementById("trip-panel-members")).not.toHaveTextContent("REMOVED_ACTIVITY");
  const afterSync = requests.length;
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  expect(requests.length).toBe(afterSync);
});

it("updates the offline wishlist order and day timezone after accepting a suggested day order", async () => {
  await mount();
  expect(snapshot().model.days[0]!.timeZone).toBe("Asia/Tokyo");
  await click(document.querySelector<HTMLButtonElement>('[data-trip-tab="itinerary"]')!);
  await click(document.getElementById("itinerary-segment-daily")!);
  await click(button("排這一天", document.getElementById("itinerary-segment-panel-daily")!));
  await click(button("試試建議順序"));
  await click(button("使用這個順序"));
  expect(savedOrder).toBe(true);
  expect(snapshot().model.days[0]!.wishlist.map((place) => place.id)).toEqual(["SECOND", "FIRST"]);
  expect(snapshot().model.days[0]!.timeZone).toBe("Europe/Paris");
});

it.each(["change", "revocation"] as const)("does not let the old trip's %s supersede an in-flight Back navigation", async (invalidation) => {
  await mount();
  await switchTrip("Trip B");
  const oldTripSource = liveSources.find((source) => source.url.includes("/trips/B/events"))!;
  let release!: () => void;
  gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    await travelHistory("back");
    expect(new URLSearchParams(location.search).get("trip")).toBe("A");
    liveVersion = 1;
    if (invalidation === "revocation") trips = [trips[0]!];
    await act(async () => {
      oldTripSource.dispatchEvent(new MessageEvent("change", { data: JSON.stringify({
        id: "latest-event", tripVersion: 1, entityType: "trip_day", entityId: "day21",
        kind: "trip_day.window_changed", summary: "Updated day hours",
      }) }));
    });
  } finally { await act(async () => { gate = null; release(); }); }
  expect(new URLSearchParams(location.search).get("trip")).toBe("A");
  expect(document.querySelector("#trip-panel-today select")).toHaveValue("2026-10-21");
  if (invalidation === "revocation") {
    expect(new TodaySnapshotStore(localStorage).read(todayUser.id, "B")).toBeNull();
    expect(document.body).not.toHaveTextContent("Trip B");
  } else {
    await travelHistory("forward");
    expect(new URLSearchParams(location.search).get("trip")).toBe("B");
    expect(document.querySelector("#trip-panel-today select")).toHaveValue("2026-11-21");
  }
});

it("keeps a failed online mutation's error visible after a live read refresh", async () => {
  history.replaceState({}, "", "/?trip=A&tab=overview#inviteToken=used");
  await mount();
  expect(new URLSearchParams(location.search).get("tab")).toBe("itinerary");
  expect(new URLSearchParams(location.search).get("segment")).toBe("flight");
  await click(button("接受邀請"));
  expect(document.querySelector('[role="alert"]')).toHaveTextContent("這個邀請已使用。");
  liveVersion = 1;
  await act(async () => {
    liveSources[0]!.dispatchEvent(new MessageEvent("change", { data: JSON.stringify({
      id: "latest-event", tripVersion: 1, entityType: "trip_day", entityId: "day21",
      kind: "trip_day.window_changed", summary: "Updated day hours",
    }) }));
  });
  expect(document.querySelector('[role="alert"]')).toHaveTextContent("這個邀請已使用。");
  expect(document.getElementById("itinerary-segment-panel-flight")).toBeInTheDocument();
});
