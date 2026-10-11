import type { DayLegDto } from "@along-the-way/contracts/day-plans";
import { describe, expect, it } from "vitest";

import {
  scheduleDay,
  type TimetableBlock,
  type TimetableInput,
  type TimetableStop,
} from "../src/planning/day-timetable";

/** Travel by unordered pair; unlisted pairs take 10 minutes, null means unknown. */
function travelTable(minutes: Record<string, number | null> = {}) {
  return async (from: string, to: string): Promise<DayLegDto> => {
    const key = [from, to].sort().join("|");
    const duration = key in minutes ? minutes[key]! : 10;
    return {
      fromName: from,
      toName: to,
      mode: duration === null ? null : "walking",
      durationMinutes: duration,
      walkingMinutes: duration,
      transitMinutes: null,
      estimated: false,
      attribution: duration === null ? null : "Test routes",
      unavailableReason: duration === null ? "no_route" : null,
    };
  };
}

function stop(id: string, overrides: Partial<TimetableStop> = {}): TimetableStop {
  return { id, name: id, type: "other", durationMinutes: 60, hours: { status: "unknown" }, ...overrides };
}

function input(overrides: Partial<TimetableInput>): TimetableInput {
  return {
    window: { startMinute: 9 * 60, endMinute: 19 * 60 },
    start: null,
    end: null,
    arrivalItemId: null,
    dropLuggage: null,
    collectLuggageBeforeItemId: null,
    stops: [],
    blocks: [],
    travel: travelTable(),
    ...overrides,
  };
}

function fixed(itemId: string, overrides: Partial<TimetableBlock>): TimetableBlock {
  return {
    itemId,
    title: itemId,
    itemType: "activity",
    startMinute: 0,
    endMinute: 0,
    startsBeforeDay: false,
    endsAfterDay: false,
    startPointId: null,
    endPointId: null,
    bufferMinutes: 0,
    bufferEstimated: false,
    afterBufferMinutes: 0,
    ...overrides,
  };
}

function visits(rows: Awaited<ReturnType<typeof scheduleDay>>["rows"]) {
  return rows.flatMap((row) => row.kind === "visit" ? [[row.tripPlaceId, row.startMinute, row.endMinute]] : []);
}

describe("single-day timetable", () => {
  it("skips a place that would still be open-ended at closing, and keeps placing the rest", async () => {
    const result = await scheduleDay(input({
      stops: [
        stop("a"),
        // Arrives 10:10; 90 minutes would run past the 11:00 close.
        stop("museum", { durationMinutes: 90, hours: { status: "open", intervals: [[9 * 60, 11 * 60]] } }),
        stop("b"),
      ],
    }));

    expect(result.unscheduled).toEqual([{ tripPlaceId: "museum", name: "museum", reason: "closes_too_early" }]);
    // Without lodging the day starts at the first place, with no travel into it.
    expect(result.rows[0]).toMatchObject({ kind: "visit", tripPlaceId: "a", travel: null, arriveMinute: 540 });
    expect(visits(result.rows)).toEqual([["a", 540, 600], ["b", 610, 670]]);
    expect(result.rows.some((row) => row.kind === "return" || row.kind === "start")).toBe(false);
  });

  it("drops a place whose return to the lodging would end after the day, but not a closer one after it", async () => {
    const result = await scheduleDay(input({
      window: { startMinute: 9 * 60, endMinute: 12 * 60 },
      start: { id: "hotel", name: "Hotel" },
      end: { id: "hotel", name: "Hotel" },
      stops: [stop("near"), stop("far"), stop("close")],
      travel: travelTable({ "far|near": 20, "far|hotel": 60 }),
    }));

    // near 09:10–10:10; far would end 11:30 and get back at 12:30.
    expect(result.unscheduled).toEqual([{ tripPlaceId: "far", name: "far", reason: "cannot_return_to_lodging" }]);
    expect(visits(result.rows)).toEqual([["near", 550, 610], ["close", 620, 680]]);
    expect(result.rows.at(-1)).toMatchObject({ kind: "return", arriveMinute: 690 });
  });

  it("keeps fixed items in place and moves a place behind one whose buffer it would miss", async () => {
    const flight: TimetableBlock = {
      itemId: "flight",
      title: "Night flight",
      itemType: "flight",
      startMinute: 22 * 60,
      endMinute: 24 * 60,
      startsBeforeDay: false,
      endsAfterDay: true,
      startPointId: "airport",
      endPointId: null,
      bufferMinutes: 0,
      bufferEstimated: false,
      afterBufferMinutes: 0,
    };
    const train: TimetableBlock = {
      itemId: "train",
      title: "Overnight train",
      itemType: "transport",
      startMinute: 0,
      endMinute: 10 * 60,
      startsBeforeDay: true,
      endsAfterDay: false,
      startPointId: "origin",
      endPointId: "station",
      bufferMinutes: 0,
      bufferEstimated: false,
      afterBufferMinutes: 0,
    };
    const lunch: TimetableBlock = {
      itemId: "lunch",
      title: "Lunch",
      itemType: "reservation",
      startMinute: 12 * 60,
      endMinute: 13 * 60,
      startsBeforeDay: false,
      endsAfterDay: false,
      startPointId: "restaurant",
      endPointId: "restaurant",
      bufferMinutes: 30,
      bufferEstimated: false,
      afterBufferMinutes: 0,
    };
    const result = await scheduleDay(input({
      stops: [stop("castle"), stop("garden")],
      blocks: [lunch, flight, train],
      // From the station the castle runs 10:10–11:10, reaching lunch at 11:40: in time for
      // 12:00, but not for the confirmed 30-minute buffer.
      travel: travelTable({ "castle|restaurant": 30 }),
    }));

    expect(result.rows.map((row) => row.kind === "fixed" ? row.itemId : row.kind === "visit" ? row.tripPlaceId : row.kind))
      .toEqual(["train", "lunch", "castle", "garden", "flight"]);
    expect(result.rows[0]).toMatchObject({ startMinute: 0, endMinute: 600, startsBeforeDay: true });
    expect(result.rows[1]).toMatchObject({ startMinute: 720, endMinute: 780, travel: null });
    // The garden would fit before lunch, but places keep their order; it follows the castle.
    expect(visits(result.rows)).toEqual([["castle", 810, 870], ["garden", 880, 940]]);
    expect(result.rows.at(-1)).toMatchObject({ itemId: "flight", endsAfterDay: true, travel: expect.objectContaining({ durationMinutes: 10 }) });
    expect(result.unscheduled).toEqual([]);
  });

  it("continues from where the last-ending fixed item leaves off and counts overlapping items once", async () => {
    const block = (itemId: string, startMinute: number, endMinute: number, point: string): TimetableBlock => ({
      itemId,
      title: itemId,
      itemType: "activity",
      startMinute,
      endMinute,
      startsBeforeDay: false,
      endsAfterDay: false,
      startPointId: point,
      endPointId: point,
      bufferMinutes: 0,
      bufferEstimated: false,
      afterBufferMinutes: 0,
    });
    const result = await scheduleDay(input({
      // An all-day tour ending at the station includes a lunch at a restaurant.
      blocks: [block("tour", 9 * 60, 17 * 60, "station"), block("lunch", 12 * 60, 13 * 60, "restaurant")],
      stops: [stop("bar")],
      travel: travelTable({ "bar|station": 5, "bar|restaurant": 40 }),
    }));

    expect(result.rows.at(-1)).toMatchObject({ kind: "visit", tripPlaceId: "bar", arriveMinute: 17 * 60 + 5 });
    expect(result.load.busyMinutes).toBe(8 * 60 + 5 + 60);
  });

  it("allows an estimated 30 minutes each way around a fixed item without a map location", async () => {
    const dinner: TimetableBlock = {
      itemId: "dinner",
      title: "Dinner with Ken",
      itemType: "meal",
      startMinute: 18 * 60,
      endMinute: 19 * 60 + 30,
      startsBeforeDay: false,
      endsAfterDay: false,
      startPointId: null,
      endPointId: null,
      bufferMinutes: 0,
      bufferEstimated: false,
      afterBufferMinutes: 0,
    };
    const result = await scheduleDay(input({
      window: { startMinute: 15 * 60, endMinute: 22 * 60 },
      stops: [stop("a"), stop("b"), stop("c")],
      blocks: [dinner],
    }));

    // b ends 17:10 and needs 30 minutes to dinner; c would end 18:20, so it goes after dinner.
    expect(result.rows.map((row) => row.kind === "fixed" ? row.itemId : row.kind === "visit" ? row.tripPlaceId : row.kind))
      .toEqual(["a", "b", "dinner", "c"]);
    expect(result.rows[2]).toMatchObject({
      startMinute: 18 * 60,
      travel: { fromName: "b", toName: "Dinner with Ken", durationMinutes: 30, estimated: true, mode: null },
    });
    expect(result.rows[3]).toMatchObject({
      arriveMinute: 20 * 60,
      travel: { fromName: "Dinner with Ken", toName: "c", durationMinutes: 30, estimated: true },
    });
    expect(result.unscheduled).toEqual([]);
  });

  it("rates the day by the share of the window spent staying and travelling", async () => {
    const level = async (stay: number) => (await scheduleDay(input({
      window: { startMinute: 600, endMinute: 700 },
      stops: [stop("only", { durationMinutes: stay })],
    }))).load.level;

    expect([await level(69), await level(70), await level(90), await level(91)])
      .toEqual(["relaxed", "balanced", "balanced", "packed"]);
  });

  describe("travel days", () => {
    const hotel = { id: "hotel", name: "Hotel" };
    const kinds = (rows: Awaited<ReturnType<typeof scheduleDay>>["rows"]) => rows.map((row) =>
      row.kind === "fixed" ? row.itemId : row.kind === "visit" ? row.tripPlaceId : row.kind === "luggage" ? `${row.action}-luggage` : row.kind);

    it("starts after landing and entry, leaves luggage at the night's lodging, then plans", async () => {
      const landing = fixed("landing", {
        itemType: "flight",
        startMinute: 8 * 60,
        endMinute: 11 * 60 + 30,
        startPointId: "tpe",
        endPointId: "kix",
        bufferMinutes: 120,
        bufferEstimated: true,
        afterBufferMinutes: 60,
      });
      const result = await scheduleDay(input({
        end: hotel,
        arrivalItemId: "landing",
        dropLuggage: { afterItemId: "landing" },
        stops: [stop("a"), stop("b")],
        blocks: [landing],
        travel: travelTable({ "hotel|kix": 70 }),
      }));

      // Nothing at 09:00 although the morning is free: the traveller is still in the air.
      expect(kinds(result.rows)).toEqual(["landing", "drop-luggage", "a", "b", "return"]);
      // Landing 11:30 + 60 minutes of entry + 70 minutes to the hotel, 15 minutes there.
      expect(result.rows[1]).toMatchObject({ name: "Hotel", arriveMinute: 820, leaveMinute: 835, travel: { fromName: "kix" } });
      expect(visits(result.rows)).toEqual([["a", 845, 905], ["b", 915, 975]]);
    });

    it("on a moving day starts at the old lodging and leaves luggage at the new one first", async () => {
      const result = await scheduleDay(input({
        start: { id: "old", name: "Old hotel" },
        end: { id: "new", name: "New hotel" },
        dropLuggage: { afterItemId: null },
        stops: [stop("a")],
        travel: travelTable({ "new|old": 40 }),
      }));

      expect(kinds(result.rows)).toEqual(["start", "drop-luggage", "a", "return"]);
      expect(result.rows[0]).toMatchObject({ name: "Old hotel", departMinute: 540 });
      expect(result.rows[1]).toMatchObject({ name: "New hotel", arriveMinute: 580, leaveMinute: 595 });
      expect(result.rows[2]).toMatchObject({ travel: { fromName: "new" }, startMinute: 605 });
      expect(result.rows[3]).toMatchObject({ name: "New hotel" });
    });

    it("on the last day collects luggage and reaches the airport by check-in, dropping what cannot fit", async () => {
      const departure = fixed("departure", {
        itemType: "flight",
        startMinute: 18 * 60,
        endMinute: 21 * 60,
        startPointId: "kix",
        endPointId: "tpe",
        bufferMinutes: 120,
        bufferEstimated: true,
        afterBufferMinutes: 60,
      });
      const result = await scheduleDay(input({
        start: hotel,
        collectLuggageBeforeItemId: "departure",
        stops: [stop("a"), stop("b"), stop("long", { durationMinutes: 240 })],
        blocks: [departure],
        travel: travelTable({ "hotel|kix": 75 }),
      }));

      // Leave the hotel by 14:30: 15 minutes for luggage and 75 to the airport, there 2 hours early.
      expect(kinds(result.rows)).toEqual(["start", "a", "b", "collect-luggage", "departure"]);
      expect(result.rows[3]).toMatchObject({ name: "Hotel", arriveMinute: 690, leaveMinute: 705, travel: { fromName: "b" } });
      expect(result.rows[4]).toMatchObject({ travel: { fromName: "hotel", durationMinutes: 75 }, bufferMinutes: 120, bufferEstimated: true });
      expect(result.unscheduled).toEqual([{ tripPlaceId: "long", name: "long", reason: "not_enough_time" }]);
      // From 16:00 the traveller is at the airport: that time is busy, not free.
      expect(result.load.busyMinutes).toBe(70 + 70 + 25 + 180 + 75);
    });

    it("never plans a place after the last day's departure", async () => {
      const morningFlight = fixed("departure", {
        itemType: "flight",
        startMinute: 11 * 60,
        endMinute: 13 * 60 + 30,
        startPointId: "kix",
        endPointId: null,
        bufferMinutes: 120,
        bufferEstimated: true,
      });
      const result = await scheduleDay(input({
        start: hotel,
        collectLuggageBeforeItemId: "departure",
        stops: [stop("museum", { durationMinutes: 120 })],
        blocks: [morningFlight],
        travel: travelTable({ "hotel|kix": 50 }),
      }));

      // Leaving the hotel by 07:55 leaves no time; after the flight the traveller is gone.
      expect(result.rows.some((row) => row.kind === "visit")).toBe(false);
      expect(result.unscheduled).toEqual([{ tripPlaceId: "museum", name: "museum", reason: "not_enough_time" }]);
    });

    it("leaves luggage at the new lodging only when the next fixed item can still be reached", async () => {
      const tea = fixed("tea", { startMinute: 10 * 60, endMinute: 11 * 60 + 30, startPointId: "kyoto-tea", endPointId: "kyoto-tea" });
      const result = await scheduleDay(input({
        start: { id: "old", name: "Old hotel" },
        end: { id: "new", name: "New hotel" },
        dropLuggage: { afterItemId: null },
        blocks: [tea],
        travel: travelTable({ "new|old": 50, "kyoto-tea|new": 50 }),
      }));

      // Old to new and back to the tea ceremony would end 10:55, after 10:00: drop it afterwards.
      expect(kinds(result.rows)).toEqual(["tea", "drop-luggage"]);
      expect(result.rows[1]).toMatchObject({ arriveMinute: 740, leaveMinute: 755, travel: { fromName: "kyoto-tea" } });
    });

    it("needs no travel when the last day's transfer leaves from the lodging itself", async () => {
      const limousine = fixed("limousine", { itemType: "transport", startMinute: 13 * 60, endMinute: 14 * 60, startPointId: "hotel", endPointId: "kix" });
      const result = await scheduleDay(input({
        start: hotel,
        collectLuggageBeforeItemId: "limousine",
        stops: [stop("a")],
        blocks: [limousine],
        travel: travelTable({ "hotel|hotel": null }),
      }));

      expect(kinds(result.rows)).toEqual(["start", "a", "collect-luggage", "limousine"]);
      expect(result.rows[3]).toMatchObject({ travel: { durationMinutes: 0 } });
      expect(result.unscheduled).toEqual([]);
    });

    it("keeps places out when the way to the new lodging is unknown instead of guessing", async () => {
      const result = await scheduleDay(input({
        start: { id: "old", name: "Old hotel" },
        end: { id: "new", name: "New hotel" },
        dropLuggage: { afterItemId: null },
        stops: [stop("a")],
        travel: travelTable({ "new|old": null }),
      }));

      expect(result.rows[1]).toMatchObject({ kind: "luggage", arriveMinute: null, leaveMinute: null });
      expect(result.unscheduled).toEqual([{ tripPlaceId: "a", name: "a", reason: "travel_unknown" }]);
    });
  });
});
