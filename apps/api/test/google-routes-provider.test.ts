import { afterEach, describe, expect, it, vi } from "vitest";

import { GoogleRoutesProvider } from "../src/planning/google-routes-provider";
import type { GeoPoint } from "../src/planning/day-route-order";

const origin: GeoPoint = { id: "origin", latitude: 48.8566, longitude: 2.3522 };
const destination: GeoPoint = { id: "destination", latitude: 48.8606, longitude: 2.3376 };

function provider(costs: number[] = []) {
  return new GoogleRoutesProvider({
    apiKey: "test-google-routes-key",
    reserveBudget: async (cost) => {
      costs.push(cost);
      return { refund: async () => {} };
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Google Routes transit matrix", () => {
  it("sends local 09:00 as RFC3339 TRANSIT requests, batches at 100 destinations, and parses protobuf seconds", async () => {
    const requests: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
    const costs: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        destinations: Array<{ waypoint: { location: { latLng: { latitude: number; longitude: number } } } }>;
      };
      requests.push({ url: String(input), init: init!, body });
      return Response.json(body.destinations.map((_entry, destinationIndex) => ({
        originIndex: 0,
        destinationIndex,
        status: {},
        condition: "ROUTE_EXISTS",
        duration: "1234s",
      })));
    }));
    const destinations = Array.from({ length: 101 }, (_, index): GeoPoint => ({
      id: `destination-${index}`,
      latitude: 48.8 + index / 10_000,
      longitude: 2.3 + index / 10_000,
    }));

    const result = await provider(costs).matrix(
      destinations.map((to) => ({ from: origin, to })),
      "2026-10-21",
      "Europe/Paris",
    );

    expect(requests).toHaveLength(2);
    expect(requests.map(({ body }) => (body.destinations as unknown[]).length).sort((a, b) => a - b)).toEqual([1, 100]);
    expect(costs.sort((a, b) => a - b)).toEqual([1, 100]);
    for (const request of requests) {
      expect(request.url).toBe("https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix");
      expect(request.init.method).toBe("POST");
      expect(new Headers(request.init.headers).get("X-Goog-FieldMask"))
        .toBe("originIndex,destinationIndex,status,condition,duration");
      expect(request.body).toMatchObject({
        origins: [{ waypoint: { location: { latLng: { latitude: 48.8566, longitude: 2.3522 } } } }],
        travelMode: "TRANSIT",
        departureTime: "2026-10-21T07:00:00Z",
        languageCode: "zh-TW",
      });
      expect((request.body.destinations as unknown[]).length).toBeLessThanOrEqual(100);
    }
    expect(result).toHaveLength(101);
    expect(result[0]).toMatchObject({
      fromId: "origin",
      toId: "destination-0",
      minutes: 21,
      lines: ["大眾運輸／步行"],
    });
    expect(result[100]).toMatchObject({ fromId: "origin", toId: "destination-100", minutes: 21 });
  });

  it("rejects a missing route so the day planner keeps the straight-line leg estimate", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([{
      originIndex: 0,
      destinationIndex: 0,
      status: {},
      condition: "ROUTE_NOT_FOUND",
    }])));

    await expect(provider().matrix(
      [{ from: origin, to: destination }],
      "2026-10-21",
      "Europe/Paris",
    )).rejects.toMatchObject({ code: "transit_unavailable" });
  });
});

describe("Google Routes transit shapes", () => {
  it("decodes encoded polylines to GeoJSON longitude/latitude with transit and walk properties", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({
        routes: [{
          legs: [{
            steps: [
              {
                travelMode: "TRANSIT",
                polyline: { encodedPolyline: "_p~iF~ps|U_ulLnnqC_mqNvxq`@" },
                transitDetails: { transitLine: { color: "#1A73E8" } },
              },
              {
                travelMode: "WALK",
                polyline: { encodedPolyline: "_p~iF~ps|U_ulLnnqC_mqNvxq`@" },
              },
            ],
          }],
        }],
      }))
      .mockResolvedValueOnce(Response.json({ routes: [] }));
    vi.stubGlobal("fetch", fetch);
    const routes = provider();

    const shape = await routes.shape(origin, destination, "2026-10-21", "Europe/Paris", new AbortController().signal);
    const missing = await routes.shape(origin, destination, "2026-10-21", "Europe/Paris", new AbortController().signal);

    expect(shape).toEqual({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: [[-120.2, 38.5], [-120.95, 40.7], [-126.453, 43.252]],
          },
          properties: { ways: "transport", inline: { color: "#1A73E8" } },
        },
        {
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: [[-120.2, 38.5], [-120.95, 40.7], [-126.453, 43.252]],
          },
          properties: { ways: "walk", inline: { color: null } },
        },
      ],
    });
    expect(missing).toBeNull();
    const firstBody = JSON.parse(String(fetch.mock.calls[0]![1]?.body));
    expect(firstBody).toMatchObject({
      travelMode: "TRANSIT",
      departureTime: "2026-10-21T07:00:00Z",
      polylineEncoding: "ENCODED_POLYLINE",
    });
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).get("X-Goog-FieldMask"))
      .toBe("routes.legs.steps.polyline.encodedPolyline,routes.legs.steps.travelMode,routes.legs.steps.transitDetails.transitLine.color");
  });

  it("refunds a reservation when aborted before fetch but charges it once fetch starts", async () => {
    const beforeFetchRefund = vi.fn(async () => {});
    const beforeFetchController = new AbortController();
    const beforeFetch = new GoogleRoutesProvider({
      apiKey: "test-google-routes-key",
      reserveBudget: async () => {
        beforeFetchController.abort();
        return { refund: beforeFetchRefund };
      },
    });
    const fetch = vi.fn(async () => {
      throw new DOMException("Aborted", "AbortError");
    });
    vi.stubGlobal("fetch", fetch);

    await expect(beforeFetch.shape(origin, destination, "2026-10-21", "Europe/Paris", beforeFetchController.signal))
      .rejects.toMatchObject({ code: "transit_unavailable" });
    expect(fetch).not.toHaveBeenCalled();
    expect(beforeFetchRefund).toHaveBeenCalledOnce();

    const afterFetchRefund = vi.fn(async () => {});
    const afterFetch = new GoogleRoutesProvider({
      apiKey: "test-google-routes-key",
      reserveBudget: async () => ({ refund: afterFetchRefund }),
    });
    await expect(afterFetch.shape(origin, destination, "2026-10-21", "Europe/Paris", new AbortController().signal))
      .rejects.toMatchObject({ code: "transit_unavailable" });
    expect(fetch).toHaveBeenCalledOnce();
    expect(afterFetchRefund).not.toHaveBeenCalled();
  });
});
