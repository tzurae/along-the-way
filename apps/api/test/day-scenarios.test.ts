import { addOutcome, orderWithout, type DayLegDto, type TravelMode } from "@along-the-way/contracts/day-plans";
import type { RouteMode, RouteObservation } from "@along-the-way/contracts/planning-observations";
import { describe, expect, it } from "vitest";

import { scheduleDay, type TimetableResult, type TimetableStop } from "../src/planning/day-timetable";
import type { DayHours } from "../src/planning/opening-hours";
import { legFor, taxiAlternative, visitIds, walkLimitFor } from "../src/planning/travel-modes";

/**
 * Hand-written add/remove scenarios. Expected answers were derived from the written spec by two
 * independent reviewers who did not read the code; see docs/day-scheduling-scenarios.md (S16 was added afterwards).
 */

type Pair = [walk: number, transit: number | null, drive: number];

interface Scenario {
  window: [string, string];
  dayMode: TravelMode;
  walkLimit?: number;
  list: string[];
  stays?: Record<string, number>;
  hours?: Record<string, Array<[string, string]>>;
  overrides?: Record<string, TravelMode>;
  pairs: Record<string, Pair>;
  operations: Array<{ remove: string } | { add: string; at: number }>;
}

const minute = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));
const clock = (value: number) => `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;

function observation(mode: RouteMode, minutes: number | null): RouteObservation {
  const source = {
    originPlaceId: "from", destinationPlaceId: "to", requestedDepartureTime: "2026-11-02T00:00:00Z", mode,
    provider: "table", attribution: "Scenario table", observedAt: "2026-11-01T00:00:00Z", expiresAt: "2026-11-01T00:15:00Z",
  };
  return minutes === null
    ? { ...source, status: "unavailable", reason: "no_route", durationMinutes: null, distanceMeters: null, walkingLegMinutes: null }
    : { ...source, status: "available", durationMinutes: minutes, distanceMeters: 1000, walkingLegMinutes: [], manualChecks: [], warnings: [] };
}

/** Plays the operations the way the day dialog does, and reports each outcome and the final day. */
async function play(scenario: Scenario) {
  const walkLimit = scenario.walkLimit ?? 15;
  const stop = (id: string): TimetableStop => ({
    id, name: id, type: "other", durationMinutes: scenario.stays?.[id] ?? 60,
    hours: scenario.hours?.[id]
      ? { status: "open", intervals: scenario.hours[id]!.map(([open, close]) => [minute(open), minute(close)] as [number, number]) } satisfies DayHours
      : { status: "unknown", cause: "manual" },
  });
  const draft = (ids: string[], legModes: Record<string, TravelMode>): Promise<TimetableResult> => scheduleDay({
    window: { startMinute: minute(scenario.window[0]), endMinute: minute(scenario.window[1]) },
    start: null, end: null, arrivalItemId: null, dropLuggage: null, collectLuggageBeforeItemId: null, blocks: [],
    stops: ids.map(stop),
    travel: async (from, to): Promise<DayLegDto> => {
      const pair = scenario.pairs[`${from}-${to}`] ?? scenario.pairs[`${to}-${from}`];
      if (!pair) throw new Error(`Pair ${from}-${to} is not in the scenario`);
      const mode = legModes[to] ?? scenario.dayMode;
      const observations = mode === "taxi" ? [observation("drive", pair[2])] : [observation("walking", pair[0]), observation("transit", pair[1])];
      return legFor(observations, { fromName: from, toName: to }, mode, walkLimitFor(mode, walkLimit));
    },
  });

  let list = scenario.list;
  let legModes = { ...scenario.overrides };
  let day = await draft(list, legModes);
  const outcomes: string[] = [];
  for (const operation of scenario.operations) {
    if ("remove" in operation) {
      list = orderWithout(list, operation.remove, [...visitIds(day)]);
      day = await draft(list, legModes);
      outcomes.push("n/a");
      continue;
    }
    const placedBefore = [...visitIds(day)];
    const base = list.filter((id) => id !== operation.add);
    const orderedIds = [...base.slice(0, operation.at), operation.add, ...base.slice(operation.at)];
    const withPlace = await draft(orderedIds, legModes);
    const alternative = await taxiAlternative({ orderedIds, placeId: operation.add, legModes, draft, withPlace });
    const outcome = addOutcome(placedBefore, [...visitIds(withPlace)], operation.add, alternative);
    if (outcome.kind === "fits") {
      outcomes.push("FITS");
      [list, day] = [orderedIds, withPlace];
    } else if (outcome.kind === "taxi") {
      // Accepting the prompt: those legs go by taxi.
      const changed = Object.keys(outcome.taxi.legModes).filter((id) => outcome.taxi.legModes[id] !== legModes[id]);
      outcomes.push(`TAXI PROMPT ${changed.length === 2 ? "c" : changed[0] === operation.add ? "a" : "b"}`);
      [list, day, legModes] = [orderedIds, outcome.taxi.result, outcome.taxi.legModes];
    } else {
      // Declining a swap, or nothing fits: the day does not change.
      outcomes.push(outcome.kind === "swap" ? `SWAP PROMPT [${outcome.pushed.join(", ")}]` : "NO FIT");
    }
  }
  const schedule = day.rows.flatMap((row) => (row.kind === "visit" ? [`${row.tripPlaceId} ${clock(row.startMinute)}–${clock(row.endMinute)}`] : []));
  return { outcomes, schedule, unscheduled: day.unscheduled.map((entry) => entry.tripPlaceId) };
}

const S1: Scenario = {
  window: ["09:00", "18:00"], dayMode: "transit", list: ["A", "B", "C"],
  pairs: { "A-B": [10, 20, 6], "B-C": [30, 12, 8] }, operations: [],
};

interface Expected { outcomes: string[]; schedule: string[]; unscheduled: string[] }

describe("day scheduling scenarios", () => {
  it.each<[string, Scenario, Expected]>([
    ["S1 transit day: walk within 15 minutes, else transit", S1,
      { outcomes: [], schedule: ["A 09:00–10:00", "B 10:10–11:10", "C 11:22–12:22"], unscheduled: [] }],
    ["S2 walk day with a 30-minute limit", { ...S1, dayMode: "walk", walkLimit: 30 },
      { outcomes: [], schedule: ["A 09:00–10:00", "B 10:10–11:10", "C 11:40–12:40"], unscheduled: [] }],
    ["S3 missing transit beyond walking distance is unknown, not a long walk", {
      window: ["09:00", "18:00"], dayMode: "transit", list: ["A", "B", "C", "D"],
      pairs: { "A-B": [10, 20, 6], "B-C": [30, null, 8], "B-D": [5, null, 4], "C-D": [20, 10, 6] }, operations: [],
    }, { outcomes: [], schedule: ["A 09:00–10:00", "B 10:10–11:10", "D 11:15–12:15"], unscheduled: ["C"] }],
    ["S4 a per-leg taxi override", { ...S1, overrides: { C: "taxi" } },
      { outcomes: [], schedule: ["A 09:00–10:00", "B 10:10–11:10", "C 11:23–12:23"], unscheduled: [] }],
    ["S5 waiting for opening", {
      window: ["09:00", "18:00"], dayMode: "transit", list: ["A", "B", "C"], hours: { B: [["11:00", "17:00"]] },
      pairs: { "A-B": [10, 20, 6], "B-C": [5, null, 3] }, operations: [],
    }, { outcomes: [], schedule: ["A 09:00–10:00", "B 11:00–12:00", "C 12:05–13:05"], unscheduled: [] }],
    ["S6 closes too early; the next place is tried from the last placed one", {
      window: ["09:00", "18:00"], dayMode: "transit", list: ["A", "B", "C"], hours: { B: [["09:00", "10:30"]] },
      pairs: { "A-B": [10, 20, 6], "A-C": [12, 25, 7], "B-C": [5, null, 3] }, operations: [],
    }, { outcomes: [], schedule: ["A 09:00–10:00", "C 10:12–11:12"], unscheduled: ["B"] }],
    ["S7 an add that fits", {
      window: ["09:00", "13:00"], dayMode: "transit", list: ["A", "B"],
      pairs: { "A-B": [10, 20, 6], "B-C": [40, 15, 10] }, operations: [{ add: "C", at: 2 }],
    }, { outcomes: ["FITS"], schedule: ["A 09:00–10:00", "B 10:10–11:10", "C 11:25–12:25"], unscheduled: [] }],
    ["S8 an add that needs taxi on the leg into it only", {
      window: ["09:00", "12:22"], dayMode: "transit", list: ["A", "B"],
      pairs: { "A-B": [50, 40, 15], "A-Q": [50, 40, 15], "Q-B": [2, null, 4] }, operations: [{ add: "Q", at: 1 }],
    }, { outcomes: ["TAXI PROMPT a"], schedule: ["A 09:00–10:00", "Q 10:20–11:20", "B 11:22–12:22"], unscheduled: [] }],
    ["S9 an add that needs taxi on both legs", {
      window: ["09:00", "12:40"], dayMode: "transit", list: ["A", "B"],
      pairs: { "A-B": [40, 20, 10], "A-Q": [60, 30, 10], "Q-B": [60, 30, 10] }, operations: [{ add: "Q", at: 1 }],
    }, { outcomes: ["TAXI PROMPT c"], schedule: ["A 09:00–10:00", "Q 10:15–11:15", "B 11:30–12:30"], unscheduled: [] }],
    ["S10 an add that taxi cannot save pushes a place out: a swap, declined", {
      window: ["09:00", "12:00"], dayMode: "transit", list: ["A", "B"],
      pairs: { "A-B": [10, 20, 6], "A-Q": [60, 30, 20], "Q-B": [60, 30, 20] }, operations: [{ add: "Q", at: 1 }],
    }, { outcomes: ["SWAP PROMPT [B]"], schedule: ["A 09:00–10:00", "B 10:10–11:10"], unscheduled: [] }],
    ["S11 taxi slower than a short walk: a swap, declined", {
      window: ["09:00", "12:00"], dayMode: "transit", list: ["A", "B"],
      pairs: { "A-B": [5, null, 3], "A-Q": [5, null, 3], "Q-B": [5, null, 3] }, operations: [{ add: "Q", at: 1 }],
    }, { outcomes: ["SWAP PROMPT [B]"], schedule: ["A 09:00–10:00", "B 10:05–11:05"], unscheduled: [] }],
    ["S12 removing a place never pushes a placed one out", {
      window: ["09:00", "12:00"], dayMode: "transit", list: ["W", "X", "Y"], stays: { W: 30, X: 160, Y: 60 },
      pairs: { "W-X": [0, null, 0], "W-Y": [0, null, 0], "X-Y": [0, null, 0] }, operations: [{ remove: "W" }],
    }, { outcomes: ["n/a"], schedule: ["Y 09:00–10:00"], unscheduled: ["X"] }],
    ["S13 remove, then add back at the end", {
      window: ["09:00", "15:00"], dayMode: "transit", list: ["A", "B", "C"],
      pairs: { "A-B": [10, 20, 6], "B-C": [10, 20, 6], "A-C": [30, 14, 8] }, operations: [{ remove: "B" }, { add: "B", at: 2 }],
    }, { outcomes: ["n/a", "FITS"], schedule: ["A 09:00–10:00", "C 10:14–11:14", "B 11:24–12:24"], unscheduled: [] }],
    ["S14 taxi day: drive plus 5 minutes", { ...S1, dayMode: "taxi" },
      { outcomes: [], schedule: ["A 09:00–10:00", "B 10:11–11:11", "C 11:24–12:24"], unscheduled: [] }],
    ["S15 a per-leg walk override uses the day's walk limit", {
      window: ["09:00", "18:00"], dayMode: "transit", walkLimit: 30, list: ["A", "B"], overrides: { B: "walk" },
      pairs: { "A-B": [25, 12, 7] }, operations: [],
    }, { outcomes: [], schedule: ["A 09:00–10:00", "B 10:25–11:25"], unscheduled: [] }],
    // Added after the blind derivation, for the one outcome no scenario reached: nothing changes.
    ["S16 an add that cannot be placed at all", {
      window: ["09:00", "18:00"], dayMode: "transit", list: ["A", "B"], hours: { Q: [["08:00", "09:30"]] },
      pairs: { "A-B": [10, 20, 6], "B-Q": [10, 20, 6] }, operations: [{ add: "Q", at: 2 }],
    }, { outcomes: ["NO FIT"], schedule: ["A 09:00–10:00", "B 10:10–11:10"], unscheduled: [] }],
  ])("%s", async (_name, scenario, expected) => {
    expect(await play(scenario)).toEqual(expected);
  });
});
