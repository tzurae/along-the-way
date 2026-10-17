import { describe, expect, it } from "vitest";

import { straightLineMeters } from "../src/planning/day-route-order";
import { buildDayRoute, type DayRouteInput, type RoutePlace } from "../src/planning/day-route";

const place = (id: string, latitude: number | null, longitude: number | null): RoutePlace => ({ id, name: id, latitude, longitude, providerPlaceId: null });

/** Deterministic pseudo-random numbers so every run checks the same days. */
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Places scattered over roughly 20 km around Kyoto. */
function scatter(count: number, seed: number): RoutePlace[] {
  const random = seeded(seed);
  return Array.from({ length: count }, (_, index) => place(`p${index}`, 34.9 + random() * 0.2, 135.65 + random() * 0.2));
}

type Located = RoutePlace & { latitude: number; longitude: number };

/** The length the dialog shows: start lodging → stops → night lodging, skipping missing ends. */
function shownLength(order: Located[], start: Located | null, end: Located | null) {
  let total = 0;
  let previous = start;
  for (const stop of order) {
    if (previous) total += straightLineMeters(previous, stop);
    previous = stop;
  }
  if (end && order.length > 0) total += straightLineMeters(order.at(-1)!, end);
  return total;
}

function* permutations<T>(items: T[]): Generator<T[]> {
  if (items.length <= 1) {
    yield items;
    return;
  }
  for (let index = 0; index < items.length; index += 1) {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const tail of permutations(rest)) yield [items[index]!, ...tail];
  }
}

function shortestOrder(stops: Located[], start: Located | null, end: Located | null) {
  let best = { order: stops, length: Number.POSITIVE_INFINITY };
  for (const order of permutations(stops)) {
    const length = shownLength(order, start, end);
    if (length < best.length) best = { order, length };
  }
  return best;
}

function day(overrides: Partial<DayRouteInput> & Pick<DayRouteInput, "order" | "planned">): DayRouteInput {
  return { dayId: "d", date: "2026-10-22", version: 1, morningLodging: null, nightLodging: null, ...overrides };
}

const lodging = (value: RoutePlace | null) => (value ? { place: value } : null);
const westLodging = place("west-hotel", 35.0, 135.6);
const eastLodging = place("east-hotel", 35.05, 135.9);
const unmappedLodging = place("unmapped-hotel", null, null);

/** Every way the day can start and end once lodging without coordinates counts as no lodging. */
const ENDPOINTS: { name: string; morning: RoutePlace | null; night: RoutePlace | null; start: Located | null; end: Located | null }[] = [
  { name: "no lodging", morning: null, night: null, start: null, end: null },
  { name: "only a morning lodging", morning: westLodging, night: null, start: westLodging as Located, end: null },
  { name: "only a night lodging", morning: null, night: eastLodging, start: null, end: eastLodging as Located },
  { name: "the same lodging both ends", morning: westLodging, night: westLodging, start: westLodging as Located, end: westLodging as Located },
  { name: "different lodgings", morning: westLodging, night: eastLodging, start: westLodging as Located, end: eastLodging as Located },
  { name: "lodgings without coordinates", morning: unmappedLodging, night: unmappedLodging, start: null, end: null },
];

const placesIn = (ids: string[], planned: RoutePlace[]) => ids.map((id) => planned.find((entry) => entry.id === id)! as Located);

describe("buildDayRoute suggested order", () => {
  for (const endpoint of ENDPOINTS) {
    it(`is the shortest shown route with ${endpoint.name}`, () => {
      for (let count = 2; count <= 7; count += 1) {
        for (let seed = 1; seed <= 4; seed += 1) {
          const planned = scatter(count, seed * 100 + count);
          const route = buildDayRoute(day({
            order: "suggested",
            planned,
            morningLodging: lodging(endpoint.morning),
            nightLodging: lodging(endpoint.night),
          }));
          const length = shownLength(placesIn(route.orderedTripPlaceIds, planned), endpoint.start, endpoint.end);
          expect(length).toBeCloseTo(shortestOrder(planned as Located[], endpoint.start, endpoint.end).length, 3);
        }
      }
    });
  }

  // Nine places exceed the exhaustive search, and for these days its nearest-neighbour + 2-opt result
  // is several kilometres longer than the best order (seed 2: 40.3 vs 33.1 km; seed 3 with both
  // lodgings: 62.3 vs 56.6 km). Saved in the best order, the suggestion must not make them longer.
  for (const [seed, endpoint] of [[2, ENDPOINTS[0]!], [3, ENDPOINTS[4]!]] as const) {
    it(`never suggests a longer route than the saved one on a large day with ${endpoint.name}`, () => {
      const best = shortestOrder(scatter(9, seed) as Located[], endpoint.start, endpoint.end);
      const input = { planned: best.order, morningLodging: lodging(endpoint.morning), nightLodging: lodging(endpoint.night) };
      const suggested = buildDayRoute(day({ order: "suggested", ...input }));
      const current = buildDayRoute(day({ order: "current", ...input }));
      expect(suggested.totalMeters).toBeLessThanOrEqual(current.totalMeters);
    });
  }

  it("keeps the saved order when an unlocated tail makes the suggested displayed total longer", () => {
    const morning = place("morning", 0, 0);
    const night = place("night", 0, 0.01);
    const b = place("b", 0, 0.01);
    const a = place("a", 0.01, 0.02);
    const unlocated = place("unlocated", null, null);
    const input = {
      planned: [b, a, unlocated],
      morningLodging: lodging(morning),
      nightLodging: lodging(night),
    };

    const current = buildDayRoute(day({ order: "current", ...input }));
    const suggested = buildDayRoute(day({ order: "suggested", ...input }));

    expect(suggested.orderedTripPlaceIds).toEqual(current.orderedTripPlaceIds);
    expect(suggested.totalMeters).toBeLessThanOrEqual(current.totalMeters);
  });

  it("does not depend on the order the places were listed in", () => {
    const planned = scatter(6, 7);
    const input = { morningLodging: lodging(westLodging), nightLodging: lodging(eastLodging) };
    const expected = buildDayRoute(day({ order: "suggested", planned, ...input })).orderedTripPlaceIds;
    for (const listed of [[...planned].reverse(), [planned[3]!, planned[0]!, planned[5]!, planned[1]!, planned[4]!, planned[2]!]]) {
      expect(buildDayRoute(day({ order: "suggested", planned: listed, ...input })).orderedTripPlaceIds).toEqual(expected);
    }
  });

  it("finds the shortest order for 2026-10-22, which starts at the airport hotel and ends in Kyoto", () => {
    const planned = [
      place("akaho", 34.997180199999995, 135.7408517),
      place("gyoen", 35.0230617, 135.7634452),
      place("voiture", 35.0166002, 135.7801868),
      place("nishio", 35.018731599999995, 135.7791612),
      place("kurama", 35.1181404, 135.7708892),
    ];
    const kix = place("kix", 34.4364202, 135.2428789) as Located;
    const mibu = place("mibu", 34.999780099999995, 135.7372933) as Located;
    const input = { planned, morningLodging: lodging(kix), nightLodging: lodging(mibu) };
    const current = buildDayRoute(day({ order: "current", ...input }));
    const suggested = buildDayRoute(day({ order: "suggested", ...input }));
    expect(suggested.totalMeters).toBeLessThanOrEqual(current.totalMeters);
    expect(shownLength(placesIn(suggested.orderedTripPlaceIds, planned), kix, mibu))
      .toBeCloseTo(shortestOrder(planned as Located[], kix, mibu).length, 3);
  });
});

describe("buildDayRoute distances", () => {
  const a = place("a", 35.0, 135.7);
  const b = place("b", 35.01, 135.71);

  it("measures from the morning lodging, between stops and to the night lodging, and totals the legs", () => {
    const route = buildDayRoute(day({ order: "current", planned: [a, b], morningLodging: lodging(westLodging), nightLodging: lodging(eastLodging) }));
    const legs = [
      Math.round(straightLineMeters(westLodging as Located, a as Located)),
      Math.round(straightLineMeters(a as Located, b as Located)),
    ];
    const toEnd = Math.round(straightLineMeters(b as Located, eastLodging as Located));
    expect(route.stops.map((stop) => stop.metersFromPrevious)).toEqual(legs);
    expect(route.metersToEnd).toBe(toEnd);
    expect(route.totalMeters).toBe(legs[0]! + legs[1]! + toEnd);
  });

  it("names lodging without coordinates but never measures from it as (0, 0)", () => {
    const route = buildDayRoute(day({ order: "suggested", planned: [a, b], morningLodging: lodging(unmappedLodging), nightLodging: lodging(unmappedLodging) }));
    expect(route.startsAt).toMatchObject({ name: "unmapped-hotel", latitude: null });
    expect(route.endsAt).toMatchObject({ name: "unmapped-hotel", latitude: null });
    expect(route.stops[0]!.metersFromPrevious).toBeNull();
    expect(route.metersToEnd).toBeNull();
    expect(route.totalMeters).toBe(route.stops[1]!.metersFromPrevious);
  });

  it("gives no first leg or end leg when the day has no lodging", () => {
    const route = buildDayRoute(day({ order: "current", planned: [a, b] }));
    expect(route.startsAt).toBeNull();
    expect(route.endsAt).toBeNull();
    expect(route.stops[0]!.metersFromPrevious).toBeNull();
    expect(route.metersToEnd).toBeNull();
  });

  it("puts places without coordinates last in saved order, without legs to them", () => {
    const unmappedOne = place("u1", null, null);
    const unmappedTwo = place("u2", null, null);
    const planned = [unmappedTwo, b, unmappedOne, a];
    for (const order of ["current", "suggested"] as const) {
      const route = buildDayRoute(day({ order, planned, morningLodging: lodging(westLodging), nightLodging: lodging(eastLodging) }));
      expect(route.orderedTripPlaceIds.slice(2)).toEqual(["u2", "u1"]);
      expect(route.stops.slice(2).map((stop) => stop.metersFromPrevious)).toEqual([null, null]);
      expect(route.metersToEnd).toBeNull();
    }
  });

  it("keeps the saved order for current and the requested order for custom, leaving out omitted places", () => {
    const c = place("c", 35.02, 135.72);
    expect(buildDayRoute(day({ order: "current", planned: [b, a, c] })).orderedTripPlaceIds).toEqual(["b", "a", "c"]);
    expect(buildDayRoute(day({ order: "custom", planned: [a, b, c], orderedIds: ["c", "a"] })).orderedTripPlaceIds).toEqual(["c", "a"]);
  });

  it("returns an empty route without legs for a day with no places", () => {
    const route = buildDayRoute(day({ order: "suggested", planned: [], morningLodging: lodging(westLodging), nightLodging: lodging(eastLodging) }));
    expect(route.stops).toEqual([]);
    expect(route.metersToEnd).toBeNull();
    expect(route.totalMeters).toBe(0);
  });
});
