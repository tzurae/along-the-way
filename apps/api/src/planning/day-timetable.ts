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

/** Time at a lodging to leave or collect luggage. */
export const LUGGAGE_MINUTES = 15;

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
  /** Minutes to be there before it starts. */
  bufferMinutes: number;
  /** The buffer is a default, not one a member confirmed. */
  bufferEstimated: boolean;
  /** Minutes after it ends before anything else can happen, such as entry and luggage after landing. */
  afterBufferMinutes: number;
}

export interface TimetablePoint {
  id: string;
  name: string;
}

/** Travel between two points; a null duration means it is unknown. */
export type TravelLookup = (fromId: string, toId: string) => Promise<DayLegDto>;

export interface TimetableInput {
  window: DayWindowDto;
  /** The morning's lodging, where the day starts; null starts at the first place. */
  start: TimetablePoint | null;
  /** That night's lodging, where the day ends; null adds no return. */
  end: TimetablePoint | null;
  /** The fixed item that brings the traveller in; nothing is placed before it ends. */
  arrivalItemId: string | null;
  /** Moving to `end`: luggage is left there right after this fixed item, or first thing when null. */
  dropLuggage: { afterItemId: string | null } | null;
  /** The last day: luggage is collected at `start` on the way to this fixed item. */
  collectLuggageBeforeItemId: string | null;
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
 * Where the traveller is: nowhere yet, at a known point, at a fixed item whose place has no
 * map location (named for the travel line), or somewhere reached by a route nobody knows.
 */
type Origin =
  | { kind: "anywhere" }
  | { kind: "point"; id: string }
  | { kind: "unlocated"; name: string }
  | { kind: "unknown" };

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

/** No travel: the next thing starts where the traveller already is. */
function sameSpotLeg(name: string): DayLegDto {
  return {
    fromName: name,
    toName: name,
    mode: "walking",
    durationMinutes: 0,
    walkingMinutes: 0,
    transitMinutes: null,
    estimated: false,
    attribution: null,
    unavailableReason: null,
  };
}

interface Gap {
  /** Index of the block that ends this gap; equal to the block count for the last gap. */
  index: number;
  startMinute: number;
  origin: Origin;
  /** Latest minute to arrive at the target: the next item minus its buffer, or the day's end. */
  deadline: number;
  /** Where the gap must end: the next item's place, a lodging, or nowhere in particular. */
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

function pointOf(id: string): Origin {
  return { kind: "point", id };
}

/**
 * Places each stop, in order, into the first gap between fixed items where it fits.
 * A stop that fits nowhere is skipped and later stops are still tried; a gap is never
 * revisited once a later one is used. The result depends only on the input.
 */
export async function scheduleDay(input: TimetableInput): Promise<TimetableResult> {
  const { window, start, end, travel } = input;
  const blocks = [...input.blocks].sort((left, right) =>
    left.startMinute - right.startMinute
    || left.endMinute - right.endMinute
    || left.itemId.localeCompare(right.itemId));
  const indexOf = (itemId: string | null) => (itemId === null ? -1 : blocks.findIndex((block) => block.itemId === itemId));
  const arrivalIndex = indexOf(input.arrivalItemId);
  const collectIndex = start ? indexOf(input.collectLuggageBeforeItemId) : -1;
  const startOrigin: Origin = start ? pointOf(start.id) : { kind: "anywhere" };
  const endTarget: Origin = end ? pointOf(end.id) : { kind: "anywhere" };

  /** Where and when the traveller is free after `index` blocks, before any luggage stop. */
  function freeAfter(index: number) {
    let freeAt = window.startMinute;
    let latestEnd = Number.NEGATIVE_INFINITY;
    let origin = startOrigin;
    // After nested or overlapping items, the traveller is wherever the last one to end left them.
    for (const block of blocks.slice(0, index)) {
      freeAt = Math.max(freeAt, block.endMinute + block.afterBufferMinutes);
      if (block.endMinute < latestEnd) continue;
      latestEnd = block.endMinute;
      origin = block.endPointId ? pointOf(block.endPointId) : { kind: "unlocated", name: block.title };
    }
    return { startMinute: freeAt, origin };
  }

  // Luggage goes to the new lodging in the first gap, from the earliest allowed, where the
  // traveller can get there and still reach the next fixed item in time.
  let dropGap = -1;
  let dropLeg: DayLegDto | null = null;
  if (input.dropLuggage && end) {
    const earliest = input.dropLuggage.afterItemId === null ? 0 : indexOf(input.dropLuggage.afterItemId) + 1;
    for (let index = earliest; index <= blocks.length; index += 1) {
      const free = freeAfter(index);
      const leg = free.origin.kind === "point"
        ? (free.origin.id === end.id ? null : await travel(free.origin.id, end.id))
        : free.origin.kind === "unlocated" ? unlocatedLeg(free.origin.name, end.name) : null;
      dropGap = index;
      dropLeg = leg;
      const next = blocks[index];
      if (!next || !leg || leg.durationMinutes === null) break;
      const onward = !next.startPointId
        ? UNLOCATED_TRAVEL_MINUTES
        : next.startPointId === end.id ? 0 : (await travel(end.id, next.startPointId)).durationMinutes;
      const doneBy = free.startMinute + leg.durationMinutes + LUGGAGE_MINUTES + (onward ?? 0);
      if (onward !== null && doneBy <= next.startMinute - next.bufferMinutes) break;
    }
  }
  // Collecting luggage on the last day adds the lodging-to-departure leg before the departure.
  let collectLeg: DayLegDto | null = null;
  if (collectIndex >= 0 && start) {
    const departure = blocks[collectIndex]!;
    collectLeg = departure.startPointId === start.id
      ? sameSpotLeg(start.name)
      : departure.startPointId
        ? await travel(start.id, departure.startPointId)
        : unlocatedLeg(start.name, departure.title);
  }
  // Once the traveller leaves on the last day, no gap after the departure takes places.
  const lastGap = collectIndex >= 0 ? collectIndex : blocks.length;

  /** The gap after `index` blocks, before any stop is placed in it. */
  function emptyGap(index: number): Gap {
    let { startMinute, origin } = freeAfter(index);
    if (index === dropGap && dropLeg && end) {
      if (dropLeg.durationMinutes === null) {
        origin = { kind: "unknown" };
      } else {
        startMinute += dropLeg.durationMinutes + LUGGAGE_MINUTES;
        origin = pointOf(end.id);
      }
    }
    const next = blocks[index];
    if (!next) return { index, startMinute, origin, deadline: window.endMinute, target: endTarget };
    if (index === collectIndex && start && collectLeg) {
      const collectMinutes = LUGGAGE_MINUTES + (collectLeg.durationMinutes ?? 0);
      return {
        index,
        startMinute,
        origin,
        deadline: Math.min(window.endMinute, next.startMinute - next.bufferMinutes - collectMinutes),
        target: collectLeg.durationMinutes === null ? { kind: "unknown" } : pointOf(start.id),
      };
    }
    return {
      index,
      startMinute,
      origin,
      deadline: Math.min(window.endMinute, next.startMinute - next.bufferMinutes),
      target: next.startPointId ? pointOf(next.startPointId) : { kind: "unlocated", name: next.title },
    };
  }

  async function attempt(stop: TimetableStop, gap: Gap): Promise<Attempt> {
    const stay = stayFor(stop);
    const final = gap.index === blocks.length;
    // Cheap bounds first, so a gap that cannot hold the stay costs no route query.
    if (gap.startMinute + stay > Math.min(window.endMinute, gap.deadline)) return { reason: "not_enough_time" };
    if (openingStart(stop.hours, gap.startMinute, stay) === null) return { reason: "closes_too_early" };

    let inbound: DayLegDto | null = null;
    if (gap.origin.kind === "unknown") return { reason: "travel_unknown" };
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
    if (gap.target.kind === "unknown") return { reason: "travel_unknown" };
    if (gap.target.kind === "unlocated") onward = unlocatedLeg(stop.name, gap.target.name);
    if (gap.target.kind === "point") {
      onward = await travel(stop.id, gap.target.id);
      if (onward.durationMinutes === null) return { reason: "travel_unknown" };
    }
    if (onward && endMinute + onward.durationMinutes! > gap.deadline) {
      return { reason: final && end ? "cannot_return_to_lodging" : "not_enough_time" };
    }
    return { placed: { inbound, arriveMinute, startMinute, endMinute, stayMinutes: stay, onward } };
  }

  const rows: DayTimetableRowDto[] = [];
  const unscheduled: UnscheduledPlaceDto[] = [];
  let busy = 0;
  /** End of the fixed time already counted, so overlapping items count once. */
  let countedUntil = Number.NEGATIVE_INFINITY;
  let startShown = false;

  function showStart(departMinute: number) {
    if (!start || startShown) return;
    rows.push({ kind: "start", name: start.name, departMinute });
    startShown = true;
  }

  function emitDrop() {
    if (!dropLeg || !end) return;
    const free = freeAfter(dropGap);
    if (free.origin.kind === "point" && free.origin.id === start?.id) showStart(free.startMinute);
    const arriveMinute = dropLeg.durationMinutes === null ? null : free.startMinute + dropLeg.durationMinutes;
    rows.push({
      kind: "luggage",
      action: "drop",
      name: end.name,
      travel: dropLeg,
      arriveMinute,
      leaveMinute: arriveMinute === null ? null : arriveMinute + LUGGAGE_MINUTES,
    });
    busy += (dropLeg.durationMinutes ?? 0) + LUGGAGE_MINUTES;
  }

  /**
   * Shows a fixed item. `travelIn` is the leg from the gap's last stop to the gap's target, and
   * `gap` the gap the traveller was in before it.
   */
  async function emitBlock(index: number, travelIn: DayLegDto | null, gap: Gap) {
    const block = blocks[index]!;
    let blockTravel = travelIn;
    if (index === collectIndex && start && collectLeg) {
      // On the way to the departure the traveller collects luggage at the morning's lodging.
      let toLodging = travelIn;
      if (!toLodging && gap.origin.kind === "point" && gap.origin.id !== start.id) {
        toLodging = await travel(gap.origin.id, start.id);
      }
      if (!toLodging && gap.origin.kind === "unlocated") toLodging = unlocatedLeg(gap.origin.name, start.name);
      if (toLodging) {
        const arriveMinute = toLodging.durationMinutes === null ? null : gap.startMinute + toLodging.durationMinutes;
        rows.push({
          kind: "luggage",
          action: "collect",
          name: start.name,
          travel: toLodging,
          arriveMinute,
          leaveMinute: arriveMinute === null ? null : arriveMinute + LUGGAGE_MINUTES,
        });
        busy += (toLodging.durationMinutes ?? 0) + LUGGAGE_MINUTES;
      }
      blockTravel = collectLeg;
    }
    rows.push({
      kind: "fixed",
      itemId: block.itemId,
      title: block.title,
      itemType: block.itemType,
      travel: blockTravel,
      startMinute: block.startMinute,
      endMinute: block.endMinute,
      startsBeforeDay: block.startsBeforeDay,
      endsAfterDay: block.endsAfterDay,
      bufferMinutes: block.bufferMinutes,
      bufferEstimated: block.bufferEstimated,
      afterBufferMinutes: block.afterBufferMinutes,
    });
    // Time at the airport before and after a flight is spent, not free.
    busy += overlap(Math.max(block.startMinute - block.bufferMinutes, countedUntil), block.endMinute + block.afterBufferMinutes, window)
      + (blockTravel?.durationMinutes ?? 0);
    countedUntil = Math.max(countedUntil, block.endMinute + block.afterBufferMinutes);
    if (index === dropGap - 1) emitDrop();
  }

  // Before the arrival the traveller is elsewhere: those items are shown, nothing is placed.
  for (let index = 0; index <= arrivalIndex; index += 1) await emitBlock(index, null, emptyGap(index));
  if (dropGap === 0) emitDrop();
  let current = emptyGap(arrivalIndex + 1);
  /** Travel from the last placed stop to the current gap's target. */
  let pendingOnward: DayLegDto | null = null;

  for (const stop of input.stops) {
    if (stop.hours.status === "closed") {
      unscheduled.push({ tripPlaceId: stop.id, name: stop.name, reason: stop.hours.reason });
      continue;
    }
    const reasons: UnscheduledReason[] = [];
    let placedIn: { gap: Gap; placement: Placement } | null = null;
    for (let index = current.index; index <= lastGap; index += 1) {
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
      await emitBlock(index, index === current.index ? pendingOnward : null, index === current.index ? current : emptyGap(index));
    }
    if (gap.origin.kind === "point" && gap.origin.id === start?.id) showStart(gap.startMinute);
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
    current = { ...gap, startMinute: placement.endMinute, origin: pointOf(stop.id) };
    pendingOnward = placement.onward;
  }

  for (let index = current.index; index < blocks.length; index += 1) {
    await emitBlock(index, index === current.index ? pendingOnward : null, index === current.index ? current : emptyGap(index));
  }
  // The day ends back at that night's lodging when the last thing in it is a placed stop.
  if (end && current.index === blocks.length && pendingOnward && pendingOnward.durationMinutes !== null) {
    rows.push({
      kind: "return",
      name: end.name,
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
