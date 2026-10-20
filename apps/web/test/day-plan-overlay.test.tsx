// @vitest-environment jsdom
import { type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DayRouteDto, DayRouteOrder } from "@along-the-way/contracts/day-plans";
import { DayPlanDialog } from "../src/DayPlanDialog";

interface PolylineRecord {
  path: google.maps.LatLngLiteral[];
  setMap(value: google.maps.Map | null): void;
}

const map = { fitBounds: vi.fn() };
const polylines: PolylineRecord[] = [];

vi.mock("@vis.gl/react-google-maps", () => ({
  APIProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Map: ({ children }: { children: ReactNode }) => <div data-testid="google-map">{children}</div>,
  AdvancedMarker: ({ children }: { children: ReactNode }) => <>{children}</>,
  Pin: () => <span />,
  useMap: () => map,
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const coordinates: Record<string, google.maps.LatLngLiteral> = {
  a: { lat: 34.99, lng: 135.77 },
  b: { lat: 35.02, lng: 135.81 },
};

function route(
  order: DayRouteOrder,
  ids = order === "suggested" ? ["b", "a"] : ["a", "b"],
  routeShapesAvailable = false,
): DayRouteDto {
  return {
    dayId: "day-1",
    date: "2026-10-21",
    version: 3,
    order,
    orderedTripPlaceIds: ids,
    startsAt: null,
    endsAt: null,
    stops: ids.map((tripPlaceId, index) => ({
      tripPlaceId,
      name: `地點 ${tripPlaceId}`,
      latitude: coordinates[tripPlaceId]!.lat,
      longitude: coordinates[tripPlaceId]!.lng,
      providerPlaceId: null,
      metersFromPrevious: index === 0 ? null : 1_000,
      minutesFromPrevious: null,
      linesFromPrevious: [],
    })),
    metersToEnd: null,
    totalMeters: 1_000,
    travelSource: "straight_line",
    transitProvider: null,
    routeShapesAvailable,
    minutesToEnd: null,
    linesToEnd: [],
    totalMinutes: null,
    transitMatrix: [],
    transitCallsNeeded: 0,
    transitCacheDays: null,
  };
}

function renderDialog(request: <T>(url: string, options?: RequestInit) => Promise<T>) {
  return render(
    <DayPlanDialog
      tripId="trip-1"
      day={{ id: "day-1", date: "2026-10-21", label: "第 1 天" }}
      canArrange
      request={request}
      onClose={() => {}}
      onOrderSaved={async () => {}}
    />,
  );
}

beforeEach(() => {
  map.fitBounds.mockReset();
  polylines.length = 0;
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.stubGlobal("google", {
    maps: {
      LatLngBounds: class {
        extend() { return this; }
      },
      Polyline: class {
        readonly path: google.maps.LatLngLiteral[];
        readonly setMap = vi.fn();
        constructor(options: { path: google.maps.LatLngLiteral[] }) {
          this.path = options.path;
          polylines.push(this);
        }
      },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("day-plan map overlays", () => {
  it("draws only provider route shapes and never a straight endpoint polyline", async () => {
    const shapes = deferred<{
      legs: Array<{ fromId: string; toId: string; geojson: {
        type: "FeatureCollection";
        features: Array<{
          type: "Feature";
          geometry: { type: "LineString"; coordinates: [number, number][] };
          properties: { ways: "transport"; inline: { color: string } };
        }>;
      } }>;
    }>();
    let mapLoads = 0;
    const request = async <T,>(url: string, options?: RequestInit): Promise<T> => {
      if (url === "/api/maps/config") return { browserKey: "key", mapId: "map-id" } as T;
      if (url === "/api/maps/load") {
        mapLoads += 1;
        return undefined as T;
      }
      if (url.endsWith("/route-shapes")) return await shapes.promise as T;
      const input = JSON.parse(String(options?.body)) as { order: DayRouteOrder };
      return { route: route(input.order, undefined, input.order === "suggested") } as T;
    };
    const { unmount } = renderDialog(request);
    const candidate = await screen.findByRole("region", { name: "可以儲存的順序" });
    fireEvent.click(within(candidate).getByRole("tab", { name: "Google Map" }));

    expect(await within(candidate).findByText("正在取得實際交通與步行路線…")).toBeInTheDocument();
    expect(polylines).toHaveLength(0);

    const providerPath: [number, number][] = [
      [coordinates.b!.lng, coordinates.b!.lat],
      [135.9, 35.1],
      [coordinates.a!.lng, coordinates.a!.lat],
    ];
    act(() => shapes.resolve({ legs: [{
      fromId: "b",
      toId: "a",
      geojson: {
        type: "FeatureCollection",
        features: [{
          type: "Feature",
          geometry: { type: "LineString", coordinates: providerPath },
          properties: { ways: "transport", inline: { color: "#123456" } },
        }],
      },
    }] }));

    await waitFor(() => expect(polylines).toHaveLength(1));
    expect(polylines[0]!.path).toEqual(providerPath.map(([lng, lat]) => ({ lat, lng })));
    expect(polylines[0]!.path).not.toEqual([coordinates.b, coordinates.a]);
    expect(mapLoads).toBe(1);
    unmount();
    expect(polylines[0]!.setMap).toHaveBeenCalledWith(null);
  });

  it("fits bounds again when a map loaded in a hidden mobile column is revealed", async () => {
    const mapLoad = deferred<void>();
    const request = async <T,>(url: string, options?: RequestInit): Promise<T> => {
      if (url === "/api/maps/config") return { browserKey: "key", mapId: "map-id" } as T;
      if (url === "/api/maps/load") return await mapLoad.promise as T;
      const input = JSON.parse(String(options?.body)) as { order: DayRouteOrder };
      return { route: route(input.order) } as T;
    };
    renderDialog(request);
    const candidate = await screen.findByRole("region", { name: "可以儲存的順序" });
    fireEvent.click(within(candidate).getByRole("tab", { name: "Google Map" }));
    fireEvent.click(screen.getByRole("tab", { name: "已儲存" }));
    act(() => mapLoad.resolve());

    await waitFor(() => expect(map.fitBounds).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("tab", { name: "依直線距離排" }));
    await waitFor(() => expect(map.fitBounds).toHaveBeenCalledTimes(2));
  });
});
