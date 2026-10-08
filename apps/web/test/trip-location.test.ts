// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { readTripLocation, writeTripLocation } from "../src/trip-location";

beforeEach(() => {
  history.replaceState({}, "", "/");
});

describe("trip workspace locations", () => {
  it.each([
    ["today", null],
    ["itinerary", "daily"],
    ["itinerary", "flight"],
    ["itinerary", "lodging"],
    ["places", "wishlist"],
    ["places", "discovery"],
    ["members", null],
  ] as const)("keeps the canonical %s/%s destination", (tab, segment) => {
    const query = new URLSearchParams({ trip: "trip-1", tab });
    if (segment) query.set("segment", segment);
    history.replaceState({}, "", `/?${query}`);

    expect(readTripLocation()).toMatchObject({ tab, segment, needsReplace: false });
    writeTripLocation("trip-1", tab, segment, null, true);
    expect(new URLSearchParams(location.search).get("tab")).toBe(tab);
    expect(new URLSearchParams(location.search).get("segment")).toBe(segment);
  });

  it.each([
    ["overview", "itinerary", "flight"],
    ["itinerary", "itinerary", "daily"],
    ["lodging", "itinerary", "lodging"],
    ["wishlist", "places", "wishlist"],
    ["discovery", "places", "discovery"],
    ["recent", "members", null],
  ] as const)("normalizes legacy tab=%s to %s/%s", (legacy, tab, segment) => {
    history.replaceState({}, "", `/?trip=trip-1&tab=${legacy}`);

    const location = readTripLocation();
    expect(location).toMatchObject({ tab, segment, needsReplace: true });
    writeTripLocation("trip-1", location.tab!, location.segment, null, true);
    expect(new URLSearchParams(window.location.search).get("tab")).toBe(tab);
    expect(new URLSearchParams(window.location.search).get("segment")).toBe(segment);
  });
});
