// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, waitFor } from "@testing-library/react";
import type { TripHistoryResponse } from "@along-the-way/contracts/private-trips";
import type { TripPlaceDto } from "@along-the-way/contracts/trip-places";
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
let previewFails = false;
let magicConsumeFailure: "network" | 403 | 500 | null = null;
let magicInviteOutcome = false;
let tripPlacesOverride: TripPlaceDto[] | null = null;
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  localStorage.clear();
  trips = [todayTrip(), todayTrip("B", "11")];
  skeleton = todaySkeleton(trips[0]);
  tripHistory = { events: [], nextCursor: null };
  dayVersion = 1;
  savedOrder = false; gate = null; requests = [];
  liveVersion = 0; liveSources = []; previewFails = false;
  magicConsumeFailure = null;
  magicInviteOutcome = false;
  tripPlacesOverride = null;
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
    if (input === "/api/auth/magic-links/consume") {
      if (magicConsumeFailure === "network") throw new TypeError("Failed to fetch");
      if (magicConsumeFailure) {
        return reply({
          error: {
            code: magicConsumeFailure === 403 ? "forbidden" : "internal",
            message: "Consume failed",
          },
        }, magicConsumeFailure);
      }
      return reply({
        user: todayUser,
        ...(magicInviteOutcome ? { inviteOutcome: "expired-or-revoked" } : {}),
      });
    }
    if (input === "/api/trips") return reply({ trips });
    if (input === "/api/invites/accept") return reply({ error: { code: "used_invite", message: "This invitation was already used" } }, 409);
    const trip = trips.find((entry) => input.startsWith(`/api/trips/${entry.id}`));
    if (!trip) return reply({ error: { code: "trip_not_found", message: "Trip unavailable" } }, 404);
    if (input === `/api/trips/${trip.id}`) return reply({ trip });
    if (input.endsWith("/history")) return reply(trip.id === "A" ? tripHistory : { events: [], nextCursor: null });
    if (input.endsWith("/version")) return reply({ tripVersion: liveVersion, lastEventId: liveVersion ? "latest-event" : null });
    if (input.endsWith("/skeleton")) return reply({ skeleton: trip.id === "A" ? skeleton : todaySkeleton(trip) });
    if (input.endsWith("/trip-places")) return reply({ tripPlaces: trip.id === "A" ? (tripPlacesOverride ?? todayWishlist(savedOrder)) : [] });
    if (input.includes("/place-previews?")) return previewFails
      ? reply({ error: { code: "provider_unavailable", message: "Preview unavailable" } }, 503)
      : reply({ previews: [] });
    if (input.endsWith("/places/canonical-UNSCHEDULED") && init?.method === "DELETE") {
      return reply({ error: { code: "forbidden", message: "server copy" } }, 403);
    }
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


it("consumes each magic token once when the hash changes in the same document", async () => {
  await mount();

  history.replaceState({}, "", "/?trip=A&tab=today#magicToken=same-tab-token");
  await act(async () => {
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });

  await waitFor(() => {
    expect(requests.filter((request) => request === "/api/auth/magic-links/consume"))
      .toHaveLength(1);
  });
  await waitFor(() => expect(document.querySelector('[data-trip-tab="today"]')).toBeInTheDocument());
  expect(new URLSearchParams(location.hash.slice(1)).has("magicToken")).toBe(false);

  history.replaceState({}, "", "/?trip=A&tab=today#magicToken=same-tab-token");
  await act(async () => {
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  expect(requests.filter((request) => request === "/api/auth/magic-links/consume"))
    .toHaveLength(1);
});

it.each(["network", 403, 500] as const)(
  "keeps the magic token and shows a retry after a %s consume failure",
  async (failure) => {
    await mount();
    magicConsumeFailure = failure;

    history.replaceState({}, "", "/?trip=A&tab=today#magicToken=retryable-token");
    await act(async () => {
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });

    await waitFor(() => {
      expect(document.querySelector('[role="alert"]')).toHaveTextContent(
        "目前無法驗證登入連結。請檢查網路連線後重試；登入連結仍會保留。",
      );
    });
    expect(button("重試登入")).toBeEnabled();
    expect(new URLSearchParams(location.hash.slice(1)).get("magicToken"))
      .toBe("retryable-token");
    magicConsumeFailure = null;
    await click(button("重試登入"));
    await waitFor(() => {
      expect(requests.filter((request) => request === "/api/auth/magic-links/consume"))
        .toHaveLength(2);
    });
    await waitFor(() =>
      expect(document.querySelector('[data-trip-tab="today"]')).toBeInTheDocument(),
    );
  },
);

it("signs in but explains when a linked invitation expired or was revoked", async () => {
  await mount();
  magicInviteOutcome = true;

  history.replaceState(
    {},
    "",
    "/?trip=A&tab=today#magicToken=outcome-token&inviteToken=legacy-invite-token",
  );
  await act(async () => {
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });

  await waitFor(() => {
    expect(document.querySelector('[role="alert"]')).toHaveTextContent(
      "邀請已過期或已被撤銷，請向旅程建立者索取新的邀請。",
    );
  });
  expect([...document.querySelectorAll("button")].some((element) =>
    element.textContent?.trim() === "接受邀請",
  )).toBe(false);
  expect(new URLSearchParams(location.hash.slice(1)).has("inviteToken")).toBe(false);
});
it("shows one actionable first-trip surface and restores focus after its dialog closes", async () => {
  trips = [];
  history.replaceState({}, "", "/");
  await mount();

  expect(document.querySelector("h1")).toHaveTextContent("先建立一趟旅程");
  expect(document.querySelectorAll("[data-trip-tab]")).toHaveLength(0);
  expect(document.body).not.toHaveTextContent("即時更新重新連線中");
  const trigger = button("建立旅程", host);
  trigger.focus();
  await click(trigger);
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog).toHaveTextContent("步驟 1 / 3・旅程");
  await click(button("關閉", dialog));
  await waitFor(() => expect(trigger).toHaveFocus());
});

it("derives open onboarding actions from trip data and persists dismissal", async () => {
  await mount();

  const checklist = document.querySelector<HTMLElement>(".trip-onboarding-checklist");
  expect(checklist).toHaveTextContent("新增住宿（可稍後）");
  expect(checklist).toHaveTextContent("邀請同行成員（可稍後）");
  expect(checklist).not.toHaveTextContent("加入第一個地點");
  expect(checklist).not.toHaveTextContent("把地點排進某一天");
  await click(button("略過", checklist!));
  expect(document.querySelector(".trip-onboarding-checklist")).toBeNull();
  expect(localStorage.getItem("along-the-way:trip-onboarding:account:A")).toBe("dismissed");
});

it("keeps the core Today snapshot readable when optional place previews fail", async () => {
  previewFails = true;
  await mount();

  expect(snapshot().model.days[0]!.wishlist.map((place) => place.name)).toEqual(["FIRST", "SECOND"]);
  const today = document.getElementById("trip-panel-today");
  expect(today).toHaveTextContent("這一天還沒有行程");
  expect(today).toHaveTextContent(/今天想去（未排時間）.*FIRST.*SECOND/);
  expect(document.body).not.toHaveTextContent("離線資料");
});

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

it("refreshes itinerary and recent changes after reconnecting from Today without a reload loop", async () => {
  const lodging = { ...todayActivity("REMOVED_LODGING"), type: "lodging" as const, details: { bookedBy: null, confirmationCode: null } };
  skeleton = todaySkeleton(trips[0], [todayActivity("REMOVED_ACTIVITY"), lodging]);
  await mount();
  await click(document.querySelector<HTMLButtonElement>('button[data-trip-tab="itinerary"]')!);
  expect(document.getElementById("itinerary-segment-panel-daily")).toHaveTextContent("REMOVED_ACTIVITY");
  expect(document.getElementById("itinerary-segment-panel-daily")).toHaveTextContent("REMOVED_LODGING");
  await click(document.querySelector<HTMLButtonElement>('button[data-trip-tab="today"]')!);
  await act(async () => { window.dispatchEvent(new Event("offline")); });
  expect(document.body).toHaveTextContent("離線資料");
  trips[0] = { ...trips[0]!, version: 8 };
  skeleton = todaySkeleton(trips[0]);
  tripHistory = { events: [{
    id: "new-event", actorId: todayUser.id, actorDisplayName: "History editor", actorEmail: todayUser.email,
    eventType: "itinerary_item.deleted", targetType: "itinerary_item", targetId: "REMOVED_ACTIVITY", targetName: null,
    summary: "Deleted an itinerary item", createdAt: "2026-10-21T03:00:00Z", reappliedFromVersion: null,
  }], nextCursor: null };
  await click(button("重新連線並同步", host));
  await click(document.querySelector<HTMLButtonElement>('button[data-trip-tab="itinerary"]')!);
  expect(document.getElementById("itinerary-segment-panel-daily")).not.toHaveTextContent("REMOVED_ACTIVITY");
  expect(document.getElementById("itinerary-segment-panel-daily")).not.toHaveTextContent("REMOVED_LODGING");
  await click(document.querySelector<HTMLButtonElement>('button[data-trip-tab="members"]')!);
  expect(document.getElementById("trip-panel-members")).toHaveTextContent("刪除了固定行程");
  expect(document.getElementById("trip-panel-members")).toHaveTextContent("History editor");
  expect(document.getElementById("trip-panel-members")).not.toHaveTextContent("REMOVED_ACTIVITY");
  const afterSync = requests.length;
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 30);
    await promise;
  });
  expect(requests.length).toBe(afterSync);
});

it("removes editor scheduling entry points while keeping itinerary previews readable", async () => {
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  trips[0] = {
    ...trips[0]!,
    role: "editor",
    members: trips[0]!.members.map((member) =>
      member.userId === todayUser.id ? { ...member, role: "editor" as const } : member
    ),
  };
  const canonicalPlace = skeleton.places[0]!;
  skeleton = {
    ...skeleton,
    places: [
      { ...canonicalPlace, id: "canonical-FIRST", name: "Scheduled canonical" },
      { ...canonicalPlace, id: "canonical-UNSCHEDULED", name: "Unscheduled canonical" },
    ],
  };
  const [scheduled, pending] = todayWishlist();
  tripPlacesOverride = [
    scheduled!,
    { ...pending!, assignedDayId: null, dayPosition: null },
    {
      ...pending!,
      id: "UNSCHEDULED",
      placeId: "canonical-UNSCHEDULED",
      name: "Unscheduled canonical",
      selectedForItinerary: false,
      assignedDayId: null,
      dayPosition: null,
    },
  ];
  await mount();

  const today = document.getElementById("trip-panel-today")!;
  expect(today).toHaveTextContent("只有旅程擁有者可以排入、改期或移出行程");
  expect([...today.querySelectorAll("button")].some((entry) => entry.textContent?.includes("安排這一天"))).toBe(false);

  await click(document.querySelector<HTMLButtonElement>('[data-trip-tab="itinerary"]')!);
  const itinerary = document.getElementById("itinerary-segment-panel-daily")!;
  expect(itinerary.textContent?.match(/只有旅程擁有者可以排入、改期或移出行程/g)).toHaveLength(1);
  for (const ownerAction of ["安排日期", "安排這一天", "加入地點", "排整趟行程", "從這天移出並列為待安排"]) {
    expect([...itinerary.querySelectorAll("button")].some((entry) => entry.textContent?.includes(ownerAction))).toBe(false);
  }

  const placeCards = [...itinerary.querySelectorAll<HTMLElement>(".place-card")];
  const scheduledCard = placeCards.find((card) => card.querySelector("h4")?.textContent === "Scheduled canonical");
  const unscheduledCard = placeCards.find((card) => card.querySelector("h4")?.textContent === "Unscheduled canonical");
  expect(scheduledCard).toBeDefined();
  expect(unscheduledCard).toBeDefined();
  const scheduledDelete = [...scheduledCard!.querySelectorAll<HTMLButtonElement>("button")]
    .find((entry) => entry.textContent?.includes("刪除"));
  const unscheduledDelete = [...unscheduledCard!.querySelectorAll<HTMLButtonElement>("button")]
    .find((entry) => entry.textContent?.includes("刪除"));
  expect(scheduledDelete).toBeUndefined();
  expect(unscheduledDelete).toBeDefined();
  vi.spyOn(window, "confirm").mockReturnValue(true);
  await click(unscheduledDelete!);
  await waitFor(() => expect(itinerary).toHaveTextContent("只有旅程擁有者可以更改行程安排。"));

  const assignedPlace = [...itinerary.querySelectorAll<HTMLButtonElement>(".plan-item-row")]
    .find((entry) => entry.textContent?.includes("FIRST"));
  expect(assignedPlace).toBeDefined();
  await click(assignedPlace!);
  const assignedDialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(assignedDialog).not.toHaveTextContent("從這天移出並列為待安排");
  const closeAssignedDialog = assignedDialog.querySelector<HTMLButtonElement>('button[aria-label="關閉"]');
  expect(closeAssignedDialog).toBeInTheDocument();
  await click(closeAssignedDialog!);
  await waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeInTheDocument());

  await click(button("幫我排順路", itinerary));
  await waitFor(() => expect(document.querySelector('[role="dialog"]')).toHaveTextContent("只有旅程擁有者可以排入、改期或移出行程"));
  expect([...document.querySelectorAll("button")].some((entry) => entry.textContent?.trim() === "使用這個順序")).toBe(false);
});

it("updates the offline wishlist order and day timezone after accepting a suggested day order", async () => {
  await mount();
  expect(snapshot().model.days[0]!.timeZone).toBe("Asia/Tokyo");
  await click(document.querySelector<HTMLButtonElement>('[data-trip-tab="itinerary"]')!);
  expect(button("安排這一天", document.getElementById("itinerary-segment-panel-daily")!)).toBeEnabled();
  await click(button("幫我排順路", document.getElementById("itinerary-segment-panel-daily")!));
  await waitFor(() => expect(button("使用這個順序")).toBeEnabled());
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
