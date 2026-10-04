import { describe, expect, it } from "vitest";

import type { DayHours } from "../src/planning/opening-hours";
import {
  distributePlaces,
  preferencePriority,
  type DistributionCandidate,
  type DistributionDay,
} from "../src/planning/trip-distribution";

const open: DayHours = { status: "unknown" };
const closed: DayHours = { status: "closed", reason: "closed_that_day" };

const eikando = { id: "eikando", latitude: 35.0149, longitude: 135.7942, stayMinutes: 60 };
const tofukuji = { id: "tofukuji", latitude: 34.976, longitude: 135.7738, stayMinutes: 60 };

function day(id: string, date: string, overrides: Partial<DistributionDay> = {}): DistributionDay {
  return {
    id,
    date,
    windowMinutes: 600,
    fixedMinutes: 0,
    start: null,
    end: null,
    kept: [],
    unmappedStays: [],
    fixedPoints: [],
    ...overrides,
  };
}

function candidate(
  id: string,
  latitude: number,
  longitude: number,
  overrides: Partial<Omit<DistributionCandidate, "hours">> & { closedOn?: string[] } = {},
): DistributionCandidate {
  const { closedOn = [], ...rest } = overrides;
  return {
    id,
    latitude,
    longitude,
    stayMinutes: 60,
    priority: 3,
    hours: (dayId) => (closedOn.includes(dayId) ? closed : open),
    ...rest,
  };
}

describe("distributing wishlist places over days", () => {
  it("joins the day with the nearest planned place, and starts an empty day for a far one", async () => {
    const days = [
      day("d21", "2026-10-21", { kept: [eikando] }),
      day("d22", "2026-10-22", { kept: [tofukuji] }),
      day("d23", "2026-10-23"),
    ];
    const result = distributePlaces(days, [
      // Beside Tofuku-ji: the 22nd, although the 21st is earlier and has room.
      candidate("komyoin", 34.9746, 135.7727),
      // About 95 km away: nothing nearby, so the first day without places.
      candidate("ine", 35.6757, 135.2875, { stayMinutes: 90 }),
      candidate("ine-bay", 35.67, 135.29),
    ]);

    expect(Object.fromEntries(result.added)).toEqual({ d21: [], d22: ["komyoin"], d23: ["ine", "ine-bay"] });
    expect(result.unplaced).toEqual([]);
  });

  it("skips days a place is closed and reports a place closed on every day", async () => {
    const days = [day("d21", "2026-10-21", { kept: [tofukuji] }), day("d22", "2026-10-22")];
    const result = distributePlaces(days, [
      candidate("komyoin", 34.9746, 135.7727, { closedOn: ["d21"] }),
      candidate("museum", 34.99, 135.76, { closedOn: ["d21", "d22"] }),
    ]);

    expect(Object.fromEntries(result.added)).toEqual({ d21: [], d22: ["komyoin"] });
    expect(result.unplaced).toEqual([{ id: "museum", reason: "closed_all_trip_days" }]);
  });

  it("plans a must before a disliked place listed earlier, within the 70% load limit", async () => {
    const days = [day("d21", "2026-10-21", { windowMinutes: 100 })];
    const result = distributePlaces(days, [
      candidate("disliked", 34.98, 135.75, { priority: 4 }),
      candidate("must", 34.98, 135.75, { priority: 0, stayMinutes: 70 }),
    ]);

    expect(result.added.get("d21")).toEqual(["must"]);
    expect(result.unplaced).toEqual([{ id: "disliked", reason: "no_day_fits" }]);
    expect(distributePlaces(days, [candidate("long", 34.98, 135.75, { stayMinutes: 71 })]).unplaced)
      .toEqual([{ id: "long", reason: "no_day_fits" }]);
  });

  it("counts fixed time and the round trip from the lodging against the limit", async () => {
    const hotel = { id: "hotel", latitude: 34.9853, longitude: 135.7586 };
    // 600-minute window, 300 minutes of fixed items: 120 minutes left under the 70% limit.
    const days = [day("d21", "2026-10-21", { fixedMinutes: 300, start: hotel, end: hotel })];
    const near = candidate("station", 34.9858, 135.7588, { stayMinutes: 100 });
    const far = candidate("tofukuji", 34.976, 135.7738, { stayMinutes: 100 });

    // The station is a minute's walk each way; Tofuku-ji is about 15 + 4 minutes each way.
    expect(distributePlaces(days, [near]).added.get("d21")).toEqual(["station"]);
    expect(distributePlaces(days, [far]).unplaced).toEqual([{ id: "tofukuji", reason: "no_day_fits" }]);
  });

  it("counts places without a map location as taking the day's time and making it not empty", async () => {
    // The 21st holds a café added by hand without a location; the 22nd is empty.
    const days = [
      day("d21", "2026-10-21", { unmappedStays: [120] }),
      day("d22", "2026-10-22"),
    ];
    const ine = candidate("ine", 35.6757, 135.2875);
    expect(Object.fromEntries(distributePlaces(days, [ine]).added)).toEqual({ d21: [], d22: ["ine"] });
    // Tofuku-ji and 300 minutes of unmapped stays leave under 60 minutes below the 420-minute limit.
    const full = [day("d21", "2026-10-21", { kept: [tofukuji], unmappedStays: [150, 150] })];
    expect(distributePlaces(full, [candidate("komyoin", 34.9746, 135.7727, { stayMinutes: 60 })]).unplaced)
      .toEqual([{ id: "komyoin", reason: "no_day_fits" }]);
  });

  it("ranks a place by the best preference any member gave it, unrated as neutral", async () => {
    expect(preferencePriority([])).toBe(3);
    expect(preferencePriority([null])).toBe(3);
    expect(preferencePriority(["dislike"])).toBe(4);
    expect(preferencePriority(["dislike", "must"])).toBe(0);
    expect(preferencePriority(["optional", null, "want"])).toBe(1);
  });
});
