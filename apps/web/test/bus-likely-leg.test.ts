import { describe, expect, it } from "vitest";

import type { DayRouteDto, DayRouteShapesResponse, TransitProvider } from "@along-the-way/contracts/day-plans";
import {
  BUS_LIKELY_LEG_MIN_METERS,
  busLikelyShapeLegs,
  isBusLikelyMinutesLeg,
} from "../src/bus-likely-leg";

function route(provider: TransitProvider, latitudeDelta: number): DayRouteDto {
  return {
    dayId: "day-1",
    date: "2026-10-22",
    version: 1,
    order: "suggested",
    orderedTripPlaceIds: ["from", "to"],
    startsAt: null,
    endsAt: null,
    stops: [
      {
        tripPlaceId: "from",
        name: "上賀茂神社",
        latitude: 35.0593,
        longitude: 135.7525,
        providerPlaceId: null,
        metersFromPrevious: null,
        minutesFromPrevious: null,
        linesFromPrevious: [],
      },
      {
        tripPlaceId: "to",
        name: "鴨川三角洲",
        latitude: 35.0593 + latitudeDelta,
        longitude: 135.7525,
        providerPlaceId: null,
        metersFromPrevious: 2_000,
        minutesFromPrevious: 28,
        linesFromPrevious: [],
      },
    ],
    metersToEnd: null,
    totalMeters: 2_000,
    travelSource: provider,
    transitProvider: provider,
    routeShapesAvailable: true,
    minutesToEnd: null,
    linesToEnd: [],
    totalMinutes: 28,
    transitMatrix: [],
    transitCallsNeeded: 0,
    transitCacheDays: 7,
  };
}

function shape(ways: ("walk" | "transport")[]): DayRouteShapesResponse["legs"][number] {
  return {
    fromId: "from",
    toId: "to",
    geojson: {
      type: "FeatureCollection",
      features: ways.map((way) => ({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [[135.7525, 35.0593], [135.7525, 35.0793]],
        },
        properties: { ways: way, inline: { color: null } },
      })),
    },
  };
}

describe("NAVITIME bus-likely leg classification", () => {
  it("flags a NAVITIME shape when every feature walks and the endpoints are at least 1500 m apart", () => {
    expect(busLikelyShapeLegs(route("navitime", 0.02), [shape(["walk", "walk"])])).toHaveLength(1);
  });

  it("keeps a walk-only shape normal below 1500 m", () => {
    expect(busLikelyShapeLegs(route("navitime", 0.01), [shape(["walk"])])).toHaveLength(0);
  });

  it("keeps a long leg normal when any shape feature uses transport", () => {
    expect(busLikelyShapeLegs(route("navitime", 0.02), [shape(["walk", "transport"])])).toHaveLength(0);
  });

  it("never flags a Google day", () => {
    expect(busLikelyShapeLegs(route("google_routes", 0.02), [shape(["walk"])])).toHaveLength(0);
  });

  it("flags NAVITIME minute data only when it is a long, walk-only timed leg", () => {
    const near = { latitude: 35.0593, longitude: 135.7525 };
    const far = { latitude: 35.0593 + latitudeFor(BUS_LIKELY_LEG_MIN_METERS + 1), longitude: 135.7525 };
    expect(isBusLikelyMinutesLeg("navitime", near, far, 20, [])).toBe(true);
    expect(isBusLikelyMinutesLeg("navitime", near, far, null, [])).toBe(false);
    expect(isBusLikelyMinutesLeg("navitime", near, far, 20, ["市營 4 號"])).toBe(false);
    expect(isBusLikelyMinutesLeg("google_routes", near, far, 20, [])).toBe(false);
    expect(isBusLikelyMinutesLeg("navitime", near, { latitude: null, longitude: null }, 20, [])).toBe(false);
  });

  it("classifies a 1499.6 m leg the same way on the map and in the list, even though its DTO metres round to 1500", () => {
    const leg = route("navitime", latitudeFor(1_499.6));
    const [from, to] = leg.stops;
    expect(Math.round(1_499.6)).toBe(BUS_LIKELY_LEG_MIN_METERS);
    expect(busLikelyShapeLegs(leg, [shape(["walk"])])).toHaveLength(0);
    expect(isBusLikelyMinutesLeg("navitime", from!, to!, 20, [])).toBe(false);
  });
});

/** Degrees of latitude for a straight-line distance on the 6 371 km sphere the app uses. */
function latitudeFor(meters: number) {
  return meters / (6_371_000 * Math.PI / 180);
}
