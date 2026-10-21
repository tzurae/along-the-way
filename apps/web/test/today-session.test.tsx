// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, waitFor } from "@testing-library/react";
import type { TripPlaceDto } from "@along-the-way/contracts/trip-places";
import { DEFAULT_PLANNING_SETTINGS } from "@along-the-way/contracts/planning";
import { App } from "../src/App";
import { createTodayModel } from "../src/today-model";
import { TodaySnapshotStore } from "../src/today-snapshot";
import { todayActivity, todaySkeleton, todayTrip, todayUser, todayWishlist } from "./today-fixtures";

let root: Root;
let host: HTMLDivElement;
let trips = [todayTrip(), todayTrip("B", "11")];
let skeleton = todaySkeleton(trips[0]);
let dayVersion = 1;
let savedOrder = false;
let gate: Promise<void> | null = null;
let requests: string[] = [];
let liveVersion = 0;
let liveSources: Array<EventTarget & { url: string }> = [];
let previewFails = false;
let magicConsumeFailure: "network" | "terminal" | 403 | 429 | 500 | null = null;
let magicInviteOutcome = false;
let magicConfirmationRequired = false;
let inviteNetworkFailure = false;
let memberActionFailure = false;
let sessionFailure: "network" | 401 | 500 | null = null;
let logoutNetworkFailure = false;
let logoutTargetMismatch = false;
let logoutBodies: unknown[] = [];
let sessionUser = todayUser;
let tripPlacesOverride: TripPlaceDto[] | null = null;
let discoveryJobsStatus = 200;
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  localStorage.clear();
  discoveryJobsStatus = 200;
  trips = [todayTrip(), todayTrip("B", "11")];
  skeleton = todaySkeleton(trips[0]);
  dayVersion = 1;
  savedOrder = false; gate = null; requests = []; logoutBodies = [];
  liveVersion = 0; liveSources = []; previewFails = false;
  magicConsumeFailure = null;
  magicInviteOutcome = false;
  magicConfirmationRequired = false;
  inviteNetworkFailure = false;
  memberActionFailure = false;
  sessionFailure = null;
  logoutNetworkFailure = false;
  logoutTargetMismatch = false;
  sessionUser = todayUser;
  tripPlacesOverride = null;
  history.replaceState({}, "", "/?trip=A&tab=today&day=2026-10-21");
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", class extends EventTarget {
    constructor(readonly url: string) { super(); liveSources.push(this); }
    close = vi.fn();
  });
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    requests.push(input);
    if (gate && input.startsWith("/api/trips/A")) await gate;
    if (input === "/api/session") {
      if (sessionFailure === "network") throw new TypeError("Failed to fetch");
      if (sessionFailure) return reply({
        error: { code: sessionFailure === 401 ? "unauthorized" : "internal", message: "Session unavailable" },
      }, sessionFailure);
      return reply({ user: sessionUser });
    }
    if (input === "/api/logout" && init?.method === "POST") {
      logoutBodies.push(init.body ? JSON.parse(String(init.body)) : null);
      if (logoutNetworkFailure) throw new TypeError("Failed to fetch");
      if (logoutTargetMismatch) return reply({
        error: { code: "logout_target_mismatch", message: "Another account is signed in." },
      }, 409);
      return new Response(null, { status: 204 });
    }
    if (input === "/api/logout-everywhere" && init?.method === "POST") {
      return new Response(null, { status: 204 });
    }
    if (input === "/api/auth/magic-links/consume") {
      if (magicConfirmationRequired && !JSON.parse(String(init?.body)).confirm) {
        return reply({
          error: { code: "confirmation_required", message: "Confirm signing in." },
          targetEmail: "ne***@example.test",
          currentEmail: "ow***@example.test",
        }, 409);
      }
      if (magicConsumeFailure === "network") throw new TypeError("Failed to fetch");
      if (magicConsumeFailure) {
        const status = magicConsumeFailure === "terminal" ? 400 : magicConsumeFailure;
        return reply({
          error: {
            code: magicConsumeFailure === "terminal"
              ? "invalid_magic_link"
              : magicConsumeFailure === 429
                ? "rate_limited"
                : magicConsumeFailure === 403 ? "forbidden" : "internal",
            message: magicConsumeFailure === "terminal"
              ? "This sign-in link is invalid."
              : "Consume failed",
          },
        }, status);
      }
      return reply({
        user: todayUser,
        ...(magicInviteOutcome ? { inviteOutcome: "expired-or-revoked" } : {}),
      });
    }
    if (input === "/api/auth/magic-links") return reply({ message: "If eligible, sent." }, 202);
    if (input === "/api/auth/magic-links/verify-code") {
      expect(JSON.parse(String(init?.body))).toMatchObject({ email: "owner@example.test", code: "012345" });
      return reply({ user: todayUser });
    }
    if (input === "/api/trips") return reply({ trips });
    if (input === "/api/invites/accept") return reply({ error: { code: "used_invite", message: "This invitation was already used" } }, 409);
    if (input === "/api/trips/A/invites" && init?.method === "POST") {
      if (inviteNetworkFailure) throw new TypeError("Failed to fetch");
      return reply({ invite: { email: "companion@example.test" } }, 201);
    }
    if (input === "/api/trips/A/members/editor-user" && init?.method === "DELETE" && memberActionFailure) {
      return reply({ error: { code: "internal", message: "Database connection failed" } }, 500);
    }
    if (input === "/api/maps/config") return reply({ browserKey: null, mapId: null });
    const trip = trips.find((entry) => input.startsWith(`/api/trips/${entry.id}`));
    if (!trip) return reply({ error: { code: "trip_not_found", message: "Trip unavailable" } }, 404);
    if (input === `/api/trips/${trip.id}`) return reply({ trip });
    if (input.endsWith("/version")) return reply({ tripVersion: liveVersion, lastEventId: liveVersion ? "latest-event" : null });
    if (input.endsWith("/skeleton")) return reply({ skeleton: trip.id === "A" ? skeleton : todaySkeleton(trip) });
    if (input.endsWith("/trip-places")) return reply({ tripPlaces: trip.id === "A" ? (tripPlacesOverride ?? todayWishlist(savedOrder)) : [] });
    if (input.includes("/place-previews?")) return previewFails
      ? reply({ error: { code: "provider_unavailable", message: "Preview unavailable" } }, 503)
      : reply({ previews: [] });
    if (input.endsWith("/places/legacy-UNSCHEDULED") && init?.method === "DELETE") {
      return reply({ error: { code: "forbidden", message: "server copy" } }, 403);
    }
    if (input.endsWith("/route") && init?.method === "POST") {
      const routeInput = JSON.parse(String(init.body)) as { order: "current" | "suggested"; transit?: string };
      const order = routeInput.order;
      expect(routeInput).toEqual(order === "suggested" ? { order: "suggested", transit: "cached" } : { order: "current" });
      const orderedTripPlaceIds = order === "suggested" ? ["SECOND", "FIRST"] : ["FIRST", "SECOND"];
      const wishlist = todayWishlist();
      return reply({ route: {
        dayId: "day21",
        date: "2026-10-21",
        version: dayVersion,
        order,
        orderedTripPlaceIds,
        startsAt: null,
        endsAt: null,
        stops: orderedTripPlaceIds.map((id, index) => {
          const place = wishlist.find((entry) => entry.id === id)!;
          return {
            tripPlaceId: id,
            name: place.name,
            latitude: place.latitude,
            longitude: place.longitude,
            providerPlaceId: place.providerPlaceId,
            metersFromPrevious: index === 0 ? null : 100,
            minutesFromPrevious: null,
            linesFromPrevious: [],
          };
        }),
        metersToEnd: null,
        totalMeters: order === "suggested" ? 100 : 200,
        travelSource: "straight_line",
        transitProvider: null,
        routeShapesAvailable: false,
        minutesToEnd: null,
        linesToEnd: [],
        totalMinutes: null,
        transitMatrix: [],
        transitCallsNeeded: 0,
        transitCacheDays: null,
      } });
    }
    if (input.endsWith("/place-order") && init?.method === "PUT") {
      const body: unknown = JSON.parse(String(init.body));
      expect(body).toEqual({
        orderedTripPlaceIds: ["SECOND", "FIRST"],
        expectedVersion: dayVersion,
      });
      savedOrder = true;
      return reply({ orderedTripPlaceIds: ["SECOND", "FIRST"], version: dayVersion + 1 });
    }
    if (input.endsWith("/arrangement")) {
      const body: unknown = JSON.parse(String(init?.body));
      expect(init?.method).toBe("PUT");
      expect(body).toEqual({
        orderedTripPlaceIds: ["SECOND", "FIRST"],
        expectedVersion: dayVersion,
      });
      savedOrder = true;
      return reply({ tripPlaces: todayWishlist(true) });
    }
    if (input.endsWith("/discovery/jobs/latest")) {
      return discoveryJobsStatus === 200 ? reply({ job: null }) : reply({ error: { code: "internal_error", message: "boom" } }, discoveryJobsStatus);
    }
    if (input.endsWith("/planning-load")) {
      return reply({ days: [], estimates: {}, counts: { flexible: 0, fixedSelected: 0, days: 0, aiPending: 0 }, settingsVersion: 1 });
    }
    if (input.endsWith("/planning-settings")) {
      return reply({ raw: null, resolved: DEFAULT_PLANNING_SETTINGS, defaults: DEFAULT_PLANNING_SETTINGS, version: 1 });
    }
    if (input.endsWith("/discovery")) return reply({ discovery: { brief: null, latestRun: null, proposals: [], decided: [], modelAvailable: false, placeProviderAvailable: false } });
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


it("SEC-01 shows both masked accounts and waits for explicit confirmation before switching", async () => {
  await mount();
  await waitFor(() => expect(snapshot()).toBeTruthy());
  const previousSnapshot = snapshot();
  magicConfirmationRequired = true;
  history.replaceState({}, "", "/?trip=A&tab=today#magicToken=foreign-token");
  await act(async () => window.dispatchEvent(new HashChangeEvent("hashchange")));
  await waitFor(() => expect(document.body).toHaveTextContent("這個連結會以 ne***@example.test 登入這個裝置"));
  expect(document.querySelector('[role="alert"]')).toHaveTextContent("目前登入的是 ow***@example.test，繼續會登出");
  expect(document.querySelector("#auth-title")).toHaveFocus();
  expect(requests.filter((url) => url === "/api/auth/magic-links/consume")).toHaveLength(1);
  expect(snapshot()).toEqual(previousSnapshot);
  await click(button("確認登入"));
  await waitFor(() => expect(document.querySelector('[data-trip-tab="today"]')).toBeInTheDocument());
  const consumes = vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/auth/magic-links/consume");
  expect(consumes).toHaveLength(2);
  expect(JSON.parse(String(consumes[1]![1]!.body))).toEqual({ token: "foreign-token", confirm: true });
});

it("SEC-01 cancellation preserves the original account without consuming the foreign link", async () => {
  await mount();
  magicConfirmationRequired = true;
  history.replaceState({}, "", "/?trip=A&tab=today#magicToken=cancelled-token");
  await act(async () => window.dispatchEvent(new HashChangeEvent("hashchange")));
  await waitFor(() => expect(document.body).toHaveTextContent("確認登入這個裝置"));
  await click(button("取消，保留目前帳號"));
  await waitFor(() => expect(document.querySelector('[data-trip-tab="today"]')).toBeInTheDocument());
  expect(requests.filter((url) => url === "/api/auth/magic-links/consume")).toHaveLength(1);
  expect(location.hash).not.toContain("magicToken");
});

it("SEC-01 signs in through the public code-entry form", async () => {
  new TodaySnapshotStore(localStorage).setLocallySignedOut(true);
  await mount();
  await act(async () => {
    fireEvent.change(document.querySelector("#auth-email")!, { target: { value: "owner@example.test" } });
    fireEvent.submit(button("寄送登入連結").closest("form")!);
  });
  await waitFor(() => expect(document.querySelector("#auth-code")).toBeInTheDocument());
  await act(async () => {
    fireEvent.change(document.querySelector("#auth-code")!, { target: { value: "012345" } });
    fireEvent.submit(button("使用登入碼登入").closest("form")!);
  });
  await waitFor(() => expect(document.querySelector('[data-trip-tab="today"]')).toBeInTheDocument());
  expect(requests.filter((url) => url === "/api/auth/magic-links/verify-code")).toHaveLength(1);
  expect(new TodaySnapshotStore(localStorage).isLocallySignedOut()).toBe(false);
});

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

it.each(["online", "button"] as const)(
  "recovers a signed-in snapshot through %s after a 500 magic-link consume failure and an offline cycle",
  async (recovery) => {
    await mount();
    await waitFor(() => expect(snapshot()).toBeTruthy());
    magicConsumeFailure = 500;

    history.replaceState({}, "", "/?trip=A&tab=today#magicToken=session-preserving-token");
    await act(async () => window.dispatchEvent(new HashChangeEvent("hashchange")));

    await waitFor(() => expect(button("重試登入")).toBeEnabled());
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    await act(async () => window.dispatchEvent(new Event("offline")));
    await waitFor(() => expect(document.body).toHaveTextContent("離線資料"));
    expect(button("重新連線並同步")).toBeEnabled();
    const sessionReads = requests.filter((request) => request === "/api/session").length;
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });

    if (recovery === "online") {
      await act(async () => window.dispatchEvent(new Event("online")));
    } else {
      await click(button("重新連線並同步"));
    }

    await waitFor(() => expect(document.querySelector(".atw-account-trigger")).toHaveTextContent(todayUser.email));
    expect(requests.filter((request) => request === "/api/session").length).toBeGreaterThan(sessionReads);
    expect(document.body).not.toHaveTextContent("離線資料");
  },
);

it("keeps a rate-limited magic token and explains when to retry", async () => {
  await mount();
  magicConsumeFailure = 429;
  history.replaceState({}, "", "/?trip=A&tab=today#magicToken=limited-token");

  await act(async () => {
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });

  await waitFor(() => expect(document.querySelector('[role="alert"]')).toHaveTextContent(
    "登入嘗試次數過多，請稍後再試；登入連結仍會保留。",
  ));
  expect(button("重試登入")).toBeEnabled();
  expect(new URLSearchParams(location.hash.slice(1)).get("magicToken")).toBe("limited-token");
});

it("localizes terminal magic-link failures without rendering server English", async () => {
  await mount();
  magicConsumeFailure = "terminal";
  history.replaceState({}, "", "/?trip=A&tab=today#magicToken=invalid-token");

  await act(async () => {
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });

  await waitFor(() => expect(document.querySelector('[role="alert"]')).toHaveTextContent(
    "這個登入連結無效。 請寄一封新的登入信。",
  ));
  expect(document.querySelector('[role="alert"]')).not.toHaveTextContent("This sign-in link is invalid.");
  expect(new URLSearchParams(location.hash.slice(1)).has("magicToken")).toBe(false);
});

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
  expect(today).toHaveTextContent("FIRST");
  expect(today).toHaveTextContent("SECOND");
  expect(today).not.toHaveTextContent("今天想去（未排時間）");
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

it("updates the already-mounted overview when Today opens one day for reordering", async () => {
  await mount();
  const overview = document.getElementById("itinerary-segment-panel-daily")!;
  expect(overview.querySelectorAll(".day-column")).toHaveLength(3);

  await click(button("調整順序", document.getElementById("trip-panel-today")!));

  expect(document.getElementById("itinerary-segment-panel-daily")).toBe(overview);
  await waitFor(() => expect(overview.querySelectorAll(".day-column")).toHaveLength(1));
  expect(overview.querySelector('.day-column[data-date="2026-10-21"]')).toBeInTheDocument();
  expect(new URLSearchParams(location.search).get("days")).toBe("2026-10-21");
  expect([...overview.querySelectorAll<HTMLButtonElement>(".plan-day-filter button")]
    .find((entry) => entry.getAttribute("aria-pressed") === "true")).toHaveTextContent("10/21");

  await click(document.querySelector<HTMLButtonElement>('[data-trip-tab="today"]')!);
  const day = document.querySelector<HTMLSelectElement>("#trip-panel-today select")!;
  fireEvent.change(day, { target: { value: "2026-10-22" } });
  await click(button("調整順序", document.getElementById("trip-panel-today")!));
  await waitFor(() => expect(overview.querySelectorAll(".day-column")).toHaveLength(1));
  expect(overview.querySelector('.day-column[data-date="2026-10-22"]')).toBeInTheDocument();
  expect(new URLSearchParams(location.search).get("days")).toBe("2026-10-22");
});

it("clears a Today overview filter when switching trips", async () => {
  await mount();
  await click(button("調整順序", document.getElementById("trip-panel-today")!));
  expect(new URLSearchParams(location.search).get("days")).toBe("2026-10-21");

  await switchTrip("Trip B");

  expect(new URLSearchParams(location.search).has("days")).toBe(false);
  await click(document.querySelector<HTMLButtonElement>('[data-trip-tab="itinerary"]')!);
  await waitFor(() => expect(document.querySelectorAll("#itinerary-segment-panel-daily .day-column")).toHaveLength(3));
});

it("keeps collapsed desktop rail children inert until their parent tab opens", async () => {
  await mount();
  const expander = document.querySelector<HTMLElement>('.atw-railnav__expander [data-itinerary-child="daily"]')!.parentElement!.parentElement!;
  expect(expander).toHaveAttribute("inert");
  expect(expander).toHaveAttribute("data-open", "false");

  await click(document.querySelector<HTMLButtonElement>('[data-trip-tab="itinerary"]')!);

  expect(expander).not.toHaveAttribute("inert");
  expect(expander).toHaveAttribute("data-open", "true");
});

it("refreshes the itinerary after reconnecting from Today without a reload loop", async () => {
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
  await click(button("重新連線並同步", host));
  await click(document.querySelector<HTMLButtonElement>('button[data-trip-tab="itinerary"]')!);
  expect(document.getElementById("itinerary-segment-panel-daily")).not.toHaveTextContent("REMOVED_ACTIVITY");
  expect(document.getElementById("itinerary-segment-panel-daily")).not.toHaveTextContent("REMOVED_LODGING");
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
  // Production shape: skeleton PlaceDto.id (legacy) differs from the wishlist canonical placeId.
  const legacyPlace = skeleton.places[0]!;
  skeleton = {
    ...skeleton,
    places: [
      { ...legacyPlace, id: "legacy-FIRST", name: "Scheduled canonical" },
      { ...legacyPlace, id: "legacy-UNSCHEDULED", name: "Unscheduled canonical" },
    ],
  };
  const [scheduled, pending] = todayWishlist();
  tripPlacesOverride = [
    { ...scheduled!, placeId: "canonical-FIRST", legacyPlaceId: "legacy-FIRST" },
    { ...pending!, assignedDayId: null, dayPosition: null },
    {
      ...pending!,
      id: "UNSCHEDULED",
      placeId: "canonical-UNSCHEDULED",
      legacyPlaceId: "legacy-UNSCHEDULED",
      name: "Unscheduled canonical",
      selectedForItinerary: false,
      assignedDayId: null,
      dayPosition: null,
    },
  ];
  await mount();

  const today = document.getElementById("trip-panel-today")!;
  expect([...today.querySelectorAll("button")].some((entry) => entry.textContent?.includes("調整順序"))).toBe(false);

  await click(document.querySelector<HTMLButtonElement>('[data-trip-tab="itinerary"]')!);
  const itinerary = document.getElementById("itinerary-segment-panel-daily")!;
  expect(itinerary.textContent?.match(/只有旅程擁有者，或擁有者開放的編輯者，可以排入、改期或移出行程/g)).toHaveLength(1);
  for (const ownerAction of ["安排日期", "安排這一天", "加入地點", "從這天移出並列為待安排"]) {
    expect([...itinerary.querySelectorAll("button")].some((entry) => entry.textContent?.includes(ownerAction))).toBe(false);
  }


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
  await waitFor(() => expect(document.querySelector('[role="dialog"]')).toHaveTextContent("只有旅程擁有者，或擁有者開放的編輯者，可以排入、改期或移出行程"));
  expect([...document.querySelectorAll("button")].some((entry) => entry.textContent?.trim() === "使用這個順序")).toBe(false);
});

it("updates the offline wishlist order and day timezone after accepting a suggested day order", async () => {
  await mount();
  expect(snapshot().model.days[0]!.timeZone).toBe("Asia/Tokyo");
  await click(document.querySelector<HTMLButtonElement>('[data-trip-tab="itinerary"]')!);
  expect(button("安排這一天", document.getElementById("itinerary-segment-panel-daily")!)).toBeEnabled();
  await click(button("幫我排順路", document.getElementById("itinerary-segment-panel-daily")!));
  const save = await waitFor(() => {
    const candidate = button("儲存為第 1 天的安排");
    expect(candidate).toBeEnabled();
    return candidate;
  });
  await click(save);
  await waitFor(() => {
    expect(savedOrder).toBe(true);
    expect(snapshot().model.days[0]!.wishlist.map((place) => place.id)).toEqual(["SECOND", "FIRST"]);
    expect(snapshot().model.days[0]!.timeZone).toBe("Europe/Paris");
  });
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

it("handles member action failures with localized feedback instead of an unhandled rejection", async () => {
  trips[0]!.members.push({
    id: "editor-member",
    userId: "editor-user",
    email: "editor@example.test",
    displayName: null,
    role: "editor",
  });
  trips[0]!.memberCount = 2;
  memberActionFailure = true;
  await mount();
  await click(document.querySelector<HTMLButtonElement>('[data-trip-tab="members"]')!);
  const panel = document.getElementById("trip-panel-members")!;
  await click(button("移除", panel));

  await waitFor(() => expect(document.querySelector(".app-toast")).toHaveTextContent("發生未預期的錯誤。"));
  expect(document.querySelector(".app-toast")).not.toHaveTextContent("Database connection failed");
});

it("renders an unsafe itinerary item source as text instead of an external link", async () => {
  const unsafeItem = { ...todayActivity(), sourceUrl: "javascript:alert(document.domain)" };
  skeleton = todaySkeleton(trips[0]!, [unsafeItem]);

  await mount();
  await click(document.querySelector<HTMLButtonElement>('[data-trip-tab="itinerary"]')!);

  const itinerary = document.getElementById("itinerary-segment-panel-daily")!;
  const itemTrigger = [...itinerary.querySelectorAll<HTMLButtonElement>("button")]
    .find((entry) => entry.textContent?.includes(unsafeItem.title));
  expect(itemTrigger).toBeDefined();
  await click(itemTrigger!);
  const card = await waitFor(() => {
    const item = document.querySelector<HTMLElement>(`[data-item-id="${unsafeItem.id}"].itinerary-card`);
    expect(item).toBeInTheDocument();
    return item!;
  });
  expect(card).toHaveTextContent("官方來源");
  expect([...card.querySelectorAll("a")].some((link) => link.textContent === "官方來源")).toBe(false);
});

it.each([
  ["network error", "network", "button"],
  ["500 response", 500, "online"],
  ["network error", "network", "focus"],
  ["500 response", 500, "visibilitychange"],
] as const)("shows reconnect instead of sign-in after a cold-start %s and recovers through %s without a magic link", async (_label, failure, recovery) => {
  sessionFailure = failure;
  await mount();

  await waitFor(() => expect(button("重新連線")).toBeInTheDocument());
  expect(document.body).toHaveTextContent("暫時連不上伺服器，你的登入還在。");
  expect(document.querySelector('input[type="email"]')).toBeNull();
  expect(requests).not.toContain("/api/auth/magic-links");

  sessionFailure = null;
  if (recovery === "button") {
    await click(button("重新連線"));
  } else if (recovery === "visibilitychange") {
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  } else {
    await act(async () => window.dispatchEvent(new Event(recovery)));
  }

  await waitFor(() => expect(document.querySelector(".atw-account-trigger")).toHaveTextContent(todayUser.email));
  expect(requests).not.toContain("/api/auth/magic-links");
});

it("shows sign-in after a 401 and does not retry session restore on reconnect events", async () => {
  sessionFailure = 401;
  await mount();

  await waitFor(() => expect(button("寄送登入連結")).toBeInTheDocument());
  const sessionReads = requests.filter((request) => request === "/api/session").length;
  await act(async () => {
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
  });
  expect(requests.filter((request) => request === "/api/session")).toHaveLength(sessionReads);
});

it.each(["network", 500] as const)("keeps the stored account and snapshot after a transient %s session failure", async (failure) => {
  const store = new TodaySnapshotStore(localStorage);
  const stored = store.save(
    todayUser.id,
    createTodayModel(trips[0]!, skeleton, todayWishlist(), todayUser.id),
    Date.parse("2026-10-21T00:00:00Z"),
  );
  expect(stored).not.toBeNull();
  sessionFailure = failure;

  await mount();

  await waitFor(() => expect(document.body).toHaveTextContent("離線資料"));
  expect(store.lastAccount()).toBe(todayUser.id);
  expect(store.read(todayUser.id, "A")).toEqual(stored);
  expect(document.querySelector('input[type="email"]')).toBeNull();
});

it("does not reload the whole trip when only the 調查 status read fails", async () => {
  discoveryJobsStatus = 500;
  await mount();
  await waitFor(() => expect(requests.some((path) => path.endsWith("/discovery/jobs/latest"))).toBe(true));
  const tripReads = () => requests.filter((path) => path === "/api/trips/A").length;
  const before = tripReads();
  // A failed projection read is retried by re-reading the trip after about a second; the
  // optional status poll must not start that cycle.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_500)); });
  expect(tripReads()).toBe(before);
  expect(document.querySelector('[role="alert"]')).toBeNull();
});

it("shows localized copy instead of a browser network error for a failed mutation", async () => {
  await mount();
  inviteNetworkFailure = true;
  await click(document.querySelector<HTMLButtonElement>('[data-trip-tab="members"]')!);
  await click(document.querySelector<HTMLButtonElement>('[data-members-child="invites"]')!);
  const panel = document.getElementById("trip-panel-members")!;
  const input = panel.querySelector<HTMLInputElement>('input[type="email"]')!;
  fireEvent.change(input, { target: { value: "companion@example.test" } });
  fireEvent.submit(input.form!);

  await waitFor(() => expect(document.querySelector(".app-toast")).toHaveTextContent("無法完成要求。"));
  expect(document.querySelector(".app-toast")).not.toHaveTextContent("Failed to fetch");
});

it("clears private state when another tab signs out of the shared browser account", async () => {
  await mount();
  expect(snapshot().model.tripId).toBe("A");

  localStorage.setItem("along-the-way:locally-signed-out", "true");
  await act(async () => {
    window.dispatchEvent(new StorageEvent("storage", {
      key: "along-the-way:locally-signed-out",
      newValue: "true",
    }));
  });

  await waitFor(() => expect(button("寄送登入連結")).toBeInTheDocument());
  expect(new TodaySnapshotStore(localStorage).read(todayUser.id, "A")).toBeNull();
  expect(document.body).not.toHaveTextContent("Trip A");
});

it("clears account-scoped filters and onboarding state when signing out", async () => {
  await mount();
  localStorage.setItem("along-the-way:place-filters:account:A:wishlist", "{\"query\":\"private search\"}");
  localStorage.setItem("along-the-way:trip-onboarding:account:A", "dismissed");

  await click(document.querySelector<HTMLButtonElement>(".atw-account-trigger")!);
  await click(button("登出"));

  await waitFor(() => expect(button("寄送登入連結")).toBeInTheDocument());
  expect(requests).toContain("/api/logout");
  expect(localStorage.getItem("along-the-way:place-filters:account:A:wishlist")).toBeNull();
  expect(localStorage.getItem("along-the-way:trip-onboarding:account:A")).toBeNull();
});

it("clears the previous account's filters and onboarding state when the server session changes account", async () => {
  const previousAccount = "previous-account";
  localStorage.setItem("along-the-way:today-account", previousAccount);
  localStorage.setItem(`along-the-way:place-filters:${previousAccount}:A:wishlist`, "{\"query\":\"old account\"}");
  localStorage.setItem(`along-the-way:trip-onboarding:${previousAccount}:A`, "dismissed");

  await mount();

  await waitFor(() => expect(document.querySelector('[data-trip-tab="today"]')).toBeInTheDocument());
  expect(localStorage.getItem(`along-the-way:place-filters:${previousAccount}:A:wishlist`)).toBeNull();
  expect(localStorage.getItem(`along-the-way:trip-onboarding:${previousAccount}:A`)).toBeNull();
});

it("offers logout everywhere and signs the current browser out after revoking every session", async () => {
  await mount();

  await click(document.querySelector<HTMLButtonElement>(".atw-account-trigger")!);
  await click(button("登出所有裝置"));

  await waitFor(() => expect(button("寄送登入連結")).toBeInTheDocument());
  expect(requests.filter((entry) => entry === "/api/logout-everywhere")).toHaveLength(1);
});

it("keeps a failed server logout pending, warns visibly, and replays the bound account when online", async () => {
  await mount();
  logoutNetworkFailure = true;

  await click(document.querySelector<HTMLButtonElement>(".atw-account-trigger")!);
  await click(button("登出"));

  await waitFor(() => expect(button("寄送登入連結")).toBeInTheDocument());
  expect(document.querySelector('[role="alert"]')).toHaveTextContent("伺服器端登出尚未完成；恢復連線後會自動重試。");
  expect(localStorage.getItem("along-the-way:pending-server-logout")).toBe(todayUser.id);
  expect(logoutBodies).toEqual([{ userId: todayUser.id }]);
  logoutNetworkFailure = false;
  await act(async () => {
    window.dispatchEvent(new Event("online"));
  });
  await waitFor(() => expect(localStorage.getItem("along-the-way:pending-server-logout")).toBeNull());
  expect(logoutBodies).toEqual([{ userId: todayUser.id }, { userId: todayUser.id }]);
});

it("queues offline logout for the current account and replays that target after connectivity returns", async () => {
  await mount();
  Object.defineProperty(navigator, "onLine", { configurable: true, value: false });

  await click(document.querySelector<HTMLButtonElement>(".atw-account-trigger")!);
  await click(button("登出"));

  expect(requests).not.toContain("/api/logout");
  expect(localStorage.getItem("along-the-way:pending-server-logout")).toBe(todayUser.id);
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  await act(async () => {
    window.dispatchEvent(new Event("online"));
  });
  await waitFor(() => expect(localStorage.getItem("along-the-way:pending-server-logout")).toBeNull());
  expect(logoutBodies).toEqual([{ userId: todayUser.id }]);
});

it("still sends online logout when durable pending storage is full", async () => {
  await mount();
  const setItem = localStorage.setItem.bind(localStorage);
  const storageWrite = vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => {
    if (key === "along-the-way:pending-server-logout") throw new DOMException("Storage full", "QuotaExceededError");
    setItem(key, value);
  });

  await click(document.querySelector<HTMLButtonElement>(".atw-account-trigger")!);
  await click(button("登出"));

  await waitFor(() => expect(button("寄送登入連結")).toBeInTheDocument());
  expect(logoutBodies).toEqual([{ userId: todayUser.id }]);
  expect(storageWrite).toHaveBeenCalledWith("along-the-way:pending-server-logout", todayUser.id);
  storageWrite.mockRestore();
});

it("drops a deferred target mismatch without signing out the newer account", async () => {
  const newerUser = { ...todayUser, id: "new-account", email: "new-account@example.test" };
  sessionUser = newerUser;
  trips = trips.map((trip) => ({
    ...trip,
    members: trip.members.map((member) => member.userId === todayUser.id
      ? { ...member, userId: newerUser.id, email: newerUser.email }
      : member),
  }));
  skeleton = todaySkeleton(trips[0]!);
  localStorage.setItem("along-the-way:pending-server-logout", todayUser.id);
  localStorage.setItem("along-the-way:locally-signed-out", "true");
  logoutTargetMismatch = true;

  await mount();

  await waitFor(() => expect(document.querySelector(".atw-account-trigger")).toHaveTextContent(newerUser.email));
  expect(logoutBodies).toEqual([{ userId: todayUser.id }]);
  expect(localStorage.getItem("along-the-way:pending-server-logout")).toBeNull();
  expect(localStorage.getItem("along-the-way:locally-signed-out")).toBeNull();
  expect(document.querySelector('input[type="email"]')).toBeNull();
});

it("restores a newer account after target mismatch even when this tab previously consumed a magic link", async () => {
  history.replaceState({}, "", "/?trip=A&tab=today#magicToken=first-account-token");
  await mount();
  await waitFor(() => expect(document.querySelector(".atw-account-trigger")).toHaveTextContent(todayUser.email));
  expect(requests.filter((url) => url === "/api/auth/magic-links/consume")).toHaveLength(1);

  Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
  await click(document.querySelector<HTMLButtonElement>(".atw-account-trigger")!);
  await click(button("登出"));
  await waitFor(() => expect(button("寄送登入連結")).toBeInTheDocument());

  const newerUser = { ...todayUser, id: "new-account", email: "new-account@example.test" };
  sessionUser = newerUser;
  trips = trips.map((trip) => ({
    ...trip,
    members: trip.members.map((member) => member.userId === todayUser.id
      ? { ...member, userId: newerUser.id, email: newerUser.email }
      : member),
  }));
  skeleton = todaySkeleton(trips[0]!);
  logoutTargetMismatch = true;
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  await act(async () => {
    window.dispatchEvent(new Event("online"));
  });

  await waitFor(() => expect(document.querySelector(".atw-account-trigger")).toHaveTextContent(newerUser.email));
  expect(logoutBodies).toEqual([{ userId: todayUser.id }]);
  expect(requests.filter((url) => url === "/api/auth/magic-links/consume")).toHaveLength(1);
  expect(localStorage.getItem("along-the-way:pending-server-logout")).toBeNull();
  expect(localStorage.getItem("along-the-way:locally-signed-out")).toBeNull();
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
