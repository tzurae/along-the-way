import type {
  DayLegDto,
  DayLoadDto,
  DayTimetableRowDto,
  DayWindowDto,
  UnscheduledPlaceDto,
  UnscheduledReason,
} from "@along-the-way/contracts/day-plans";
import type { ItineraryItemType, PlaceType } from "@along-the-way/contracts/trip-skeleton";

import type { DayHours } from "./opening-hours";

/** Stay used when nobody entered one, by place type. */
export const DEFAULT_STAY_MINUTES: Record<PlaceType, number> = {
  restaurant: 75,
  activity: 90,
  other: 60,
  lodging: 60,
  station: 30,
  airport: 30,
};

export interface TimetableStop {
  id: string;
  name: string;
  type: PlaceType;
  durationMinutes: number | null;
  hours: DayHours;
}

/** A timed itinerary item; its times never move. Minutes are clipped to the day. */
export interface TimetableBlock {
  itemId: string;
  title: string;
  itemType: ItineraryItemType;
  startMinute: number;
  endMinute: number;
  startsBeforeDay: boolean;
  endsAfterDay: boolean;
  /** Where the item starts and ends; null when the place has no map location. */
  startPointId: string | null;
  endPointId: string | null;
  bufferMinutes: number;
}

/** Travel between two points; a null duration means it is unknown. */
export type TravelLookup = (fromId: string, toId: string) => Promise<DayLegDto>;

export interface TimetableInput {
  window: DayWindowDto;
  /** Where the day starts and ends; null starts at the first place and adds no return. */
  lodging: { id: string; name: string } | null;
  /** Located places in the order to try. */
  stops: TimetableStop[];
  blocks: TimetableBlock[];
  travel: TravelLookup;
}

export interface TimetableResult {
  rows: DayTimetableRowDto[];
  unscheduled: UnscheduledPlaceDto[];
  load: DayLoadDto;
}

/** Travel assumed to and from a fixed item whose place has no map location, labelled an estimate. */
export const UNLOCATED_TRAVEL_MINUTES = 30;

/**
 * Where the traveller is: nowhere yet, at a known point, or at a fixed item whose place has no
 * map location, named for the travel line.
 */
type Origin = { kind: "anywhere" } | { kind: "point"; id: string } | { kind: "unlocated"; name: string };

function unlocatedLeg(fromName: string, toName: string): DayLegDto {
  return {
    fromName,
    toName,
    mode: null,
    durationMinutes: UNLOCATED_TRAVEL_MINUTES,
    walkingMinutes: null,
    transitMinutes: null,
    estimated: true,
    attribution: null,
    unavailableReason: "location_unknown",
  };
}

interface Gap {
  /** Index of the block that ends this gap; equal to the block count for the last gap. */
  index: number;
  startMinute: number;
  origin: Origin;
  /** Latest minute to arrive at the target: the next item minus its buffer, or the day's end. */
  deadline: number;
  /** Where the gap must end: the next item's place, the lodging, or nowhere in particular. */
  target: Origin;
}

interface Placement {
  inbound: DayLegDto | null;
  arriveMinute: number;
  startMinute: number;
  endMinute: number;
  stayMinutes: number;
  /** Travel to the gap's target, checked before accepting the place. */
  onward: DayLegDto | null;
}

type Attempt = { placed: Placement } | { reason: UnscheduledReason };

// When a place fits nowhere, report the most specific reason found across the gaps tried.
const REASON_RANK: UnscheduledReason[] = [
  "closes_too_early",
  "cannot_return_to_lodging",
  "travel_unknown",
  "not_enough_time",
];

function mostSpecific(reasons: UnscheduledReason[]) {
  return REASON_RANK.find((reason) => reasons.includes(reason)) ?? "not_enough_time";
}

function stayFor(stop: TimetableStop) {
  return stop.durationMinutes ?? DEFAULT_STAY_MINUTES[stop.type];
}

/** The first opening that can hold the whole stay, starting no earlier than `arrive`. */
function openingStart(hours: DayHours, arrive: number, stay: number) {
  if (hours.status !== "open") return arrive;
  const interval = hours.intervals.find(([open, close]) => Math.max(arrive, open) + stay <= close);
  return interval ? Math.max(arrive, interval[0]) : null;
}

function overlap(start: number, end: number, window: DayWindowDto) {
  return Math.max(0, Math.min(end, window.endMinute) - Math.max(start, window.startMinute));
}

function loadLevel(busy: number, available: number): DayLoadDto["level"] {
  if (busy * 10 < available * 7) return "relaxed";
  if (busy * 10 <= available * 9) return "balanced";
  return "packed";
}

/**
 * Places each stop, in order, into the first gap between fixed items where it fits.
 * A stop that fits nowhere is skipped and later stops are still tried; a gap is never
 * revisited once a later one is used. The result depends only on the input.
 */
export async function scheduleDay(input: TimetableInput): Promise<TimetableResult> {
  const { window, lodging, travel } = input;
  const blocks = [...input.blocks].sort((left, right) =>
    left.startMinute - right.startMinute
    || left.endMinute - right.endMinute
    || left.itemId.localeCompare(right.itemId));
  const lodgingOrigin: Origin = lodging ? { kind: "point", id: lodging.id } : { kind: "anywhere" };

  /** The gap after `index` blocks, before anything is placed in it. */
  function emptyGap(index: number): Gap {
    let latestEnd = Number.NEGATIVE_INFINITY;
    let origin = lodgingOrigin;
    // After nested or overlapping items, the traveller is wherever the last one to end left them.
    for (const block of blocks.slice(0, index)) {
      if (block.endMinute < latestEnd) continue;
      latestEnd = block.endMinute;
      origin = block.endPointId ? { kind: "point", id: block.endPointId } : { kind: "unlocated", name: block.title };
    }
    const startMinute = Math.max(window.startMinute, latestEnd);
    const next = blocks[index];
    return next
      ? {
          index,
          startMinute,
          origin,
          deadline: Math.min(window.endMinute, next.startMinute - next.bufferMinutes),
          target: next.startPointId ? { kind: "point", id: next.startPointId } : { kind: "unlocated", name: next.title },
        }
      : { index, startMinute, origin, deadline: window.endMinute, target: lodgingOrigin };
  }

  async function attempt(stop: TimetableStop, gap: Gap): Promise<Attempt> {
    const stay = stayFor(stop);
    const final = gap.index === blocks.length;
    // Cheap bounds first, so a gap that cannot hold the stay costs no route query.
    if (gap.startMinute + stay > Math.min(window.endMinute, gap.deadline)) return { reason: "not_enough_time" };
    if (openingStart(stop.hours, gap.startMinute, stay) === null) return { reason: "closes_too_early" };

    let inbound: DayLegDto | null = null;
    if (gap.origin.kind === "unlocated") inbound = unlocatedLeg(gap.origin.name, stop.name);
    if (gap.origin.kind === "point") {
      inbound = await travel(gap.origin.id, stop.id);
      if (inbound.durationMinutes === null) return { reason: "travel_unknown" };
    }
    const arriveMinute = gap.startMinute + (inbound?.durationMinutes ?? 0);
    const startMinute = openingStart(stop.hours, arriveMinute, stay);
    if (startMinute === null) return { reason: "closes_too_early" };
    const endMinute = startMinute + stay;
    if (endMinute > window.endMinute || endMinute > gap.deadline) return { reason: "not_enough_time" };

    let onward: DayLegDto | null = null;
    if (gap.target.kind === "unlocated") onward = unlocatedLeg(stop.name, gap.target.name);
    if (gap.target.kind === "point") {
      onward = await travel(stop.id, gap.target.id);
      if (onward.durationMinutes === null) return { reason: "travel_unknown" };
    }
    if (onward && endMinute + onward.durationMinutes! > gap.deadline) {
      return { reason: final && lodging ? "cannot_return_to_lodging" : "not_enough_time" };
    }
    return { placed: { inbound, arriveMinute, startMinute, endMinute, stayMinutes: stay, onward } };
  }

  const rows: DayTimetableRowDto[] = [];
  const unscheduled: UnscheduledPlaceDto[] = [];
  let busy = 0;
  /** End of the fixed time already counted, so overlapping items count once. */
  let countedUntil = Number.NEGATIVE_INFINITY;
  let current = emptyGap(0);
  /** Travel from the last placed stop to the current gap's target. */
  let pendingOnward: DayLegDto | null = null;

  function emitBlock(block: TimetableBlock, travelIn: DayLegDto | null) {
    rows.push({
      kind: "fixed",
      itemId: block.itemId,
      title: block.title,
      itemType: block.itemType,
      travel: travelIn,
      startMinute: block.startMinute,
      endMinute: block.endMinute,
      startsBeforeDay: block.startsBeforeDay,
      endsAfterDay: block.endsAfterDay,
      bufferMinutes: block.bufferMinutes,
    });
    busy += overlap(Math.max(block.startMinute, countedUntil), block.endMinute, window) + (travelIn?.durationMinutes ?? 0);
    countedUntil = Math.max(countedUntil, block.endMinute);
  }

  for (const stop of input.stops) {
    if (stop.hours.status === "closed") {
      unscheduled.push({ tripPlaceId: stop.id, name: stop.name, reason: stop.hours.reason });
      continue;
    }
    const reasons: UnscheduledReason[] = [];
    let placedIn: { gap: Gap; placement: Placement } | null = null;
    for (let index = current.index; index <= blocks.length; index += 1) {
      const gap = index === current.index ? current : emptyGap(index);
      const result = await attempt(stop, gap);
      if ("placed" in result) {
        placedIn = { gap, placement: result.placed };
        break;
      }
      reasons.push(result.reason);
    }
    if (!placedIn) {
      unscheduled.push({ tripPlaceId: stop.id, name: stop.name, reason: mostSpecific(reasons) });
      continue;
    }

    const { gap, placement } = placedIn;
    // Fixed items passed on the way to the chosen gap keep their own times.
    for (let index = current.index; index < gap.index; index += 1) {
      emitBlock(blocks[index]!, index === current.index ? pendingOnward : null);
    }
    if (lodging && gap.origin.kind === "point" && gap.origin.id === lodging.id) {
      rows.push({ kind: "start", name: lodging.name, departMinute: gap.startMinute });
    }
    rows.push({
      kind: "visit",
      tripPlaceId: stop.id,
      name: stop.name,
      travel: placement.inbound,
      arriveMinute: placement.arriveMinute,
      waitMinutes: placement.startMinute - placement.arriveMinute,
      startMinute: placement.startMinute,
      endMinute: placement.endMinute,
      stayMinutes: placement.stayMinutes,
      stayEstimated: stop.durationMinutes === null,
      hours: stop.hours.status === "open" ? "listed" : "unknown",
    });
    busy += placement.stayMinutes + (placement.inbound?.durationMinutes ?? 0);
    current = { ...gap, startMinute: placement.endMinute, origin: { kind: "point", id: stop.id } };
    pendingOnward = placement.onward;
  }

  for (let index = current.index; index < blocks.length; index += 1) {
    emitBlock(blocks[index]!, index === current.index ? pendingOnward : null);
  }
  // The day ends back at the lodging when the last thing in it is a placed stop.
  if (lodging && current.index === blocks.length && pendingOnward && pendingOnward.durationMinutes !== null) {
    rows.push({
      kind: "return",
      name: lodging.name,
      travel: pendingOnward,
      arriveMinute: current.startMinute + pendingOnward.durationMinutes,
    });
    busy += pendingOnward.durationMinutes;
  }

  const windowMinutes = window.endMinute - window.startMinute;
  return {
    rows,
    unscheduled,
    load: { busyMinutes: busy, windowMinutes, level: loadLevel(busy, windowMinutes) },
  };
}
