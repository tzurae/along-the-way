// @vitest-environment jsdom
import { StrictMode, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DayRouteDto, DayRouteOrder } from "@along-the-way/contracts/day-plans";
import { ApiRequestError } from "../src/api-error";
import { DayPlanDialog } from "../src/DayPlanDialog";

let googleScriptError: ((error: unknown) => void) | undefined;

vi.mock("@vis.gl/react-google-maps", () => ({
  APIProvider: ({ children, onError }: { children: ReactNode; onError?: (error: unknown) => void }) => {
    googleScriptError = onError;
    return <div data-testid="google-api-provider">{children}</div>;
  },
  Map: ({ children }: { children: ReactNode }) => <div data-testid="google-map">{children}</div>,
  AdvancedMarker: ({ children }: { children: ReactNode }) => <>{children}</>,
  Pin: () => <span />,
  useMap: () => null,
}));

function route(order: DayRouteOrder): DayRouteDto {
  return {
    dayId: "day-1",
    date: "2026-10-21",
    version: 1,
    order,
    orderedTripPlaceIds: ["place-1"],
    startsAt: null,
    endsAt: null,
    stops: [{
      tripPlaceId: "place-1",
      name: "清水寺",
      latitude: 34.9949,
      longitude: 135.785,
      providerPlaceId: null,
      metersFromPrevious: null,
      minutesFromPrevious: null,
      linesFromPrevious: [],
      estimatedMoveMinutesFromPrevious: null,
      stayMinutes: null,
      stayEstimated: false,
    }],
    metersToEnd: null,
    totalMeters: 0,
    travelSource: "straight_line",
    transitProvider: null,
    routeShapesAvailable: false,
    minutesToEnd: null,
    linesToEnd: [],
    totalMinutes: null,
    transitMatrix: [],
    transitCallsNeeded: 0,
    transitCacheDays: null,
    dayStartMinute: null,
    fixedMinutes: null,
    estimatedMoveMinutesToEnd: null,
  };
}

interface RequestCall {
  url: string;
  options?: RequestInit;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function setup(loadMap: () => Promise<unknown>) {
  const calls: RequestCall[] = [];
  async function request<T>(url: string, options?: RequestInit): Promise<T> {
    calls.push({ url, options });
    if (url === "/api/maps/config") {
      return { browserKey: "browser-key", mapId: "map-id" } as T;
    }
    if (url === "/api/maps/load") return (await loadMap()) as T;
    if (url.endsWith("/route")) {
      const input = JSON.parse(String(options?.body)) as { order: DayRouteOrder };
      return { route: route(input.order) } as T;
    }
    throw new Error(`Unexpected request: ${url}`);
  }
  render(
    <StrictMode>
      <DayPlanDialog
        tripId="trip-1"
        day={{ id: "day-1", date: "2026-10-21", label: "第 1 天" }}
        canArrange
        request={request}
        onClose={() => {}}
        onOrderSaved={async () => {}}
        places={[]}
        onPlaceUpdated={async () => {}}
      />
    </StrictMode>,
  );
  return calls;
}

async function showCandidateMap() {
  const candidate = await screen.findByRole("region", { name: "可以儲存的順序" });
  fireEvent.click(within(candidate).getByRole("tab", { name: "Google Map" }));
  return candidate;
}

function mapLoadCalls(calls: RequestCall[]) {
  return calls.filter(({ url, options }) =>
    url === "/api/maps/load" && options?.method === "POST");
}

beforeEach(() => {
  googleScriptError = undefined;
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

afterEach(() => {
  cleanup();
  delete window.gm_authFailure;
  vi.unstubAllGlobals();
});

describe("day-plan Google map load budget", () => {
  it("reserves exactly one map load before rendering a map, including in StrictMode", async () => {
    const request = setup(async () => null);
    await showCandidateMap();

    expect(await screen.findByTestId("google-map")).toBeInTheDocument();
    expect(mapLoadCalls(request)).toHaveLength(1);
  });

  it("shows the daily-limit explanation without loading Google Maps", async () => {
    const request = setup(async () => {
      throw new ApiRequestError("maps_daily_limit", "server copy", undefined, undefined, undefined, 429);
    });
    await showCandidateMap();

    expect(await screen.findByText("今天的地圖額度已用完，明天會恢復；「路線」分頁不受影響。")).toBeInTheDocument();
    expect(screen.queryByTestId("google-api-provider")).not.toBeInTheDocument();
    expect(mapLoadCalls(request)).toHaveLength(1);
  });

  it("asks for a page reload after the Google script fails instead of spending another reservation", async () => {
    const request = setup(async () => null);
    await showCandidateMap();
    await screen.findByTestId("google-map");

    act(() => googleScriptError?.(new Error("script unavailable")));
    expect(await screen.findByText("地圖載入失敗，請檢查網路後重新整理頁面。")).toBeInTheDocument();
    expect(screen.queryByTestId("google-api-provider")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重試" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新整理頁面" })).toBeInTheDocument();
    expect(mapLoadCalls(request)).toHaveLength(1);
  });

  it("shows the Google configuration failure reported through gm_authFailure", async () => {
    setup(async () => null);
    await showCandidateMap();
    await screen.findByTestId("google-map");

    act(() => window.gm_authFailure?.());

    expect(await screen.findByText("Google 地圖設定有問題，暫時無法顯示地圖。")).toBeInTheDocument();
    expect(screen.queryByTestId("google-api-provider")).not.toBeInTheDocument();
  });

  it("fans auth failure out, calls and restores the previous handler, and keeps auth terminal as reservations settle", async () => {
    const previousAuthFailure = vi.fn();
    window.gm_authFailure = previousAuthFailure;
    const reservations = [deferred<void>(), deferred<void>()];
    let reservationIndex = 0;
    const calls = setup(() => reservations[reservationIndex++]!.promise);
    const saved = await screen.findByRole("region", { name: "已儲存的順序" });
    const candidate = screen.getByRole("region", { name: "可以儲存的順序" });
    fireEvent.click(within(saved).getByRole("tab", { name: "Google Map" }));
    fireEvent.click(within(candidate).getByRole("tab", { name: "Google Map" }));
    await waitFor(() => expect(mapLoadCalls(calls)).toHaveLength(2));

    act(() => window.gm_authFailure?.());
    expect(previousAuthFailure).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText("Google 地圖設定有問題，暫時無法顯示地圖。")).toHaveLength(2);

    act(() => {
      reservations[0]!.resolve();
      reservations[1]!.reject(new Error("late reservation failure"));
    });
    await act(async () => {
      await Promise.allSettled(reservations.map(({ promise }) => promise));
    });
    expect(screen.getAllByText("Google 地圖設定有問題，暫時無法顯示地圖。")).toHaveLength(2);
    expect(screen.queryByTestId("google-api-provider")).not.toBeInTheDocument();

    fireEvent.click(within(saved).getByRole("tab", { name: "路線" }));
    fireEvent.click(within(candidate).getByRole("tab", { name: "路線" }));
    expect(window.gm_authFailure).toBe(previousAuthFailure);
  });

  it("deletes its dispatcher after the final subscriber leaves when no previous handler existed", async () => {
    setup(async () => null);
    const candidate = await showCandidateMap();
    await screen.findByTestId("google-map");
    expect(window.gm_authFailure).toBeTypeOf("function");

    fireEvent.click(within(candidate).getByRole("tab", { name: "路線" }));
    expect(window.gm_authFailure).toBeUndefined();
  });

  it("switches the affected column back to the route tab from a map error", async () => {
    setup(async () => {
      throw new ApiRequestError("maps_daily_limit", "server copy", undefined, undefined, undefined, 429);
    });
    const candidate = await showCandidateMap();
    fireEvent.click(await within(candidate).findByRole("button", { name: "改看路線" }));

    expect(within(candidate).getByRole("tab", { name: "路線" })).toHaveAttribute("aria-selected", "true");
    expect(within(candidate).getByRole("tabpanel", { name: "路線" })).not.toHaveAttribute("hidden");
  });
});
