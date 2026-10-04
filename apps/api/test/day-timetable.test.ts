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
    lodging: null,
    stops: [],
    blocks: [],
    travel: travelTable(),
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
      lodging: { id: "hotel", name: "Hotel" },
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

  it("rates the day by the share of the window spent staying and travelling", async () => {
    const level = async (stay: number) => (await scheduleDay(input({
      window: { startMinute: 600, endMinute: 700 },
      stops: [stop("only", { durationMinutes: stay })],
    }))).load.level;

    expect([await level(69), await level(70), await level(90), await level(91)])
      .toEqual(["relaxed", "balanced", "balanced", "packed"]);
  });
});
