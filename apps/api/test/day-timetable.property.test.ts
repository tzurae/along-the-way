import { orderWithout, stayMinutesFor, type DayLegDto, type TravelMode } from "@along-the-way/contracts/day-plans";
import type { PlaceType } from "@along-the-way/contracts/trip-skeleton";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  scheduleDay,
  type TimetableBlock,
  type TimetableInput,
  type TimetableResult,
  type TimetableStop,
} from "../src/planning/day-timetable";
import { FakeRouteProvider } from "../src/planning/fake-route-providers";
import type { DayHours } from "../src/planning/opening-hours";
import { legFor, routeModesFor, taxiAlternative, visitIds, walkLimitFor } from "../src/planning/travel-modes";

/**
 * Invariants of a day's schedule over generated days: places within ~5 km of central Taipei,
 * routes from the offline FakeRouteProvider (no network), random opening hours, fixed items,
 * lodgings, the day's way of travel and per-leg overrides.
 */

const provider = new FakeRouteProvider({ now: () => new Date("2026-11-01T00:00:00Z") });
const DEPARTURE = "2026-11-02T09:00:00+08:00";

interface Point { id: string; latitude: number; longitude: number }

interface GeneratedDay {
  startMinute: number;
  endMinute: number;
  dayMode: TravelMode;
  walkLimit: number;
  lodging: Point | null;
  returnToLodging: boolean;
  stops: Array<TimetableStop & Point>;
  blocks: Array<TimetableBlock & { point: Point | null }>;
  legModes: Record<string, TravelMode>;
}

const offset = fc.double({ min: -0.045, max: 0.045, noNaN: true });
const pointArb = (id: string) => fc.record({ latitude: offset, longitude: offset })
  .map(({ latitude, longitude }): Point => ({ id, latitude: 25.04 + latitude, longitude: 121.52 + longitude }));
const modeArb = fc.constantFrom<TravelMode>("transit", "taxi", "walk");
const typeArb = fc.constantFrom<PlaceType>("activity", "museum", "restaurant", "cafe", "worship", "other");

const hoursArb: fc.Arbitrary<DayHours> = fc.oneof(
  { weight: 3, arbitrary: fc.constant<DayHours>({ status: "unknown", cause: "manual" }) },
  {
    weight: 4,
    arbitrary: fc.array(
      fc.record({ open: fc.integer({ min: 0, max: 22 * 60 }), length: fc.integer({ min: 60, max: 12 * 60 }) }),
      { minLength: 1, maxLength: 2 },
    ).map((periods): DayHours => {
      // Sorted, non-overlapping intervals, as hoursOn produces.
      const intervals: Array<[number, number]> = [];
      for (const { open, length } of [...periods].sort((a, b) => a.open - b.open)) {
        const start = Math.max(open, intervals.at(-1)?.[1] ?? 0);
        const end = Math.min(1440, start + length);
        if (end > start) intervals.push([start, end]);
      }
      return intervals.length > 0 ? { status: "open", intervals } : { status: "unknown", cause: "none" };
    }),
  },
  { weight: 1, arbitrary: fc.constant<DayHours>({ status: "closed", reason: "closed_that_day" }) },
);

const dayArb: fc.Arbitrary<GeneratedDay> = fc.integer({ min: 2, max: 7 }).chain((count) => fc.record({
  startMinute: fc.integer({ min: 7 * 60, max: 11 * 60 }),
  length: fc.integer({ min: 3 * 60, max: 13 * 60 }),
  dayMode: modeArb,
  walkLimit: fc.integer({ min: 5, max: 60 }),
  lodging: fc.option(pointArb("lodging"), { nil: null }),
  returnToLodging: fc.boolean(),
  stops: fc.tuple(...Array.from({ length: count }, (_, index) => fc.record({
    point: pointArb(`p${index}`),
    type: typeArb,
    durationMinutes: fc.option(fc.integer({ min: 15, max: 150 }), { nil: null }),
    hours: hoursArb,
  }))),
  blocks: fc.array(fc.record({
    at: fc.double({ min: 0, max: 1, noNaN: true }),
    duration: fc.integer({ min: 20, max: 150 }),
    buffer: fc.integer({ min: 0, max: 30 }),
    afterBuffer: fc.integer({ min: 0, max: 20 }),
    located: fc.boolean(),
    point: pointArb("block"),
  }), { maxLength: 2 }),
  overrides: fc.array(fc.option(modeArb, { nil: undefined }), { minLength: count, maxLength: count }),
})).map((raw): GeneratedDay => {
  const endMinute = Math.min(1440, raw.startMinute + raw.length);
  const stops = raw.stops.map((entry, index) => ({
    ...entry.point,
    id: `p${index}`,
    name: `p${index}`,
    type: entry.type,
    durationMinutes: entry.durationMinutes,
    hours: entry.hours,
  }));
  const blocks = raw.blocks.map((entry, index) => {
    const startMinute = Math.round(raw.startMinute + entry.at * (endMinute - raw.startMinute - entry.duration));
    const point = entry.located ? { ...entry.point, id: `b${index}` } : null;
    return {
      itemId: `item${index}`,
      title: `item${index}`,
      itemType: "activity" as const,
      startMinute,
      endMinute: startMinute + entry.duration,
      startsBeforeDay: false,
      endsAfterDay: false,
      startPointId: point?.id ?? null,
      endPointId: point?.id ?? null,
      bufferMinutes: entry.buffer,
      bufferEstimated: true,
      afterBufferMinutes: entry.afterBuffer,
      point,
    };
  });
  const legModes = Object.fromEntries(raw.overrides.flatMap((mode, index) => (mode ? [[`p${index}`, mode]] : [])));
  return { startMinute: raw.startMinute, endMinute, dayMode: raw.dayMode, walkLimit: raw.walkLimit, lodging: raw.lodging, returnToLodging: raw.returnToLodging, stops, blocks, legModes };
});

/** Legs exactly as the day plan module builds them: the mode of the place reached, else the day's. */
function travelFor(day: GeneratedDay, legModes: Record<string, TravelMode>) {
  const points = new Map<string, Point>();
  for (const point of [...day.stops, ...day.blocks.flatMap((block) => (block.point ? [block.point] : [])), ...(day.lodging ? [day.lodging] : [])]) {
    points.set(point.id, point);
  }
  const location = (id: string) => {
    const point = points.get(id)!;
    return { placeId: id, latitude: point.latitude, longitude: point.longitude };
  };
  return async (fromId: string, toId: string): Promise<DayLegDto> => {
    const mode = legModes[toId] ?? day.dayMode;
    const observations = await provider.observe({ origin: location(fromId), destination: location(toId), departureTime: DEPARTURE, modes: routeModesFor(mode) });
    return legFor(observations, { fromName: fromId, toName: toId }, mode, walkLimitFor(mode, day.walkLimit));
  };
}

function inputFor(day: GeneratedDay, orderedIds: string[], legModes = day.legModes): TimetableInput {
  const byId = new Map(day.stops.map((stop) => [stop.id, stop]));
  const lodging = day.lodging ? { id: day.lodging.id, name: "lodging" } : null;
  return {
    window: { startMinute: day.startMinute, endMinute: day.endMinute },
    start: lodging,
    end: day.returnToLodging ? lodging : null,
    arrivalItemId: null,
    dropLuggage: null,
    collectLuggageBeforeItemId: null,
    stops: orderedIds.map((id) => byId.get(id)!),
    blocks: day.blocks.map(({ point: _point, ...block }) => block),
    travel: travelFor(day, legModes),
  };
}

const draft = (day: GeneratedDay) => (orderedIds: string[], legModes: Record<string, TravelMode>) => scheduleDay(inputFor(day, orderedIds, legModes));

const visits = (result: TimetableResult) => result.rows.flatMap((row) => (row.kind === "visit" ? [row] : []));
const allIds = (day: GeneratedDay) => day.stops.map((stop) => stop.id);
const RUNS = { numRuns: 300 };

describe("a scheduled day", () => {
  it("never overlaps visits with each other or with fixed items and their buffers", async () => {
    await fc.assert(fc.asyncProperty(dayArb, async (day) => {
      const result = await scheduleDay(inputFor(day, allIds(day)));
      const placed = visits(result);
      for (const [index, visit] of placed.entries()) {
        const next = placed[index + 1];
        if (next) expect(visit.endMinute).toBeLessThanOrEqual(next.startMinute);
        for (const block of day.blocks) {
          const clear = visit.endMinute <= block.startMinute - block.bufferMinutes
            || visit.startMinute >= block.endMinute + block.afterBufferMinutes;
          expect(clear, `${visit.tripPlaceId} ${visit.startMinute}-${visit.endMinute} vs ${block.itemId} ${block.startMinute}-${block.endMinute}`).toBe(true);
        }
      }
    }), RUNS);
  });

  it("keeps every visit inside the day and inside one of its opening intervals, staying the full stay", async () => {
    await fc.assert(fc.asyncProperty(dayArb, async (day) => {
      const result = await scheduleDay(inputFor(day, allIds(day)));
      for (const visit of visits(result)) {
        const stop = day.stops.find((entry) => entry.id === visit.tripPlaceId)!;
        expect(visit.startMinute).toBeGreaterThanOrEqual(day.startMinute);
        expect(visit.endMinute).toBeLessThanOrEqual(day.endMinute);
        expect(visit.endMinute - visit.startMinute).toBe(stayMinutesFor(stop));
        expect(stop.hours.status).not.toBe("closed");
        if (stop.hours.status === "open") {
          expect(stop.hours.intervals.some(([open, close]) => open <= visit.startMinute && visit.endMinute <= close)).toBe(true);
        }
      }
    }), RUNS);
  });

  it("arrives no earlier than the previous thing ends plus the travel between them, and starts no earlier than it arrives", async () => {
    await fc.assert(fc.asyncProperty(dayArb, async (day) => {
      const result = await scheduleDay(inputFor(day, allIds(day)));
      // The last minute the traveller was busy before each row, from the rows themselves.
      let freeAt = day.startMinute;
      for (const row of result.rows) {
        if (row.kind === "fixed") {
          freeAt = Math.max(freeAt, row.endMinute + row.afterBufferMinutes);
        } else if (row.kind === "visit") {
          const travel = row.travel?.durationMinutes ?? 0;
          expect(row.travel === null || row.travel.durationMinutes !== null).toBe(true);
          expect(row.arriveMinute).toBeGreaterThanOrEqual(freeAt + travel);
          expect(row.startMinute).toBeGreaterThanOrEqual(row.arriveMinute);
          freeAt = row.endMinute;
        } else if (row.kind === "return") {
          expect(row.arriveMinute).toBeLessThanOrEqual(day.endMinute);
        }
      }
    }), RUNS);
  });

  it("leaves fixed items at their own times and accounts for every place exactly once", async () => {
    await fc.assert(fc.asyncProperty(dayArb, async (day) => {
      const result = await scheduleDay(inputFor(day, allIds(day)));
      const fixed = result.rows.flatMap((row) => (row.kind === "fixed" ? [row] : []));
      expect(fixed.map((row) => [row.itemId, row.startMinute, row.endMinute]).sort())
        .toEqual(day.blocks.map((block) => [block.itemId, block.startMinute, block.endMinute]).sort());
      const seen = [...visits(result).map((row) => row.tripPlaceId), ...result.unscheduled.map((entry) => entry.tripPlaceId)];
      expect(seen.sort()).toEqual(allIds(day).sort());
    }), RUNS);
  });

  it("never pushes a placed stop out when another placed stop is taken out", async () => {
    await fc.assert(fc.asyncProperty(dayArb, async (day) => {
      const ids = allIds(day);
      const placed = [...visitIds(await scheduleDay(inputFor(day, ids)))];
      for (const removed of placed) {
        const still = visitIds(await scheduleDay(inputFor(day, orderWithout(ids, removed, placed))));
        for (const id of placed) if (id !== removed) expect(still.has(id), `${id} was pushed out by removing ${removed}`).toBe(true);
      }
    }), RUNS);
  });

  // The guarantee is about the leg's own way and taxi. It is NOT that no way at all fits: on a taxi
  // day a short walk beats a cab, and a member's override can be slower than the day's way (see
  // docs/day-scheduling-scenarios.md, "Open questions").
  it("offers taxi only when it fits without pushing a placed stop out, and when it does not, no choice between each leg's way and taxi does", async () => {
    await fc.assert(fc.asyncProperty(dayArb, fc.nat(), fc.nat(), async (day, pick, slot) => {
      const ids = allIds(day);
      const placeId = ids[pick % ids.length]!;
      const base = ids.filter((id) => id !== placeId);
      const orderedIds = [...base.slice(0, slot % (base.length + 1)), placeId, ...base.slice(slot % (base.length + 1))];
      // A place dropped in from the pool has no way of arrival of its own yet.
      const { [placeId]: _none, ...legModes } = day.legModes;
      const run = draft(day);
      const placedBefore = visitIds(await run(base, legModes));
      const fits = (result: TimetableResult) => {
        const placed = visitIds(result);
        return placed.has(placeId) && [...placedBefore].every((id) => placed.has(id));
      };
      const defaultFits = fits(await run(orderedIds, legModes));
      const alternative = await taxiAlternative({ orderedIds, placeId, legModes, draft: run });
      if (defaultFits) {
        expect(alternative).toBeNull();
        return;
      }
      if (alternative) {
        expect(fits(alternative.result)).toBe(true);
        // Only the legs into and out of the new place change, and only to taxi.
        for (const [id, mode] of Object.entries(alternative.legModes)) {
          if (legModes[id] !== mode) expect(mode).toBe("taxi");
        }
        return;
      }
      // No taxi choice fits: no mix of each leg's own way and taxi for the legs into and out of it does.
      const next = orderedIds.slice(orderedIds.indexOf(placeId) + 1).find((id) => placedBefore.has(id));
      for (const into of [undefined, "taxi" as const]) {
        for (const out of next ? [legModes[next], "taxi" as const] : [undefined]) {
          const modes = { ...legModes };
          if (into) modes[placeId] = into;
          if (next) { if (out) modes[next] = out; else delete modes[next]; }
          expect(fits(await run(orderedIds, modes)), `into=${into} out=${out}`).toBe(false);
        }
      }
    }), { numRuns: 200 });
  });
});
