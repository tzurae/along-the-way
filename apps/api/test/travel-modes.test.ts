import type { DayLegDto, TravelMode } from "@along-the-way/contracts/day-plans";
import type { RouteMode, RouteObservation } from "@along-the-way/contracts/planning-observations";
import { describe, expect, it } from "vitest";

import { scheduleDay, type TimetableStop } from "../src/planning/day-timetable";
import { legFor, taxiAlternative, visitIds } from "../src/planning/travel-modes";

const names = { fromName: "A", toName: "B" };

function observed(mode: RouteMode, durationMinutes: number | null): RouteObservation {
  const source = {
    originPlaceId: "a", destinationPlaceId: "b", requestedDepartureTime: "2026-11-02T00:00:00Z", mode,
    provider: "test", attribution: "Test routes", observedAt: "2026-11-01T00:00:00Z", expiresAt: "2026-11-01T00:15:00Z",
  };
  return durationMinutes === null
    ? { ...source, status: "unavailable", reason: "no_route", durationMinutes: null, distanceMeters: null, walkingLegMinutes: null }
    : { ...source, status: "available", durationMinutes, distanceMeters: 1000, walkingLegMinutes: [], manualChecks: [], warnings: [] };
}

describe("a leg travelled the day's way", () => {
  it("walks within the limit and takes transit beyond it", () => {
    expect(legFor([observed("walking", 15), observed("transit", 12)], names, "transit", 15)).toMatchObject({ mode: "walking", durationMinutes: 15 });
    expect(legFor([observed("walking", 16), observed("transit", 12)], names, "transit", 15)).toMatchObject({ mode: "transit", durationMinutes: 12 });
    expect(legFor([observed("walking", 28), observed("transit", 12)], names, "walk", 30)).toMatchObject({ mode: "walking", durationMinutes: 28 });
  });

  it("is unknown, not a long walk, when transit is missing beyond the walk limit", () => {
    const leg = legFor([observed("walking", 40), observed("transit", null)], names, "transit", 15);
    expect(leg).toMatchObject({ mode: null, durationMinutes: null, walkingMinutes: 40, unavailableReason: "no_route" });
  });

  it.each(["provider_not_configured", "quota", "timeout", "provider_unavailable"] as const)
    ("estimates missing transit for %s without inventing a provider duration", (reason) => {
      const missing: RouteObservation = {
        ...observed("transit", null), status: "unavailable", reason,
        durationMinutes: null, distanceMeters: null, walkingLegMinutes: null,
      };
      expect(legFor([observed("walking", 40), missing], names, "transit", 15, 23)).toMatchObject({
        mode: "transit", durationMinutes: 23, estimated: true, transitMinutes: null,
        attribution: null, unavailableReason: reason,
      });
      expect(legFor([observed("walking", 10), missing], names, "transit", 15, 23)).toMatchObject({
        mode: "walking", durationMinutes: 10, estimated: false, unavailableReason: null,
      });
    });

  it("preserves joined missing-data reasons in an estimate", () => {
    const missing = (reason: "quota" | "provider_not_configured"): RouteObservation => ({
      ...observed("transit", null), status: "unavailable", reason,
      durationMinutes: null, distanceMeters: null, walkingLegMinutes: null,
    });
    expect(legFor([missing("quota"), missing("provider_not_configured"), missing("quota")], names, "transit", 15, 23).unavailableReason)
      .toBe("quota, provider_not_configured");
  });

  it("is a taxi ride: the drive plus time to get a cab, unknown without a drive", () => {
    expect(legFor([observed("drive", 10)], names, "taxi", 15)).toMatchObject({ mode: "taxi", durationMinutes: 15 });
    expect(legFor([observed("drive", null)], names, "taxi", 15)).toMatchObject({ mode: null, durationMinutes: null });
  });
});

describe("taxi when a dropped place does not fit", () => {
  // Minutes by leg and way: "new" is far from "first" and a short walk from "last".
  const minutes: Record<string, Partial<Record<TravelMode, number>>> = {
    "first>new": { transit: 40, walk: 40, taxi: 20 },
    "new>last": { transit: 2, walk: 2, taxi: 9 },
    "first>last": { transit: 40, walk: 40, taxi: 20 },
  };
  const stops: TimetableStop[] = ["first", "new", "last"].map((id) => ({
    id, name: id, type: "other", durationMinutes: 60, hours: { status: "unknown", cause: "manual" },
  }));
  const draft = (orderedIds: string[], legModes: Record<string, TravelMode>) => scheduleDay({
    // first 9:00–10:00, then new, then last: by taxi into new only, last ends 9:00 + 60 + 20 + 60 + 2 + 60 = 12:22.
    window: { startMinute: 540, endMinute: 742 },
    start: null, end: null, arrivalItemId: null, dropLuggage: null, collectLuggageBeforeItemId: null, blocks: [],
    stops: orderedIds.map((id) => stops.find((stop) => stop.id === id)!),
    travel: async (from, to): Promise<DayLegDto> => {
      const mode = legModes[to] ?? "transit";
      const duration = minutes[`${from}>${to}`]?.[mode] ?? null;
      return { ...names, mode: mode === "taxi" ? "taxi" : "transit", durationMinutes: duration, walkingMinutes: null, transitMinutes: null, estimated: false, attribution: null, unavailableReason: null };
    },
  });

  it("takes a cab for only the leg that a cab shortens when a cab for both would not fit", async () => {
    const orderedIds = ["first", "new", "last"];
    // As the day travels it ends 12:42; a cab both ways ends 12:29; neither fits by 12:22.
    expect(visitIds(await draft(orderedIds, {})).has("last")).toBe(false);
    expect(visitIds(await draft(orderedIds, { new: "taxi", last: "taxi" })).has("last")).toBe(false);
    const alternative = await taxiAlternative({ orderedIds, placeId: "new", legModes: {}, draft });
    expect(alternative?.legModes).toEqual({ new: "taxi" });
    expect([...visitIds(alternative!.result)]).toEqual(["first", "new", "last"]);
  });

  it("offers nothing when the place already fits as the day travels", async () => {
    expect(await taxiAlternative({ orderedIds: ["new", "last"], placeId: "new", legModes: {}, draft })).toBeNull();
  });
});
