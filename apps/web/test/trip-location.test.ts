// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  readTripLocation,
  readTripOverviewFilter,
  writeTripLocation,
  writeTripOverviewFilter,
} from "../src/trip-location";

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
    ["members", "people"],
    ["members", "profile"],
    ["members", "invites"],
    ["members", "permissions"],
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
    ["recent", "members", "people"],
  ] as const)("normalizes legacy tab=%s to %s/%s", (legacy, tab, segment) => {
    history.replaceState({}, "", `/?trip=trip-1&tab=${legacy}`);

    const location = readTripLocation();
    expect(location).toMatchObject({ tab, segment, needsReplace: true });
    writeTripLocation("trip-1", location.tab!, location.segment, null, true);
    expect(new URLSearchParams(window.location.search).get("tab")).toBe(tab);
    expect(new URLSearchParams(window.location.search).get("segment")).toBe(segment);
  });
});

describe("trip overview filters", () => {
  it("keeps only real ISO dates, deduplicated and sorted", () => {
    history.replaceState({}, "", "/?days=2028-02-29,2026-11-03,2026-02-29,2026-04-31,2028-02-29,nope");

    expect(readTripOverviewFilter()).toEqual({
      days: ["2026-11-03", "2028-02-29"],
    });
  });

  it("preserves unrelated query and hash values and uses replaceState", () => {
    history.replaceState({}, "", "/?trip=trip-1&tab=itinerary&segment=daily&day=2026-11-03#details");
    const replace = vi.spyOn(history, "replaceState");
    const push = vi.spyOn(history, "pushState");

    writeTripOverviewFilter(["2026-11-05", "2026-11-03", "2026-11-05", "invalid"]);

    expect(new URL(location.href).searchParams.get("days")).toBe("2026-11-03,2026-11-05");
    expect(new URL(location.href).searchParams.get("trip")).toBe("trip-1");
    expect(new URL(location.href).searchParams.get("tab")).toBe("itinerary");
    expect(new URL(location.href).searchParams.get("segment")).toBe("daily");
    expect(new URL(location.href).searchParams.get("day")).toBe("2026-11-03");
    expect(location.hash).toBe("#details");
    expect(replace).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
  });

  it("removes empty filters and notifies an already-mounted overview", () => {
    history.replaceState({}, "", "/?trip=trip-1&days=2026-11-03");
    const changed = vi.fn();
    window.addEventListener("trip-overview-filter-change", changed);

    writeTripOverviewFilter([]);

    expect(new URLSearchParams(location.search).has("days")).toBe(false);
    expect(changed).toHaveBeenCalledTimes(1);
    window.removeEventListener("trip-overview-filter-change", changed);
  });

  it("clears the filter when the trip changes and preserves it within the same trip", () => {
    history.replaceState({}, "", "/?trip=trip-1&tab=today&days=2026-11-03");

    writeTripLocation("trip-1", "itinerary", "daily", null);
    expect(new URLSearchParams(location.search).get("days")).toBe("2026-11-03");

    writeTripLocation("trip-2", "today", null, null);
    expect(new URLSearchParams(location.search).has("days")).toBe(false);
  });
});
