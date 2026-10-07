// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App";
import { createTodayModel } from "../src/today-model";
import { TodaySnapshotStore } from "../src/today-snapshot";
import { todayActivity, todaySkeleton, todayTrip, todayUser, todayWishlist } from "./today-fixtures";

let root: Root;
let host: HTMLDivElement;
let trips = [todayTrip(), todayTrip("B", "11")];
let skeleton = todaySkeleton(trips[0]);
let savedOrder = false;
let gate: Promise<void> | null = null;
let requests: string[] = [];
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  localStorage.clear();
  trips = [todayTrip(), todayTrip("B", "11")];
  skeleton = todaySkeleton(trips[0]);
  savedOrder = false; gate = null; requests = [];
  history.replaceState({}, "", "/?trip=A&tab=today&day=2026-10-21");
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    requests.push(input);
    if (gate && input.startsWith("/api/trips/A")) await gate;
    if (input === "/api/session") return reply({ user: todayUser });
    if (input === "/api/trips") return reply({ trips });
    const trip = trips.find((entry) => input.startsWith(`/api/trips/${entry.id}`));
    if (!trip) return reply({ error: { code: "not_found", message: "Trip unavailable" } }, 404);
    if (input === `/api/trips/${trip.id}`) return reply({ trip });
    if (input.endsWith("/skeleton")) return reply({ skeleton: trip.id === "A" ? skeleton : todaySkeleton(trip) });
    if (input.endsWith("/trip-places")) return reply({ tripPlaces: trip.id === "A" ? todayWishlist(savedOrder) : [] });
    if (input.endsWith("/place-order")) { savedOrder = true; return new Response(null, { status: 204 }); }
    if (input.endsWith("/timetable")) {
      const body: unknown = JSON.parse(String(init?.body));
      if (!body || typeof body !== "object" || !("order" in body) || typeof body.order !== "string") throw new Error("Missing timetable order");
      const order = body.order;
      return reply({ timetable: { dayId: "day21", date: "2026-10-21", window: { startMinute: 540, endMinute: 1140 }, order,
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
  const allowed = [...host.querySelectorAll("button")].find((element) => element.textContent?.includes("Trip A"));
  expect(allowed).toBeDefined();
  await click(allowed!);
  expect(document.getElementById("trip-tab-today")).toBeInTheDocument();
  expect(snapshot().model.tripId).toBe("A");
});

it("preserves destination dates and forward history while a cross-trip Back read is pending", async () => {
  await mount();
  const select = document.querySelector<HTMLSelectElement>('#trip-panel-today select')!;
  await act(async () => { select.value = "2026-10-22"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  const tripB = [...host.querySelectorAll("button")].find((element) => element.textContent?.includes("Trip B"))!;
  await click(tripB);
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
  expect(document.getElementById("trip-panel-itinerary")).toHaveTextContent("REMOVED_ACTIVITY");
  expect(document.getElementById("trip-panel-lodging")).toHaveTextContent("REMOVED_LODGING");
  trips[0] = { ...trips[0]!, version: 8 };
  skeleton = todaySkeleton(trips[0]);
  skeleton.events = [{ id: "new-event", actorId: todayUser.id, eventType: "deleted", targetType: "itinerary_item", targetId: "REMOVED_ACTIVITY", summary: "LATEST_CHANGE", createdAt: "2026-10-21T03:00:00Z" }];
  // Both labels identify the same public synchronization action before/after the copy correction.
  const sync = [...host.querySelectorAll<HTMLButtonElement>("#trip-panel-today button")].find((element) => /重新.*同步/.test(element.textContent ?? ""))!;
  await click(sync);
  expect(document.getElementById("trip-panel-today")).toHaveTextContent("正式行程版本 8");
  expect(document.getElementById("trip-panel-itinerary")).not.toHaveTextContent("REMOVED_ACTIVITY");
  expect(document.getElementById("trip-panel-lodging")).not.toHaveTextContent("REMOVED_LODGING");
  expect(document.getElementById("trip-panel-recent")).toHaveTextContent("LATEST_CHANGE");
  const afterSync = requests.length;
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  expect(requests.length).toBe(afterSync);
});

it("updates the offline wishlist order and day timezone after accepting a suggested day order", async () => {
  await mount();
  expect(snapshot().model.days[0]!.timeZone).toBe("Asia/Tokyo");
  await click(document.getElementById("trip-tab-itinerary")!);
  await click(button("排這一天", document.getElementById("trip-panel-itinerary")!));
  await click(button("試試建議順序"));
  await click(button("使用這個順序"));
  expect(savedOrder).toBe(true);
  expect(snapshot().model.days[0]!.wishlist.map((place) => place.id)).toEqual(["SECOND", "FIRST"]);
  expect(snapshot().model.days[0]!.timeZone).toBe("Europe/Paris");
});
