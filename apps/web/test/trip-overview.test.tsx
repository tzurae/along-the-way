// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { TripPlaceDto } from "@along-the-way/contracts/trip-places";
import { TripSkeletonWorkspace } from "../src/TripSkeletonWorkspace";
import { todaySkeleton, todayTrip, todayWishlist } from "./today-fixtures";

beforeEach(() => {
  history.replaceState({}, "", "/?trip=A&tab=itinerary&segment=daily");
  Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })) });
  Object.defineProperty(window, "requestAnimationFrame", { configurable: true, value: vi.fn(() => 1) });
  Object.defineProperty(window, "cancelAnimationFrame", { configurable: true, value: vi.fn() });
  Object.defineProperty(window, "scrollBy", { configurable: true, value: vi.fn() });
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderOverview(tripPlaces: TripPlaceDto[], requestOverride?: <T>(path: string, init?: RequestInit & { parse?: (value: unknown) => unknown }) => Promise<T>) {
  const trip = todayTrip();
  const skeleton = todaySkeleton(trip);
  const request = requestOverride ?? (async <T,>(path: string, init?: RequestInit & { parse?: (value: unknown) => unknown }): Promise<T> => {
    const value = path.endsWith("/skeleton") ? { skeleton } : { tripPlaces };
    return (init?.parse ? init.parse(value) : value) as T;
  });
  render(<TripSkeletonWorkspace trip={trip} request={request} placesRevision={0} onPlacesChanged={vi.fn()} onTravelEdit={vi.fn()} />);
  return { trip, skeleton };
}

it("filters multiple days, ignores foreign dates, and keeps pending collapsed", async () => {
  history.replaceState({}, "", "/?trip=A&tab=itinerary&segment=daily&days=2026-10-21,2099-01-01");
  renderOverview(todayWishlist());
  const group = await screen.findByRole("group", { name: "篩選日期" });
  const pendingToggle = document.querySelector<HTMLButtonElement>(".plan-pending-toggle");
  expect(pendingToggle).toHaveTextContent("待安排");
  expect(pendingToggle).toHaveAttribute("aria-expanded", "false");
  expect(document.querySelectorAll(".day-column")).toHaveLength(1);
  expect(document.querySelector('.day-column[data-date="2026-10-21"]')).toBeInTheDocument();

  fireEvent.click(within(group).getByRole("button", { name: /10\/22/ }));
  expect(document.querySelectorAll(".day-column")).toHaveLength(2);
  expect(new URLSearchParams(location.search).get("days")).toBe("2026-10-21,2026-10-22");

  fireEvent.click(within(group).getByRole("button", { name: /10\/21/ }));
  expect(document.querySelectorAll(".day-column")).toHaveLength(1);
  expect(document.querySelector('.day-column[data-date="2026-10-22"]')).toBeInTheDocument();

  fireEvent.click(within(group).getByRole("button", { name: /10\/22/ }));
  expect(document.querySelectorAll(".day-column")).toHaveLength(3);
  expect(within(group).getByRole("button", { name: "全部" })).toHaveAttribute("aria-pressed", "true");
  expect(new URLSearchParams(location.search).has("days")).toBe(false);
});

it("moves a place between two visible non-adjacent days with versioned assignment then order writes", async () => {
  history.replaceState({}, "", "/?trip=A&tab=itinerary&segment=daily&days=2026-10-21,2026-10-23");
  const trip = todayTrip();
  const skeleton = todaySkeleton(trip);
  const [first, second] = todayWishlist();
  let tripPlaces = [first!, { ...second!, assignedDayId: "day23", dayPosition: 0 }];
  const writes: Array<{ path: string; body: unknown }> = [];
  const request = async <T,>(path: string, init?: RequestInit & { parse?: (value: unknown) => unknown }): Promise<T> => {
    let value: unknown;
    if (!init?.method && path.endsWith("/skeleton")) value = { skeleton };
    else if (!init?.method && path.endsWith("/trip-places")) value = { tripPlaces };
    else if (path.endsWith("/trip-place-day-assignments")) {
      const body = JSON.parse(String(init?.body));
      writes.push({ path, body });
      const assignment = body.assignments[0];
      tripPlaces = tripPlaces.map((place) => place.id === assignment.tripPlaceId
        ? { ...place, assignedDayId: assignment.tripDayId, version: place.version + 1 }
        : place);
      value = { tripPlaces };
    } else if (path.endsWith("/days/day23/route")) {
      writes.push({ path, body: JSON.parse(String(init?.body)) });
      value = { route: { dayId: "day23", date: "2026-10-23", version: 9, order: "current", orderedTripPlaceIds: ["SECOND", "FIRST"], startsAt: null, endsAt: null, stops: [], metersToEnd: null, totalMeters: 0, travelSource: "straight_line", transitProvider: null, routeShapesAvailable: false, minutesToEnd: null, linesToEnd: [], totalMinutes: null, transitMatrix: [], transitCallsNeeded: 0, transitCacheDays: null } };
    } else if (path.endsWith("/days/day23/place-order")) {
      writes.push({ path, body: JSON.parse(String(init?.body)) });
      value = { orderedTripPlaceIds: ["SECOND", "FIRST"], version: 10 };
    } else throw new Error(`Unexpected request: ${path}`);
    return (init?.parse ? init.parse(value) : value) as T;
  };
  render(<TripSkeletonWorkspace trip={trip} request={request} placesRevision={0} onPlacesChanged={vi.fn()} onTravelEdit={vi.fn()} />);
  await screen.findByRole("heading", { name: "安排" });
  const target = document.querySelector<HTMLElement>('[data-drop-day="day23"]')!;
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => target });
  const handle = document.querySelector<HTMLButtonElement>('[data-drag-place="FIRST"] .plan-drag-handle')!;
  expect(handle).toBeInTheDocument();

  fireEvent.pointerDown(handle, { button: 0, pointerId: 7, clientX: 10, clientY: 10 });
  fireEvent.pointerMove(window, { pointerId: 7, clientX: 30, clientY: 30 });
  fireEvent.pointerUp(window, { pointerId: 7, clientX: 30, clientY: 30 });

  await waitFor(() => expect(writes).toHaveLength(4));
  expect(writes.map((write) => write.path)).toEqual([
    "/api/trips/A/trip-place-day-assignments",
    "/api/trips/A/trip-place-day-assignments",
    "/api/trips/A/days/day23/route",
    "/api/trips/A/days/day23/place-order",
  ]);
  expect(writes[0]!.body).toEqual({ assignments: [{ tripPlaceId: "FIRST", tripDayId: null, expectedVersion: 1 }] });
  expect(writes[1]!.body).toEqual({ assignments: [{ tripPlaceId: "FIRST", tripDayId: "day23", expectedVersion: 2 }] });
  expect(writes[2]!.body).toEqual({ order: "current" });
  expect(writes[3]!.body).toEqual({ orderedTripPlaceIds: ["SECOND", "FIRST"], expectedVersion: 9 });
  expect(document.querySelector('.day-column[data-date="2026-10-22"]')).not.toBeInTheDocument();
});

it("repairs a wishlist location through its distinct legacy skeleton place", async () => {
  history.replaceState({}, "", "/?trip=A&tab=itinerary&segment=daily&repair=FIRST");
  const trip = todayTrip();
  const skeleton = todaySkeleton(trip);
  skeleton.places = [{ ...skeleton.places[0]!, id: "legacy-FIRST", name: "FIRST", latitude: null, longitude: null, locationStatus: "coordinates_missing" }];
  let place: TripPlaceDto = { ...todayWishlist()[0]!, placeId: "canonical-FIRST", legacyPlaceId: "legacy-FIRST", latitude: null, longitude: null, assignedDayId: null, dayPosition: null };
  let savedBody: Record<string, unknown> | null = null;
  const request = async <T,>(path: string, init?: RequestInit & { parse?: (value: unknown) => unknown }): Promise<T> => {
    let value: unknown;
    if (path.endsWith("/skeleton")) value = { skeleton };
    else if (path.endsWith("/trip-places")) value = { tripPlaces: [place] };
    else if (path.endsWith("/places/legacy-FIRST") && init?.method === "PATCH") {
      savedBody = JSON.parse(String(init.body));
      skeleton.places[0] = { ...skeleton.places[0]!, latitude: 35.01, longitude: 135.76, locationStatus: "complete", version: 2 };
      place = { ...place, latitude: 35.01, longitude: 135.76, status: "ready", version: 2 };
      value = { place: skeleton.places[0] };
    } else throw new Error(`Unexpected request: ${path}`);
    return (init?.parse ? init.parse(value) : value) as T;
  };
  render(<TripSkeletonWorkspace trip={trip} request={request} placesRevision={0} onPlacesChanged={vi.fn()} onTravelEdit={vi.fn()} />);

  const dialog = await screen.findByRole("dialog", { name: "編輯地點" });
  fireEvent.change(within(dialog).getByLabelText("緯度"), { target: { value: "35.01" } });
  fireEvent.change(within(dialog).getByLabelText("經度"), { target: { value: "135.76" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "儲存地點" }));

  await waitFor(() => expect(savedBody).toMatchObject({ latitude: 35.01, longitude: 135.76, expectedVersion: 1 }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "編輯地點" })).not.toBeInTheDocument());
  fireEvent.click(document.querySelector(".plan-pending-toggle")!);
  expect(await screen.findByRole("button", { name: "安排日期" })).toBeInTheDocument();
});
