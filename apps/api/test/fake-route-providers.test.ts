import { describe, expect, it } from "vitest";
import type { RouteObservationQuery } from "@along-the-way/contracts/planning-observations";
import { FakePlaceHours, FakeRouteProvider } from "../src/planning/fake-route-providers";

const NOW = new Date("2026-10-01T00:00:00Z");
const ONE_KILOMETER_AT_EQUATOR = 0.008993216059187304;
const query: RouteObservationQuery = {
  origin: { placeId: "origin", latitude: 0, longitude: 0 },
  destination: { placeId: "destination", latitude: 0, longitude: ONE_KILOMETER_AT_EQUATOR },
  departureTime: "2026-10-02T09:00:00+09:00",
};

describe("fake external planning data", () => {
  it("estimates requested route modes from straight-line distance in caller order", async () => {
    const observations = await new FakeRouteProvider({ now: () => NOW }).observe({
      ...query,
      modes: ["drive", "walking", "transit"],
    });

    expect(observations).toEqual([
      expect.objectContaining({
        status: "available", mode: "drive", durationMinutes: 5, distanceMeters: 1000,
        walkingLegMinutes: [], attribution: "Fake routes",
      }),
      expect.objectContaining({
        status: "available", mode: "walking", durationMinutes: 13, distanceMeters: 1000,
        walkingLegMinutes: [13], attribution: "Fake routes",
      }),
      expect.objectContaining({
        status: "available", mode: "transit", durationMinutes: 10, distanceMeters: 1000,
        walkingLegMinutes: [], attribution: "Fake routes",
      }),
    ]);
    expect(observations.every((entry) => entry.requestedDepartureTime === "2026-10-02T00:00:00Z")).toBe(true);
  });

  it("defaults to walking then transit and offers no transit at 0.8 km or less", async () => {
    const provider = new FakeRouteProvider({ now: () => NOW });
    const observations = await provider.observe({
      ...query,
      destination: { ...query.destination, longitude: ONE_KILOMETER_AT_EQUATOR / 2 },
    });

    expect(observations[0]).toMatchObject({ status: "available", mode: "walking", durationMinutes: 7, distanceMeters: 500 });
    expect(observations[1]).toMatchObject({ status: "unavailable", mode: "transit", reason: "no_route" });
  });

  it("derives stable weekly hours from the provider place ID", async () => {
    const hours = new FakePlaceHours();
    const first = await hours.openingHours("place-b");
    const repeated = await hours.openingHours("place-b");

    expect(repeated).toEqual(first);
    expect(first).toMatchObject({ businessStatus: "operational", current: null });
    expect(first.regular).toHaveLength(6);
    expect(first.regular?.map((period) => period.open.day)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(first.regular?.every((period) => period.open.hour === 9 && period.close?.hour === 17)).toBe(true);

    await expect(hours.openingHours("place-a")).resolves.toEqual({
      businessStatus: "operational",
      current: null,
      regular: [{ open: { day: 0, hour: 0, minute: 0, date: null }, close: null }],
    });
    expect((await hours.openingHours("place-c")).regular?.[0]?.close?.hour).toBe(17);
    expect((await hours.openingHours("place-d")).regular?.[0]?.close?.hour).toBe(20);
  });
});
