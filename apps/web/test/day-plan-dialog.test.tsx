// @vitest-environment jsdom
import { type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DayRouteDto, DayRouteOrder, DayRouteShapesResponse, DayRouteStopDto } from "@along-the-way/contracts/day-plans";
import type { TripPlaceDto } from "@along-the-way/contracts/trip-places";
import { DayPlanDialog, type PlannedDay } from "../src/DayPlanDialog";
import { todayWishlist } from "./today-fixtures";

vi.mock("@vis.gl/react-google-maps", () => ({
  APIProvider: ({ apiKey, children }: { apiKey: string; children: ReactNode }) => (
    <div data-testid="google-api-provider" data-api-key={apiKey}>{children}</div>
  ),
  Map: ({ children }: { children: ReactNode }) => <div data-testid="google-map">{children}</div>,
  AdvancedMarker: ({ children }: { children: ReactNode }) => <>{children}</>,
  Pin: () => <span />,
  useMap: () => null,
}));

interface RequestCall {
  url: string;
  options?: RequestInit;
}

type RouteOptions = {
  dayId?: string;
  date?: string;
  version?: number;
  ids?: string[];
  totalMeters?: number;
  names?: Record<string, string>;
  transitCallsNeeded?: number;
  transitProvider?: DayRouteDto["transitProvider"];
  travelSource?: DayRouteDto["travelSource"];
  routeShapesAvailable?: boolean;
};

function route(order: DayRouteOrder, options: RouteOptions = {}): DayRouteDto {
  const ids = options.ids ?? (order === "suggested" ? ["b", "a"] : ["a", "b"]);
  return {
    dayId: options.dayId ?? "day-1",
    date: options.date ?? "2026-10-21",
    version: options.version ?? 7,
    order,
    orderedTripPlaceIds: ids,
    startsAt: null,
    endsAt: null,
    stops: ids.map((tripPlaceId, index) => ({
      tripPlaceId,
      name: options.names?.[tripPlaceId] ?? `地點 ${tripPlaceId}`,
      latitude: 34.9 + index * 0.01,
      longitude: 135.7 + index * 0.01,
      providerPlaceId: `google-${tripPlaceId}`,
      metersFromPrevious: index === 0 ? null : 1_000,
      minutesFromPrevious: null,
      linesFromPrevious: [],
      estimatedMoveMinutesFromPrevious: null,
      stayMinutes: null,
      stayEstimated: false,
    })),
    metersToEnd: null,
    totalMeters: options.totalMeters ?? Math.max(0, ids.length - 1) * 1_000,
    travelSource: options.travelSource ?? "straight_line",
    transitProvider: options.transitProvider ?? null,
    routeShapesAvailable: options.routeShapesAvailable ?? false,
    minutesToEnd: null,
    linesToEnd: [],
    totalMinutes: null,
    transitMatrix: [],
    transitCallsNeeded: options.transitCallsNeeded ?? 0,
    transitCacheDays: null,
    dayStartMinute: null,
    fixedMinutes: null,
    estimatedMoveMinutesToEnd: null,
  };
}

function googleSuggestion(version = 7): DayRouteDto {
  const suggestion = route("suggested", {
    version,
    transitCallsNeeded: 2,
    transitProvider: "google_routes",
    travelSource: "google_routes",
    routeShapesAvailable: true,
  });
  const [from, to] = suggestion.stops;
  return {
    ...suggestion,
    stops: [
      from!,
      { ...to!, minutesFromPrevious: 17, linesFromPrevious: ["大眾運輸／步行"] },
    ],
    totalMinutes: 17,
    transitMatrix: [{
      fromId: from!.tripPlaceId,
      toId: to!.tripPlaceId,
      fromLatitude: from!.latitude,
      fromLongitude: from!.longitude,
      toLatitude: to!.latitude,
      toLongitude: to!.longitude,
      minutes: 17,
      lines: ["大眾運輸／步行"],
    }],
  };
}

function inputOf(options?: RequestInit) {
  return options?.body
    ? JSON.parse(String(options.body)) as { order: DayRouteOrder; transit?: "cached" | "fetch"; maxTransitCalls?: number; orderedTripPlaceIds?: string[] }
    : null;
}

function immediateRequest(overrides?: {
  current?: DayRouteDto;
  suggested?: DayRouteDto;
  routeShapes?: DayRouteShapesResponse;
  custom?(ids: string[]): DayRouteDto;
  mutate?(call: RequestCall): Promise<unknown>;
}) {
  const calls: RequestCall[] = [];
  const request = async <T,>(url: string, options?: RequestInit): Promise<T> => {
    const call = { url, options };
    calls.push(call);
    if (url === "/api/maps/config") return { browserKey: null, mapId: null } as T;
    if (url === "/api/maps/load") return undefined as T;
    if (options?.method === "PUT") return await overrides?.mutate?.(call) as T;
    if (url.endsWith("/route-shapes") && overrides?.routeShapes) return overrides.routeShapes as T;
    if (url.endsWith("/route")) {
      const input = inputOf(options)!;
      if (input.order === "current") return { route: overrides?.current ?? route("current") } as T;
      if (input.order === "suggested") return { route: overrides?.suggested ?? route("suggested") } as T;
      const ids = input.orderedTripPlaceIds ?? [];
      return { route: overrides?.custom?.(ids) ?? route("custom", { ids }) } as T;
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  return { request, calls };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const day1: PlannedDay = { id: "day-1", date: "2026-10-21", label: "第 1 天" };
const day2: PlannedDay = { id: "day-2", date: "2026-10-22", label: "第 2 天" };

function dialog(request: <T>(url: string, options?: RequestInit) => Promise<T>, day: PlannedDay | null = day1) {
  return (
    <DayPlanDialog
      tripId="trip-1"
      day={day}
      canArrange
      request={request}
      onClose={() => {}}
      onOrderSaved={async () => {}}
      places={[]}
      onPlaceUpdated={async () => {}}
    />
  );
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.stubGlobal("crypto", { randomUUID: vi.fn(() => `key-${Math.random()}`) });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("day-plan view tabs", () => {
  it("uses roving keyboard focus and uniquely wired tab and panel ids in both columns", async () => {
    const { request } = immediateRequest();
    render(dialog(request));
    const regions = [
      await screen.findByRole("region", { name: "已儲存的順序" }),
      screen.getByRole("region", { name: "可以儲存的順序" }),
    ];

    const ids: string[] = [];
    for (const region of regions) {
      const routeTab = within(region).getByRole("tab", { name: "路線" });
      const mapTab = within(region).getByRole("tab", { name: "Google Map" });
      routeTab.focus();
      fireEvent.keyDown(routeTab, { key: "ArrowRight" });
      expect(mapTab).toHaveFocus();
      expect(mapTab).toHaveAttribute("aria-selected", "true");
      expect(within(region).getByRole("tabpanel", { name: "Google Map" })).not.toHaveAttribute("hidden");

      fireEvent.keyDown(mapTab, { key: "ArrowLeft" });
      expect(routeTab).toHaveFocus();
      expect(routeTab).toHaveAttribute("aria-selected", "true");
      expect(within(region).getByRole("tabpanel", { name: "路線" })).not.toHaveAttribute("hidden");

      for (const tab of [routeTab, mapTab]) {
        const panelId = tab.getAttribute("aria-controls")!;
        const panel = document.getElementById(panelId)!;
        ids.push(tab.id, panelId);
        expect(panel).not.toBeNull();
        expect(panel).toHaveAttribute("aria-labelledby", tab.id);
      }
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("opens with cached transit data instead of spending provider quota", async () => {
    const { request, calls } = immediateRequest();
    render(dialog(request));
    await screen.findByRole("region", { name: "可以儲存的順序" });

    expect(calls.filter((call) => call.url.endsWith("/route")).map((call) => inputOf(call.options)))
      .toEqual([{ order: "current" }, { order: "suggested", transit: "cached" }]);
  });

  it("binds a paid transit fetch to the missing-leg count the member approved", async () => {
    const { request, calls } = immediateRequest({
      suggested: route("suggested", { transitCallsNeeded: 3 }),
    });
    render(dialog(request));
    fireEvent.click(await screen.findByRole("button", { name: "用電車時間排（約 3 次額度）" }));

    await waitFor(() => expect(calls.some((call) => {
      const input = inputOf(call.options);
      return input?.transit === "fetch" && input.maxTransitCalls === 3;
    })).toBe(true));
  });

  it("uses Google copy and attribution instead of NAVITIME for a Google day", async () => {
    const { request } = immediateRequest({
      suggested: route("suggested", {
        transitCallsNeeded: 4,
        transitProvider: "google_routes",
        routeShapesAvailable: true,
      }),
    });
    render(dialog(request));

    expect(await screen.findByRole("button", { name: "用大眾運輸時間排（約 4 次）" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /用電車時間排/ })).not.toBeInTheDocument();
    const candidate = screen.getByRole("region", { name: "可以儲存的順序" });
    fireEvent.click(within(candidate).getByRole("tab", { name: "Google Map" }));
    expect(within(candidate).getByText("路線由 Google 提供。")).toBeInTheDocument();
    expect(within(candidate).queryByText(/NAVITIME/)).not.toBeInTheDocument();
  });

  it("never asks for paid route shapes from the saved side", async () => {
    const { request, calls } = immediateRequest({
      current: route("current", {
        transitProvider: "google_routes",
        routeShapesAvailable: true,
      }),
      suggested: route("suggested", {
        transitProvider: "google_routes",
        routeShapesAvailable: true,
      }),
    });
    render(dialog(request));
    const saved = await screen.findByRole("region", { name: "已儲存的順序" });

    fireEvent.click(within(saved).getByRole("tab", { name: "Google Map" }));

    expect(calls.filter((call) => call.url.endsWith("/route-shapes"))).toHaveLength(0);
    const candidate = screen.getByRole("region", { name: "可以儲存的順序" });
    fireEvent.click(within(candidate).getByRole("tab", { name: "Google Map" }));
    expect(calls.filter((call) => call.url.endsWith("/route-shapes"))).toHaveLength(1);
  });
});

describe("NAVITIME bus-likely leg guidance", () => {
  it("shows the warning legend only for the drawn long walk", async () => {
    const suggested = route("suggested", {
      names: { b: "上賀茂神社", a: "鴨川三角洲" },
      transitProvider: "navitime",
      travelSource: "navitime",
      routeShapesAvailable: true,
    });
    const [from, originalTo] = suggested.stops;
    const to = {
      ...originalTo!,
      latitude: from!.latitude! + 0.02,
      longitude: from!.longitude,
      metersFromPrevious: 2_200,
      minutesFromPrevious: 31,
      linesFromPrevious: [],
    };
    const navitime = {
      ...suggested,
      stops: [from!, to],
      totalMeters: 2_200,
      totalMinutes: 31,
    };
    const routeShapes: DayRouteShapesResponse = {
      legs: [{
        fromId: from!.tripPlaceId,
        toId: to.tripPlaceId,
        geojson: {
          type: "FeatureCollection",
          features: [{
            type: "Feature",
            geometry: {
              type: "LineString",
              coordinates: [[from!.longitude!, from!.latitude!], [to.longitude!, to.latitude!]],
            },
            properties: { ways: "walk", inline: { color: null } },
          }],
        },
      }],
    };
    const { request } = immediateRequest({ suggested: navitime, routeShapes });
    render(dialog(request));
    const candidate = await screen.findByRole("region", { name: "可以儲存的順序" });

    fireEvent.click(within(candidate).getByRole("tab", { name: "Google Map" }));

    expect(await within(candidate).findByText("可能要搭公車（NAVITIME 不含公車路線）")).toBeInTheDocument();
    expect(within(candidate).queryByText("步行")).not.toBeInTheDocument();
  });

  it("links the long NAVITIME walk row directly to Google Maps transit directions", async () => {
    const suggested = route("suggested", {
      names: { b: "上賀茂神社", a: "鴨川三角洲" },
      transitProvider: "navitime",
      travelSource: "navitime",
    });
    const [from, originalTo] = suggested.stops;
    const navitime = {
      ...suggested,
      stops: [
        from!,
        {
          ...originalTo!,
          // About 3.9 km north: the classification uses the endpoints, not the rounded DTO metres.
          latitude: from!.latitude! + 0.035,
          longitude: from!.longitude,
          metersFromPrevious: 3_800,
          minutesFromPrevious: 49,
          linesFromPrevious: [],
        },
      ],
      totalMeters: 3_800,
      totalMinutes: 49,
    };
    const { request } = immediateRequest({ suggested: navitime });
    render(dialog(request));
    const candidate = await screen.findByRole("region", { name: "可以儲存的順序" });

    expect(within(candidate).getByText("步行約 3.8 km・可能要搭公車")).toBeInTheDocument();
    const link = within(candidate).getByRole("link", { name: /Google Maps 查公車/ });
    expect(link).toHaveTextContent("Google Maps 查公車");
    expect(new URL(link.getAttribute("href")!).searchParams.get("travelmode")).toBe("transit");

    const saved = screen.getByRole("region", { name: "已儲存的順序" });
    expect(within(saved).queryByText(/可能要搭公車/)).not.toBeInTheDocument();
  });

  it("warns in the list from a loaded walk-only shape even before transit minutes were fetched", async () => {
    const suggested = route("suggested", {
      names: { b: "上賀茂神社", a: "鴨川三角洲" },
      transitProvider: "navitime",
      travelSource: "straight_line",
      routeShapesAvailable: true,
    });
    const [from, originalTo] = suggested.stops;
    const to = {
      ...originalTo!,
      latitude: from!.latitude! + 0.02,
      longitude: from!.longitude,
      metersFromPrevious: 2_224,
      minutesFromPrevious: null,
      linesFromPrevious: [],
    };
    const cacheOnly = { ...suggested, stops: [from!, to], totalMeters: 2_224, totalMinutes: null };
    const routeShapes: DayRouteShapesResponse = {
      legs: [{
        fromId: from!.tripPlaceId,
        toId: to.tripPlaceId,
        geojson: {
          type: "FeatureCollection",
          features: [{
            type: "Feature",
            geometry: { type: "LineString", coordinates: [[from!.longitude!, from!.latitude!], [to.longitude!, to.latitude!]] },
            properties: { ways: "walk", inline: { color: null } },
          }],
        },
      }],
    };
    const { request } = immediateRequest({ suggested: cacheOnly, routeShapes });
    render(dialog(request));
    const candidate = await screen.findByRole("region", { name: "可以儲存的順序" });
    expect(within(candidate).queryByText(/可能要搭公車/)).not.toBeInTheDocument();

    fireEvent.click(within(candidate).getByRole("tab", { name: "Google Map" }));
    expect(await within(candidate).findByText("可能要搭公車（NAVITIME 不含公車路線）")).toBeInTheDocument();
    fireEvent.click(within(candidate).getByRole("tab", { name: "路線" }));

    expect(within(candidate).getByText("步行約 2.2 km・可能要搭公車")).toBeInTheDocument();
    const link = within(candidate).getByRole("link", { name: /Google Maps 查公車/ });
    expect(new URL(link.getAttribute("href")!).searchParams.get("travelmode")).toBe("transit");
  });
});

describe("day-plan request ownership", () => {
  it("never lets old route or maps-config responses overwrite a newer dialog", async () => {
    const routeRequests = new Map<string, Deferred<{ route: DayRouteDto }>[]>();
    const configRequests: Deferred<{ browserKey: string; mapId: string | null }>[] = [];
    const request = <T,>(url: string, options?: RequestInit): Promise<T> => {
      if (url === "/api/maps/config") {
        const pending = deferred<{ browserKey: string; mapId: string | null }>();
        configRequests.push(pending);
        return pending.promise as Promise<T>;
      }
      if (url === "/api/maps/load") return Promise.resolve(undefined as T);
      if (url.endsWith("/route")) {
        const dayId = url.includes("day-2") ? "day-2" : "day-1";
        const pending = deferred<{ route: DayRouteDto }>();
        routeRequests.set(dayId, [...(routeRequests.get(dayId) ?? []), pending]);
        return pending.promise as Promise<T>;
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    };
    const { rerender } = render(dialog(request, day1));
    await waitFor(() => expect(routeRequests.get("day-1")).toHaveLength(2));

    rerender(dialog(request, day2));
    await waitFor(() => {
      expect(routeRequests.get("day-2")).toHaveLength(2);
      expect(configRequests).toHaveLength(2);
    });

    const day2RouteRequests = routeRequests.get("day-2")!;
    act(() => {
      day2RouteRequests[0]!.resolve({ route: route("current", { dayId: "day-2", date: day2.date, names: { a: "第二天 A", b: "第二天 B" } }) });
      day2RouteRequests[1]!.resolve({ route: route("suggested", { dayId: "day-2", date: day2.date, names: { a: "第二天 A", b: "第二天 B" } }) });
      configRequests[1]!.resolve({ browserKey: "new-key", mapId: "new-map" });
    });
    const candidate = await screen.findByRole("region", { name: "可以儲存的順序" });
    expect(within(candidate).getByText("第二天 B")).toBeInTheDocument();
    fireEvent.click(within(candidate).getByRole("tab", { name: "Google Map" }));
    expect(await screen.findByTestId("google-api-provider")).toHaveAttribute("data-api-key", "new-key");

    const day1RouteRequests = routeRequests.get("day-1")!;
    act(() => {
      day1RouteRequests[0]!.resolve({ route: route("current", { names: { a: "過期 A", b: "過期 B" } }) });
      day1RouteRequests[1]!.resolve({ route: route("suggested", { names: { a: "過期 A", b: "過期 B" } }) });
      configRequests[0]!.resolve({ browserKey: "old-key", mapId: "old-map" });
    });

    await waitFor(() => expect(screen.queryByText("過期 B")).not.toBeInTheDocument());
    expect(screen.getByTestId("google-api-provider")).toHaveAttribute("data-api-key", "new-key");
  });

  it("invalidates an old removal baseline across sessions until the new snapshot baseline settles", async () => {
    let session = 1;
    const baselineRequests: Deferred<{ route: DayRouteDto }>[] = [];
    let customCount = 0;
    const request = async <T,>(url: string, options?: RequestInit): Promise<T> => {
      if (url === "/api/maps/config") return { browserKey: null, mapId: null } as T;
      const input = inputOf(options)!;
      if (input.order === "current") {
        return { route: route("current", { totalMeters: session === 1 ? 12_000 : 22_000 }) } as T;
      }
      if (input.order === "suggested") {
        return { route: route("suggested", { totalMeters: session === 1 ? 8_000 : 18_000 }) } as T;
      }
      customCount += 1;
      if (customCount % 2 === 1) {
        return { route: route("custom", { ids: input.orderedTripPlaceIds, totalMeters: session === 1 ? 4_000 : 14_000 }) } as T;
      }
      const pending = deferred<{ route: DayRouteDto }>();
      baselineRequests.push(pending);
      return await pending.promise as T;
    };
    const { rerender } = render(dialog(request));
    let candidate = await screen.findByRole("region", { name: "可以儲存的順序" });
    fireEvent.click(within(candidate).getByRole("button", { name: "這天不去「地點 b」" }));
    await waitFor(() => expect(baselineRequests).toHaveLength(1));

    rerender(dialog(request, null));
    session = 2;
    rerender(dialog(request, day1));
    candidate = await screen.findByRole("region", { name: "可以儲存的順序" });
    fireEvent.click(within(candidate).getByRole("button", { name: "這天不去「地點 b」" }));
    await waitFor(() => expect(baselineRequests).toHaveLength(2));
    expect(within(candidate).getByText("正在計算比較基準…")).toBeInTheDocument();

    act(() => baselineRequests[0]!.resolve({ route: route("custom", { ids: ["a"], totalMeters: 4_000 }) }));
    expect(within(candidate).getByText("正在計算比較基準…")).toBeInTheDocument();

    act(() => baselineRequests[1]!.resolve({ route: route("custom", { ids: ["a"], totalMeters: 19_000 }) }));
    await waitFor(() => expect(within(candidate).queryByText("正在計算比較基準…")).not.toBeInTheDocument());
    expect(within(candidate).getByText("↓ 少 5.0 公里")).toBeInTheDocument();
  });
});

describe("day-plan draft and save behavior", () => {
  it("requests a removal baseline in saved order minus removed ids, not candidate order", async () => {
    const current = route("current", { ids: ["a", "b", "c"] });
    const suggested = route("suggested", { ids: ["c", "b", "a"] });
    const { request, calls } = immediateRequest({ current, suggested });
    render(dialog(request));
    const candidate = await screen.findByRole("region", { name: "可以儲存的順序" });
    fireEvent.click(within(candidate).getByRole("button", { name: "這天不去「地點 b」" }));

    await waitFor(() => {
      const customInputs = calls
        .filter((call) => call.url.endsWith("/route"))
        .map((call) => inputOf(call.options))
        .filter((input) => input?.order === "custom");
      expect(customInputs).toEqual([
        { order: "custom", orderedTripPlaceIds: ["c", "a"] },
        { order: "custom", orderedTripPlaceIds: ["a", "c"] },
      ]);
    });
  });

  it("does not PUT an unchanged order", async () => {
    const same = route("current", { ids: ["a", "b"] });
    const { request, calls } = immediateRequest({ current: same, suggested: { ...same, order: "suggested" } });
    render(dialog(request));
    const save = await screen.findByRole("button", { name: "儲存為第 1 天的安排" });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(calls.filter((call) => call.options?.method === "PUT")).toHaveLength(0);
  });

  it("routes a reorder to place-order with displayed ids/version and reuses its idempotency key on retry", async () => {
    let attempts = 0;
    const mutationCalls: RequestCall[] = [];
    const { request } = immediateRequest({
      mutate: async (call) => {
        mutationCalls.push(call);
        attempts += 1;
        if (attempts === 1) throw new Error("暫時失敗");
        return { orderedTripPlaceIds: ["b", "a"], version: 8 };
      },
    });
    render(dialog(request));
    const save = await screen.findByRole("button", { name: "儲存為第 1 天的安排" });
    fireEvent.click(save);
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    await waitFor(() => expect(mutationCalls).toHaveLength(2));

    for (const call of mutationCalls) {
      expect(call.url).toBe("/api/trips/trip-1/days/day-1/place-order");
      expect(JSON.parse(String(call.options?.body))).toEqual({
        orderedTripPlaceIds: ["b", "a"],
        expectedVersion: 7,
      });
    }
    expect(new Headers(mutationCalls[0]!.options?.headers).get("Idempotency-Key")).toBe(
      new Headers(mutationCalls[1]!.options?.headers).get("Idempotency-Key"),
    );
  });

  it("routes a removal to arrangement with the displayed remaining ids and version", async () => {
    const mutationCalls: RequestCall[] = [];
    const { request } = immediateRequest({
      mutate: async (call) => {
        mutationCalls.push(call);
        return { tripPlaces: [] };
      },
    });
    render(dialog(request));
    const candidate = await screen.findByRole("region", { name: "可以儲存的順序" });
    fireEvent.click(within(candidate).getByRole("button", { name: "這天不去「地點 b」" }));
    const save = await screen.findByRole("button", { name: "儲存為第 1 天的安排" });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    await waitFor(() => expect(mutationCalls).toHaveLength(1));

    expect(mutationCalls[0]!.url).toBe("/api/trips/trip-1/days/day-1/arrangement");
    expect(JSON.parse(String(mutationCalls[0]!.options?.body))).toEqual({
      orderedTripPlaceIds: ["a"],
      expectedVersion: 7,
    });
  });

  it("keeps the paid Google restore target and minutes after saving", async () => {
    let saved = false;
    const calls: RequestCall[] = [];
    const request = async <T,>(url: string, options?: RequestInit): Promise<T> => {
      calls.push({ url, options });
      if (url === "/api/maps/config") return { browserKey: null, mapId: null } as T;
      if (options?.method === "PUT") {
        saved = true;
        return { orderedTripPlaceIds: ["b", "a"], version: 8 } as T;
      }
      if (!url.endsWith("/route")) throw new Error(`Unexpected request: ${url}`);
      const input = inputOf(options)!;
      if (input.order === "current") {
        return { route: route("current", saved ? { ids: ["b", "a"], version: 8 } : {}) } as T;
      }
      if (input.order === "suggested" && input.transit === "fetch") {
        return { route: googleSuggestion() } as T;
      }
      if (input.order === "suggested") {
        return {
          route: route("suggested", {
            version: saved ? 8 : 7,
            transitCallsNeeded: 2,
            transitProvider: "google_routes",
            routeShapesAvailable: true,
          }),
        } as T;
      }
      if (input.order === "custom") {
        return {
          route: route("custom", {
            ids: input.orderedTripPlaceIds,
            version: saved ? 8 : 7,
            transitProvider: "google_routes",
            routeShapesAvailable: true,
          }),
        } as T;
      }
      throw new Error(`Unexpected route input: ${JSON.stringify(input)}`);
    };
    render(dialog(request));
    fireEvent.click(await screen.findByRole("button", { name: "用大眾運輸時間排（約 2 次）" }));
    const candidate = await screen.findByRole("region", { name: "可以儲存的順序" });
    expect(await within(candidate).findByText("17 分鐘・大眾運輸／步行")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "儲存為第 1 天的安排" }));

    await within(candidate).findByRole("button", { name: "還原成依交通時間排" });
    expect(within(candidate).getByText("17 分鐘・大眾運輸／步行")).toBeInTheDocument();
    fireEvent.keyDown(within(candidate).getByRole("button", { name: /拖曳「地點 b」/ }), { key: "ArrowDown" });
    await waitFor(() => expect(within(candidate).getAllByRole("button", { name: /^拖曳/ })
      .map((button) => button.getAttribute("aria-label"))).toEqual([
      "拖曳「地點 a」調整順序；也可用上下鍵",
      "拖曳「地點 b」調整順序；也可用上下鍵",
    ]));

    fireEvent.click(within(candidate).getByRole("button", { name: "還原成依交通時間排" }));
    await waitFor(() => expect(within(candidate).getAllByRole("button", { name: /^拖曳/ })
      .map((button) => button.getAttribute("aria-label"))).toEqual([
      "拖曳「地點 b」調整順序；也可用上下鍵",
      "拖曳「地點 a」調整順序；也可用上下鍵",
    ]));
    expect(within(candidate).getByText("17 分鐘・大眾運輸／步行")).toBeInTheDocument();
    const routeInputs = calls.filter((call) => call.url.endsWith("/route")).map((call) => inputOf(call.options));
    expect(routeInputs.filter((input) => input?.transit === "fetch")).toEqual([
      { order: "suggested", transit: "fetch", maxTransitCalls: 2 },
    ]);
  });

  it("labels a custom route equal to the saved length without claiming it is shortest", async () => {
    const current = route("current", { ids: ["a", "b"], totalMeters: 12_000 });
    const suggested = route("suggested", { ids: ["b", "a"], totalMeters: 8_000 });
    const { request } = immediateRequest({
      current,
      suggested,
      custom: (ids) => route("custom", { ids, totalMeters: 12_000 }),
    });
    render(dialog(request));
    const candidate = await screen.findByRole("region", { name: "可以儲存的順序" });
    fireEvent.keyDown(within(candidate).getByRole("button", { name: /拖曳「地點 b」/ }), { key: "ArrowDown" });

    expect(await within(candidate).findByText("和原本順序一樣長")).toBeInTheDocument();
    expect(within(candidate).queryByText("已是最短")).not.toBeInTheDocument();
  });
});

const hotel = { placeId: "hotel", name: "飯店", latitude: 35.0, longitude: 135.7, providerPlaceId: null };

type StopTiming = Partial<Pick<DayRouteStopDto, "minutesFromPrevious" | "estimatedMoveMinutesFromPrevious" | "stayMinutes" | "stayEstimated">>;

/** A day from the morning hotel back to the night hotel, with server timing fields. */
function timedRoute(order: DayRouteOrder, stops: Record<string, StopTiming>, options: {
  dayStartMinute?: number;
  fixedMinutes?: number;
  toEnd?: { minutes: number | null; estimate: number | null };
  noNightLodging?: boolean;
} = {}): DayRouteDto {
  const base = route(order, { ids: Object.keys(stops) });
  return {
    ...base,
    startsAt: hotel,
    endsAt: options.noNightLodging ? null : hotel,
    metersToEnd: options.noNightLodging ? null : 1_000,
    stops: base.stops.map((stop) => ({ ...stop, ...stops[stop.tripPlaceId] })),
    minutesToEnd: options.toEnd?.minutes ?? null,
    estimatedMoveMinutesToEnd: options.toEnd?.estimate ?? null,
    dayStartMinute: options.dayStartMinute ?? 540,
    fixedMinutes: options.fixedMinutes ?? 0,
  };
}

function timedRequest(suggested: DayRouteDto, options: {
  custom?(ids: string[]): DayRouteDto;
  patch?(call: RequestCall): unknown;
} = {}) {
  const calls: RequestCall[] = [];
  const request = async <T,>(url: string, init?: RequestInit): Promise<T> => {
    calls.push({ url, options: init });
    if (url === "/api/maps/config") return { browserKey: null, mapId: null } as T;
    if (init?.method === "PATCH" && options.patch) return options.patch({ url, options: init }) as T;
    if (url.endsWith("/route")) {
      const input = inputOf(init)!;
      if (input.order === "current") return { route: route("current", { ids: suggested.orderedTripPlaceIds }) } as T;
      if (input.order === "suggested") return { route: suggested } as T;
      return { route: options.custom?.(input.orderedTripPlaceIds ?? []) ?? route("custom", { ids: input.orderedTripPlaceIds ?? [] }) } as T;
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  return { request, calls };
}

function timedDialog(request: <T>(url: string, options?: RequestInit) => Promise<T>, props: {
  canArrange?: boolean;
  places?: TripPlaceDto[];
  onPlaceUpdated?(): Promise<void>;
} = {}) {
  return (
    <DayPlanDialog
      tripId="trip-1"
      day={day1}
      canArrange={props.canArrange ?? true}
      request={request}
      onClose={() => {}}
      onOrderSaved={async () => {}}
      places={props.places ?? []}
      onPlaceUpdated={props.onPlaceUpdated ?? (async () => {})}
    />
  );
}

describe("day-plan return time", () => {
  // 09:00 start + 60 fixed; a: member 90 min, b: estimated 60 min.
  const legsAndStays = (a: StopTiming, b: StopTiming): Record<string, StopTiming> => ({
    a: { stayMinutes: 90, stayEstimated: false, ...a },
    b: { stayMinutes: 60, stayEstimated: true, ...b },
  });
  it.each([
    {
      name: "transit minutes win over the straight-line estimate",
      route: timedRoute("suggested", legsAndStays({ minutesFromPrevious: 20, estimatedMoveMinutesFromPrevious: 30 }, { estimatedMoveMinutesFromPrevious: 15 }), { fixedMinutes: 60, toEnd: { minutes: null, estimate: 25 } }),
      line: "09:00 出門・約 13:30 回到住宿",
      note: "（停留、移動是估計）",
    },
    {
      name: "a leg without transit minutes falls back to the estimate",
      route: timedRoute("suggested", legsAndStays({ estimatedMoveMinutesFromPrevious: 30 }, { estimatedMoveMinutesFromPrevious: 15 }), { fixedMinutes: 60, toEnd: { minutes: null, estimate: 25 } }),
      line: "09:00 出門・約 13:40 回到住宿",
      note: "（停留、移動是估計）",
    },
    {
      name: "a leg with neither is called out but the time is still shown",
      route: timedRoute("suggested", legsAndStays({ minutesFromPrevious: 20 }, { estimatedMoveMinutesFromPrevious: 15 }), { fixedMinutes: 60, toEnd: { minutes: null, estimate: null } }),
      line: "09:00 出門・約 13:05 回到住宿",
      note: "（停留、移動是估計）（部分路段無法估計）",
    },
    {
      name: "only estimated stays are labelled when every leg has transit minutes",
      route: timedRoute("suggested", legsAndStays({ minutesFromPrevious: 20 }, { minutesFromPrevious: 10 }), { fixedMinutes: 60, toEnd: { minutes: 25, estimate: 40 } }),
      line: "09:00 出門・約 13:25 回到住宿",
      note: "（停留時間是估計）",
    },
    {
      name: "only estimated moves are labelled when every stay is member-entered",
      route: timedRoute("suggested", legsAndStays({ minutesFromPrevious: 20 }, { estimatedMoveMinutesFromPrevious: 15, stayEstimated: false }), { fixedMinutes: 60, toEnd: { minutes: null, estimate: 25 } }),
      line: "09:00 出門・約 13:30 回到住宿",
      note: "（移動是估計）",
    },
    {
      name: "a return after midnight says 隔天",
      route: timedRoute("suggested", legsAndStays({ minutesFromPrevious: 20 }, { minutesFromPrevious: 10, stayEstimated: false }), { dayStartMinute: 1320, toEnd: { minutes: 10, estimate: null } }),
      line: "22:00 出門・約 隔天 01:10 回到住宿",
      note: "",
    },
    {
      name: "a day without night lodging ends at its last stop",
      route: timedRoute("suggested", legsAndStays({ minutesFromPrevious: 20 }, { minutesFromPrevious: 10, stayEstimated: false }), { noNightLodging: true }),
      line: "09:00 出門・約 12:00 結束最後一站",
      note: "",
    },
  ])("$name", async ({ route: suggested, line, note }) => {
    const { request } = timedRequest(suggested);
    render(timedDialog(request));
    const candidate = await screen.findByRole("region", { name: "可以儲存的順序" });
    const summary = within(candidate).getByText(line).closest("p")!;
    expect(summary.textContent).toBe(`${line}${note}`);
    // The saved column keeps its distance-only view.
    const saved = screen.getByRole("region", { name: "已儲存的順序" });
    expect(within(saved).queryByText(/出門・約/)).not.toBeInTheDocument();
    expect(within(saved).queryByText(/停留/)).not.toBeInTheDocument();
  });

  it("shows past midnight as 隔天 00:40", async () => {
    const suggested = timedRoute("suggested", {
      a: { minutesFromPrevious: 20, stayMinutes: 60, stayEstimated: false },
      b: { minutesFromPrevious: 10, stayMinutes: 60, stayEstimated: false },
    }, { dayStartMinute: 1320, toEnd: { minutes: 10, estimate: null } });
    render(timedDialog(timedRequest(suggested).request));
    const candidate = await screen.findByRole("region", { name: "可以儲存的順序" });
    expect(within(candidate).getByText("22:00 出門・約 隔天 00:40 回到住宿")).toBeInTheDocument();
  });

  it("shows each stay with 約 only when estimated, and nothing for a station", async () => {
    const suggested = timedRoute("suggested", {
      a: { minutesFromPrevious: 20, stayMinutes: 90, stayEstimated: false },
      station: { minutesFromPrevious: 10, stayMinutes: 0, stayEstimated: false },
      b: { minutesFromPrevious: 5, stayMinutes: 45, stayEstimated: true },
    }, { toEnd: { minutes: 25, estimate: null } });
    render(timedDialog(timedRequest(suggested).request));
    const candidate = await screen.findByRole("region", { name: "可以儲存的順序" });
    // 09:00 + 20 + 90 + 10 + 0 + 5 + 45 + 25: the station adds only its legs.
    expect(within(candidate).getByText("09:00 出門・約 12:15 回到住宿")).toBeInTheDocument();
    expect(within(candidate).getByRole("button", { name: "改「地點 a」的停留時間（目前停留 1 小時 30 分）" })).toBeInTheDocument();
    expect(within(candidate).getByRole("button", { name: "改「地點 b」的停留時間（目前停留約 45 分）" })).toBeInTheDocument();
    expect(within(candidate).queryByRole("button", { name: /改「地點 station」/ })).not.toBeInTheDocument();
    const stationRow = candidate.querySelector<HTMLElement>('[data-trip-place-id="station"]')!;
    expect(within(stationRow).queryByText(/停留/)).not.toBeInTheDocument();
  });

  it("shows stays as plain text to members who cannot arrange", async () => {
    const suggested = timedRoute("suggested", { a: { minutesFromPrevious: 20, stayMinutes: 90, stayEstimated: true } }, { toEnd: { minutes: 25, estimate: null } });
    render(timedDialog(timedRequest(suggested).request, { canArrange: false }));
    const candidate = await screen.findByRole("region", { name: "可以儲存的順序" });
    expect(within(candidate).getByText("停留約 1 小時 30 分")).toBeInTheDocument();
    expect(within(candidate).queryByRole("button", { name: /停留時間/ })).not.toBeInTheDocument();
  });

  it("recomputes the time for the remaining stops after one is taken off the day", async () => {
    const suggested = timedRoute("suggested", {
      a: { minutesFromPrevious: 20, stayMinutes: 90, stayEstimated: false },
      b: { minutesFromPrevious: 10, stayMinutes: 60, stayEstimated: false },
    }, { toEnd: { minutes: 25, estimate: null } });
    const custom = (ids: string[]) => {
      expect(ids).toEqual(["a"]);
      return timedRoute("custom", { a: { minutesFromPrevious: 20, stayMinutes: 90, stayEstimated: false } }, { toEnd: { minutes: 15, estimate: null } });
    };
    render(timedDialog(timedRequest(suggested, { custom }).request));
    const candidate = await screen.findByRole("region", { name: "可以儲存的順序" });
    expect(within(candidate).getByText("09:00 出門・約 12:25 回到住宿")).toBeInTheDocument();

    fireEvent.click(within(candidate).getByRole("button", { name: "這天不去「地點 b」" }));

    expect(await within(candidate).findByText("09:00 出門・約 11:05 回到住宿")).toBeInTheDocument();
    expect(within(candidate).queryByText("09:00 出門・約 12:25 回到住宿")).not.toBeInTheDocument();
  });

  it("saves a stay through the place planning API with the place's other facts and version, then updates the time", async () => {
    const [wishlist] = todayWishlist();
    const place: TripPlaceDto = { ...wishlist!, id: "a", effortLevel: 2, durationMinutes: null, budgetAmountMinor: 1500, budgetCurrency: "JPY", notes: "早上去", version: 3 };
    const suggested = timedRoute("suggested", {
      a: { minutesFromPrevious: 20, stayMinutes: 90, stayEstimated: true },
      b: { minutesFromPrevious: 10, stayMinutes: 60, stayEstimated: false },
    }, { toEnd: { minutes: 25, estimate: null } });
    const patches: RequestCall[] = [];
    const { request, calls } = timedRequest(suggested, {
      patch: (call) => {
        patches.push(call);
        return { tripPlace: { ...place, durationMinutes: 120, version: 4 } };
      },
      custom: (ids) => timedRoute("custom", Object.fromEntries(ids.map((id) => [id, id === "a"
        ? { minutesFromPrevious: 20, stayMinutes: 120, stayEstimated: false }
        : { minutesFromPrevious: 10, stayMinutes: 60, stayEstimated: false }])), { toEnd: { minutes: 25, estimate: null } }),
    });
    const onPlaceUpdated = vi.fn(async () => {});
    render(timedDialog(request, { places: [place], onPlaceUpdated }));
    const candidate = await screen.findByRole("region", { name: "可以儲存的順序" });
    expect(within(candidate).getByText("09:00 出門・約 12:25 回到住宿")).toBeInTheDocument();

    fireEvent.click(within(candidate).getByRole("button", { name: "改「地點 a」的停留時間（目前停留約 1 小時 30 分）" }));
    const input = within(candidate).getByLabelText("「地點 a」停留時間");
    fireEvent.change(input, { target: { value: "10" } });
    fireEvent.click(within(candidate).getByRole("button", { name: "儲存停留時間" }));
    expect(within(candidate).getByRole("alert")).toHaveTextContent("請輸入 15 到 720 分鐘。");
    expect(patches).toHaveLength(0);

    fireEvent.change(input, { target: { value: "120" } });
    fireEvent.click(within(candidate).getByRole("button", { name: "儲存停留時間" }));

    expect(await within(candidate).findByText("09:00 出門・約 12:55 回到住宿")).toBeInTheDocument();
    expect(within(candidate).queryByText(/（停留時間是估計）/)).not.toBeInTheDocument();
    expect(within(candidate).getByRole("button", { name: "改「地點 a」的停留時間（目前停留 2 小時）" })).toBeInTheDocument();
    expect(patches).toHaveLength(1);
    expect(patches[0]!.url).toBe("/api/trips/trip-1/trip-places/a/planning");
    expect(new Headers(patches[0]!.options?.headers).get("Idempotency-Key")).toBeTruthy();
    expect(JSON.parse(String(patches[0]!.options?.body))).toEqual({
      durationMinutes: 120,
      effortLevel: 2,
      budgetAmountMinor: 1500,
      budgetCurrency: "JPY",
      notes: "早上去",
      expectedVersion: 3,
    });
    expect(onPlaceUpdated).toHaveBeenCalledTimes(1);
    // The re-read is cache-only: a custom order never carries a transit fetch.
    const reread = calls.filter((call) => call.url.endsWith("/route")).map((call) => inputOf(call.options)).at(-1);
    expect(reread).toEqual({ order: "custom", orderedTripPlaceIds: ["a", "b"] });
  });
});
