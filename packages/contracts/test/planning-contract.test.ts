import { describe, expect, it } from "vitest";

import { parseDayRouteResponse } from "../src/day-plans";
import { parseMapsConfigResponse } from "../src/maps";

const validRouteResponse = {
  route: {
    dayId: "day-1",
    date: "2026-10-22",
    version: 3,
    order: "suggested",
    orderedTripPlaceIds: ["place-1"],
    startsAt: {
      placeId: "hotel-1",
      name: "Morning hotel",
      latitude: null,
      longitude: null,
      providerPlaceId: null,
    },
    endsAt: null,
    stops: [{
      tripPlaceId: "place-1",
      name: "Temple",
      latitude: 35.01,
      longitude: 135.76,
      providerPlaceId: "google-place-1",
      metersFromPrevious: null,
      minutesFromPrevious: null,
      linesFromPrevious: [],
      estimatedMoveMinutesFromPrevious: null,
      stayMinutes: 90,
      stayEstimated: true,
    }],
    metersToEnd: 123,
    totalMeters: 123,
    travelSource: "straight_line",
    transitProvider: null,
    routeShapesAvailable: false,
    minutesToEnd: null,
    linesToEnd: [],
    totalMinutes: null,
    transitMatrix: [],
    transitCallsNeeded: 0,
    transitCacheDays: null,
    dayStartMinute: 540,
    fixedMinutes: 0,
    estimatedMoveMinutesToEnd: 7,
    frame: null,
    orderBasis: "distance",
    orderReason: "no_frame",
  },
} as const;

describe("parseDayRouteResponse", () => {
  it("accepts a complete route including unlocated lodging and unknown legs", () => {
    expect(parseDayRouteResponse(validRouteResponse)).toEqual(validRouteResponse);
  });

  it("reads a route from an API without timing fields as unknown timing", () => {
    const { dayStartMinute: _start, fixedMinutes: _fixed, estimatedMoveMinutesToEnd: _end, frame: _frame, orderBasis: _basis, orderReason: _reason, ...older } = validRouteResponse.route;
    const { estimatedMoveMinutesFromPrevious: _move, stayMinutes: _stay, stayEstimated: _estimated, ...olderStop } = validRouteResponse.route.stops[0];
    const { route } = parseDayRouteResponse({ route: { ...older, stops: [olderStop] } });
    expect(route).toMatchObject({ dayStartMinute: null, fixedMinutes: null, estimatedMoveMinutesToEnd: null, frame: null, orderBasis: null, orderReason: null });
    expect(route.stops[0]).toMatchObject({ estimatedMoveMinutesFromPrevious: null, stayMinutes: null, stayEstimated: false });
  });

  it.each([
    ["missing route", {}],
    ["unknown order", { route: { ...validRouteResponse.route, order: "fastest" } }],
    ["negative version", { route: { ...validRouteResponse.route, version: -1 } }],
    ["non-integer distance", { route: { ...validRouteResponse.route, totalMeters: 1.5 } }],
    ["invalid nullable coordinate", {
      route: {
        ...validRouteResponse.route,
        startsAt: { ...validRouteResponse.route.startsAt, latitude: "35" },
      },
    }],
    ["invalid stop list", { route: { ...validRouteResponse.route, stops: null } }],
    ["non-boolean stay estimate", {
      route: { ...validRouteResponse.route, stops: [{ ...validRouteResponse.route.stops[0], stayEstimated: "yes" }] },
    }],
    ["negative stay minutes", {
      route: { ...validRouteResponse.route, stops: [{ ...validRouteResponse.route.stops[0], stayMinutes: -5 }] },
    }],
  ])("rejects %s", (_name, value) => {
    expect(() => parseDayRouteResponse(value)).toThrow("Invalid day route response");
  });
});

describe("parseMapsConfigResponse", () => {
  it("accepts configured and explicitly unavailable browser settings", () => {
    expect(parseMapsConfigResponse({ browserKey: "browser-key", mapId: null })).toEqual({
      browserKey: "browser-key",
      mapId: null,
    });
  });

  it.each([
    ["a missing key", { mapId: null }],
    ["an undefined map id", { browserKey: null, mapId: undefined }],
    ["a numeric browser key", { browserKey: 42, mapId: null }],
    ["a non-object response", null],
  ])("rejects %s", (_name, value) => {
    expect(() => parseMapsConfigResponse(value)).toThrow("Invalid maps config response");
  });
});
