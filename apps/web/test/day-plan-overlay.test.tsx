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

function route(order: DayRouteOrder, ids = order === "suggested" ? ["b", "a"] : ["a", "b"]): DayRouteDto {
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
    })),
    metersToEnd: null,
    totalMeters: 1_000,
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
  it("replaces the polyline path when a pending route update settles without reserving another map", async () => {
    const custom = deferred<{ route: DayRouteDto }>();
    let mapLoads = 0;
    const request = async <T,>(url: string, options?: RequestInit): Promise<T> => {
      if (url === "/api/maps/config") return { browserKey: "key", mapId: "map-id" } as T;
      if (url === "/api/maps/load") {
        mapLoads += 1;
        return undefined as T;
      }
      const input = JSON.parse(String(options?.body)) as { order: DayRouteOrder; orderedTripPlaceIds?: string[] };
      if (input.order === "custom") return await custom.promise as T;
      return { route: route(input.order) } as T;
    };
    renderDialog(request);
    const candidate = await screen.findByRole("region", { name: "可以儲存的順序" });
    fireEvent.keyDown(within(candidate).getByRole("button", { name: /拖曳「地點 b」/ }), { key: "ArrowDown" });
    fireEvent.click(within(candidate).getByRole("tab", { name: "Google Map" }));

    await waitFor(() => expect(polylines).toHaveLength(1));
    expect(polylines[0]!.path).toEqual([coordinates.b, coordinates.a]);
    act(() => custom.resolve({ route: route("custom", ["a", "b"]) }));

    await waitFor(() => expect(polylines).toHaveLength(2));
    expect(polylines[0]!.setMap).toHaveBeenCalledWith(null);
    expect(polylines[1]!.path).toEqual([coordinates.a, coordinates.b]);
    expect(mapLoads).toBe(1);
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
