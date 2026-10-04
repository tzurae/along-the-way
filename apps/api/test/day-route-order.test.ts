import { describe, expect, it } from "vitest";

import { orderByStraightLine, type GeoPoint } from "../src/planning/day-route-order";

// Near the equator one degree of latitude or longitude is about 111 km.
const point = (id: string, latitude: number, longitude: number): GeoPoint => ({ id, latitude, longitude });

// A 1 x 4 degree rectangle: short sides A–D and B–C, long sides A–B and D–C.
// D–C sits at latitude 1, so it is slightly shorter than A–B.
const a = point("a", 0, 0);
const b = point("b", 0, 4);
const c = point("c", 1, 4);
const d = point("d", 1, 0);

describe("orderByStraightLine", () => {
  it("finds the shortest open path when no lodging is known", () => {
    // Walking both short sides and the shorter long side beats every other path.
    expect([["a", "d", "c", "b"], ["b", "c", "d", "a"]]).toContainEqual(
      orderByStraightLine([a, b, c, d], null),
    );
  });

  it("leaves from and returns to the lodging when one is known", () => {
    // Lodging west of A and D: the round trip must start and end next to it.
    const lodging = point("lodging", 0.5, -1);
    expect([["a", "b", "c", "d"], ["d", "c", "b", "a"]]).toContainEqual(
      orderByStraightLine([a, b, c, d], lodging),
    );
  });

  it("returns the same order whatever order the places were listed in", () => {
    const lodging = point("lodging", 0.5, -1);
    const expected = orderByStraightLine([a, b, c, d], lodging);
    for (const listed of [[d, c, b, a], [c, a, d, b], [b, d, a, c]]) {
      expect(orderByStraightLine(listed, lodging)).toEqual(expected);
    }
  });

  it("still finds the straight-line order for days with many places", () => {
    // Twelve places on one line exceed the exhaustive search. The search starts
    // from the lowest id, "a", in the middle, so a greedy walk alone would
    // double back and the path must be repaired.
    const ids = ["m", "j", "g", "d", "b", "a", "c", "e", "f", "h", "i", "l"];
    const line = ids.map((id, index) => point(id, 0, index * 0.01));
    const shuffled = [7, 2, 11, 0, 5, 9, 1, 10, 4, 8, 3, 6].map((index) => line[index]!);
    expect([ids, [...ids].reverse()]).toContainEqual(orderByStraightLine(shuffled, null));
  });
});
