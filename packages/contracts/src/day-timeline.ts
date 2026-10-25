import type { ItineraryItemType, PlaceType } from "./trip-skeleton";
import { isRecord } from "./type-guards";

/**
 * One day's timeline (f5 §1): where the day starts and ends, its fixed items, and when each meal
 * falls. Server (whole-trip drafts) and client (day dialog) run the same `simulateDay`, so both
 * show the same rows. Every minute is a local minute after the day's midnight.
 */

const EARTH_RADIUS_METERS = 6_371_000;

export interface LatLng {
  latitude: number;
  longitude: number;
}

/** Generic so callers may pass labelled points (e.g. with an `id`) as object literals. */
export function straightLineMeters<A extends LatLng, B extends LatLng>(a: A, b: B) {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const dLat = radians(b.latitude - a.latitude);
  const dLon = radians(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface StraightLineMoveSettings {
  detourFactor: number;
  speedKmh: number;
  perLegMinutes: number;
}

/** Straight-line move estimate for one leg; the day route shows exactly what the day load counts. */
export function estimatedMoveMinutes(metres: number, settings: StraightLineMoveSettings) {
  return Math.ceil(metres * settings.detourFactor / (settings.speedKmh * 1000 / 60)) + settings.perLegMinutes;
}

/** f5 §1.2 meal bands (Q2 constants), local minutes. */
export const BREAKFAST_LATEST_MINUTE = 10 * 60 + 30;
export const LUNCH_SEAT_MINUTE = 11 * 60 + 30;
export const LUNCH_LATEST_MINUTE = 13 * 60;
export const LUNCH_BAND_END_MINUTE = 15 * 60;
export const LUNCH_MINUTES = 60;
export const DINNER_BAND_START_MINUTE = 16 * 60 + 30;
export const DINNER_SEAT_MINUTE = 17 * 60 + 30;
export const DINNER_LATEST_MINUTE = 19 * 60;
export const DINNER_MINUTES = 75;
/** A leg estimated in a straight line above this is too unreliable to time a day by (f5 §1.4). */
export const LONG_LEG_MINUTES = 120;
/** Free time at least this long is its own row; shorter waits fold into the next row (f5 §1.3). */
export const FREE_TIME_ROW_MINUTES = 30;
const LUNCH_GAP_CLOCK_MINUTE = 11 * 60;

export interface DayTimelinePoint {
  id: string;
  latitude: number | null;
  longitude: number | null;
}

export interface DayTimelineAnchor {
  /** Itinerary item id. */
  id: string;
  itemType: ItineraryItemType;
  startMinute: number;
  endMinute: number;
  start: DayTimelinePoint;
  end: DayTimelinePoint;
}

export interface DayTimelineFrame {
  /** The planning window (day settings, landing +60, take-off −120). */
  windowStartMinute: number;
  windowEndMinute: number;
  /** A fixed item started before the window (the latest-ending one), else the previous night's lodging; null when unknown. */
  origin: { kind: "anchor"; anchor: DayTimelineAnchor } | { kind: "lodging"; point: DayTimelinePoint } | null;
  /** Fixed items starting inside the window, by start. */
  anchors: DayTimelineAnchor[];
  /** The first flight/transport starting at or after the window end, else that night's lodging; null: the day ends at its last stop. */
  terminal: { kind: "anchor"; anchor: DayTimelineAnchor; arriveByMinute: number | null }
    | { kind: "lodging"; point: DayTimelinePoint }
    | null;
  /** A fixed item's times cannot be resolved: the whole day is untimed. */
  unresolved: boolean;
  /** The day's straight-line estimate settings. */
  move: StraightLineMoveSettings;
  /** Display names of anchors (item titles) and points; empty when the client resolves names itself. */
  names: Record<string, string>;
}

export interface DayTimelineStop {
  id: string;
  type: PlaceType | null;
  /** Lodging, airport and station stays count as 0 regardless. */
  stayMinutes: number;
  latitude: number | null;
  longitude: number | null;
}

/** Transit minutes between two non-anchor points (lodging or stop) when known; null falls back to the straight-line estimate. */
export type DayTimelineTransit = (fromId: string, toId: string) => number | null;

export type DayTimelineMeal = "breakfast" | "lunch" | "dinner";

export type DayTimelineStopLabel =
  /** 「可當早餐」 */
  | { kind: "breakfast_candidate" }
  /** 「午餐・系統判斷」「晚餐・系統判斷」, with 「，晚了約 N 分」 when lateMinutes > 0. */
  | { kind: "meal"; meal: "lunch" | "dinner"; lateMinutes: number }
  /** 「午餐已經有了，這家也是餐廳」 */
  | { kind: "lunch_exists" }
  /** 「不在午餐、晚餐時間」 */
  | { kind: "off_meal_time" };

export type DayTimelineRow =
  /** 「早餐・出門前」 */
  | { kind: "breakfast_before" }
  /** Leaving the previous night's lodging (pointId), or an unknown start (null). */
  | { kind: "start"; minute: number | null; pointId: string | null }
  /** A fixed item. lateMinutes > 0: 「（固定）趕不上，約晚 N 分」. */
  | { kind: "anchor"; anchorId: string; minute: number | null; meal: DayTimelineMeal | null; lateMinutes: number; earlyMinutes: number }
  /**
   * minutes null with metres null: 「無法估計」. long: the one 「這段很遠」 sentence; from that leg on
   * every leg has minutes null (names only, no minutes) and the end has no time.
   */
  | { kind: "leg"; fromId: string; toId: string; minutes: number | null; straightLine: boolean; metres: number | null; long: boolean }
  /** 「自由時間約 X」 */
  | { kind: "free"; minute: number; minutes: number }
  /** stayMinutes is what the timeline uses; mealFloor: raised to the meal minimum. earlyMinutes: a short wait for a seat. */
  | { kind: "stop"; stopId: string; minute: number | null; stayMinutes: number; mealFloor: boolean; earlyMinutes: number; label: DayTimelineStopLabel | null }
  /** 「午餐・還沒選地方（X 附近）」; nearId names X. */
  | { kind: "meal_gap"; meal: "lunch" | "dinner"; minute: number; nearId: string; lateMinutes: number }
  /** 「約 HH:MM 回到住宿」, 「約 HH:MM 到 X」, or 「約 HH:MM 結束最後一站」. */
  | { kind: "end"; terminal: "lodging" | "anchor" | "none"; minute: number | null; toId: string | null; departureMinute: number | null; arriveByMinute: number | null }
  /** 「{from} → {to}：要多久系統算不準，請自己抓時間。」 plus the flight's take-off line when departureMinute is set. */
  | { kind: "tail_unknown"; fromId: string; toId: string; departureMinute: number | null; arriveByMinute: number | null };

export type DayTimeline =
  /** 「這天固定行程之外，沒有可安排的時間。」 */
  | { kind: "no_window" }
  /**
   * longLeg: a straight-line head/middle leg above 120 minutes, so no meals are placed.
   * moveMinutes: every leg's minutes (also on a long day, where rows hide them) except a tail whose
   * straight-line estimate is above 120; null when a leg cannot be measured. Only for comparing orders.
   */
  | { kind: "rows"; rows: DayTimelineRow[]; longLeg: boolean; moveMinutes: number | null };

type Position = DayTimelinePoint & { anchor: boolean };

/** Transfer points and lodging are passed through, never visited (f5 §1.1). */
const ZERO_STAY_TYPES: Partial<Record<PlaceType, true>> = { lodging: true, airport: true, station: true };

function stayOf(stop: DayTimelineStop) {
  return stop.type !== null && ZERO_STAY_TYPES[stop.type] ? 0 : Math.max(0, stop.stayMinutes);
}

interface MeasuredLeg {
  minutes: number | null;
  straightLine: boolean;
  metres: number | null;
}

type LunchGapState = "off" | "pending" | "after_anchor" | "done";

function mealOfAnchor(anchor: DayTimelineAnchor): DayTimelineMeal | null {
  if (anchor.itemType !== "meal") return null;
  if (anchor.startMinute < BREAKFAST_LATEST_MINUTE) return "breakfast";
  if (anchor.startMinute <= LUNCH_BAND_END_MINUTE) return "lunch";
  if (anchor.startMinute >= DINNER_BAND_START_MINUTE && anchor.startMinute <= DINNER_LATEST_MINUTE) return "dinner";
  return null;
}

interface RunOptions {
  meals: boolean;
  lunchGap: boolean;
}

interface RunResult {
  rows: DayTimelineRow[];
  longLeg: boolean;
  moveMinutes: number | null;
  /** Lunch should be placed, and no stop or fixed meal covers it: run again with a lunch gap. */
  needsLunchGap: boolean;
}

interface StopPlan {
  arrival: number;
  wait: number;
  stay: number;
  meal: "breakfast_candidate" | "lunch" | "dinner" | null;
}

function run(
  frame: DayTimelineFrame,
  stops: readonly DayTimelineStop[],
  transit: DayTimelineTransit | undefined,
  options: RunOptions,
): RunResult {
  const rows: DayTimelineRow[] = [];
  const pending = [...frame.anchors].sort((left, right) =>
    left.startMinute - right.startMinute || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const fixedMeals = new Set([
    ...(frame.origin?.kind === "anchor" ? [frame.origin.anchor] : []),
    ...frame.anchors,
  ].map(mealOfAnchor));
  const pointOf = (point: DayTimelinePoint, anchor: boolean): Position => ({ ...point, anchor });
  const stopPosition = (stop: DayTimelineStop): Position => ({ id: stop.id, latitude: stop.latitude, longitude: stop.longitude, anchor: false });

  let clock: number | null;
  let position: Position | null;
  if (frame.origin?.kind === "anchor") {
    const anchor = frame.origin.anchor;
    clock = frame.unresolved ? null : Math.max(frame.windowStartMinute, anchor.endMinute);
    rows.push({ kind: "anchor", anchorId: anchor.id, minute: frame.unresolved ? null : anchor.startMinute, meal: mealOfAnchor(anchor), lateMinutes: 0, earlyMinutes: 0 });
    position = pointOf(anchor.end, true);
  } else if (frame.origin?.kind === "lodging") {
    clock = frame.unresolved ? null : frame.windowStartMinute;
    rows.push({ kind: "start", minute: clock, pointId: frame.origin.point.id });
    position = pointOf(frame.origin.point, false);
  } else {
    clock = null;
    rows.push({ kind: "start", minute: null, pointId: null });
    position = null;
  }
  const startClock = clock;
  const meals = options.meals && startClock !== null;
  const lunchNeeded = meals && startClock! < LUNCH_BAND_END_MINUTE && frame.windowEndMinute >= LUNCH_SEAT_MINUTE + LUNCH_MINUTES;
  const dinnerNeeded = meals && frame.windowEndMinute >= DINNER_SEAT_MINUTE + DINNER_MINUTES;
  /** A stop or a fixed meal is lunch (「午餐已經有了」); a gap is not. */
  let lunchByPlace = fixedMeals.has("lunch");
  let lunchClaimed = lunchByPlace;
  let dinnerClaimed = fixedMeals.has("dinner");
  // Asserted, not inferred: closures below move it to every state.
  let lunchGap = (options.lunchGap && lunchNeeded && !lunchClaimed ? "pending" : "off") as LunchGapState;
  let longLeg = false;
  let moveMinutes: number | null = 0;
  let firstStopSeen = false;
  const plans = new Map<number, StopPlan["meal"]>();

  const measure = (from: Position | null, to: Position): MeasuredLeg => {
    if (!from) return { minutes: null, straightLine: false, metres: null };
    const metres = from.latitude !== null && from.longitude !== null && to.latitude !== null && to.longitude !== null
      ? Math.round(straightLineMeters(from as LatLng, to as LatLng)) : null;
    if (!from.anchor && !to.anchor && transit) {
      const minutes = transit(from.id, to.id);
      if (minutes !== null) return { minutes, straightLine: false, metres };
    }
    return { minutes: metres === null ? null : estimatedMoveMinutes(metres, frame.move), straightLine: true, metres };
  };
  const isLong = (leg: MeasuredLeg) => leg.straightLine && leg.minutes !== null && leg.minutes > LONG_LEG_MINUTES;
  /** Rule (4): an unknown leg to a fixed item only positions it, as 0 minutes. */
  const minutesToAnchor = (from: Position, anchor: DayTimelineAnchor) => measure(from, pointOf(anchor.start, true)).minutes ?? 0;

  /**
   * Moves to `to`, pushing the leg; returns the arrival, or null once the day is untimed. From the
   * first long leg on (f5 §1.4) every leg row carries no minutes and only that leg says `long`.
   */
  const travel = (to: Position) => {
    const leg = measure(position, to);
    const long = !longLeg && isLong(leg);
    const untimed = longLeg || long;
    if (position) {
      rows.push({ kind: "leg", fromId: position.id, toId: to.id, minutes: untimed ? null : leg.minutes, straightLine: leg.straightLine, metres: leg.metres, long });
      // Compared even when hidden: a long day's orders still differ in travel.
      moveMinutes = moveMinutes === null || leg.minutes === null ? null : moveMinutes + leg.minutes;
    }
    if (long) longLeg = true;
    position = to;
    if (clock === null || leg.minutes === null || longLeg) clock = null;
    else clock += leg.minutes;
    return clock;
  };
  const pushWait = (from: number, minutes: number) => {
    if (minutes >= FREE_TIME_ROW_MINUTES) rows.push({ kind: "free", minute: from, minutes });
  };

  const planStop = (index: number): StopPlan | null => {
    const stop = stops[index]!;
    const leg = measure(position, stopPosition(stop));
    if (clock === null || leg.minutes === null || isLong(leg) || longLeg) return null;
    const arrival = clock + leg.minutes;
    let stay = stayOf(stop);
    let wait = 0;
    let meal: StopPlan["meal"] = null;
    if (meals) {
      const restaurant = stop.type === "restaurant";
      if (!firstStopSeen && arrival < BREAKFAST_LATEST_MINUTE && (restaurant || stop.type === "cafe")) {
        meal = "breakfast_candidate";
      } else if (restaurant && !lunchClaimed && arrival >= BREAKFAST_LATEST_MINUTE && arrival <= LUNCH_BAND_END_MINUTE) {
        meal = "lunch";
        wait = Math.max(0, LUNCH_SEAT_MINUTE - arrival);
        stay = Math.max(stay, LUNCH_MINUTES);
      } else if (restaurant && !dinnerClaimed && index === stops.length - 1
        && arrival >= DINNER_BAND_START_MINUTE && arrival <= DINNER_LATEST_MINUTE) {
        meal = "dinner";
        wait = Math.max(0, DINNER_SEAT_MINUTE - arrival);
        stay = Math.max(stay, DINNER_MINUTES);
      }
    }
    return { arrival, wait, stay, meal };
  };

  const visitAnchor = (anchor: DayTimelineAnchor) => {
    const arrival = travel(pointOf(anchor.start, true));
    const meal = mealOfAnchor(anchor);
    if (arrival === null) {
      rows.push({ kind: "anchor", anchorId: anchor.id, minute: null, meal, lateMinutes: 0, earlyMinutes: 0 });
    } else if (arrival > anchor.startMinute) {
      rows.push({ kind: "anchor", anchorId: anchor.id, minute: anchor.startMinute, meal, lateMinutes: arrival - anchor.startMinute, earlyMinutes: 0 });
      clock = Math.max(anchor.endMinute, arrival);
    } else {
      const wait = anchor.startMinute - arrival;
      pushWait(arrival, wait);
      rows.push({ kind: "anchor", anchorId: anchor.id, minute: anchor.startMinute, meal, lateMinutes: 0,
        earlyMinutes: wait < FREE_TIME_ROW_MINUTES ? wait : 0 });
      clock = Math.max(anchor.endMinute, anchor.startMinute);
    }
    position = pointOf(anchor.end, true);
  };

  /** f5 §1.2 rule 6 checkpoints (a)–(d); true when the lunch gap was placed here. */
  const lunchCheckpoint = (nextEnd: number | null, forced: boolean) => {
    if (clock === null || !position || longLeg || (lunchGap !== "pending" && !(forced && lunchGap === "after_anchor"))) return false;
    if (!forced && !(clock >= LUNCH_GAP_CLOCK_MINUTE
      || (clock >= BREAKFAST_LATEST_MINUTE && nextEnd !== null && nextEnd > LUNCH_LATEST_MINUTE))) return false;
    const start = Math.max(clock, LUNCH_SEAT_MINUTE);
    const anchor = pending[0];
    if (anchor && start + LUNCH_MINUTES + minutesToAnchor(position, anchor) > anchor.startMinute) {
      lunchGap = "after_anchor";
      return false;
    }
    pushWait(clock, start - clock);
    rows.push({ kind: "meal_gap", meal: "lunch", minute: start, nearId: position.id, lateMinutes: Math.max(0, start - LUNCH_LATEST_MINUTE) });
    clock = start + LUNCH_MINUTES;
    lunchGap = "done";
    lunchClaimed = true;
    return true;
  };

  const dinnerGap = () => {
    if (!dinnerNeeded || dinnerClaimed || clock === null || !position || longLeg) return;
    if (lunchGap === "pending" || lunchGap === "after_anchor") return;
    const start = Math.max(clock, DINNER_SEAT_MINUTE);
    const anchor = pending[0];
    if (anchor && start + DINNER_MINUTES + minutesToAnchor(position, anchor) > anchor.startMinute) return;
    pushWait(clock, start - clock);
    rows.push({ kind: "meal_gap", meal: "dinner", minute: start, nearId: position.id, lateMinutes: Math.max(0, start - DINNER_LATEST_MINUTE) });
    clock = start + DINNER_MINUTES;
    dinnerClaimed = true;
  };

  for (let index = 0; index < stops.length; index += 1) {
    const stop = stops[index]!;
    for (;;) {
      const plan = planStop(index);
      const anchor = pending[0];
      let decision: "go" | "go_no_wait" | "anchor" = "go";
      if (plan && anchor && position) {
        const toAnchor = minutesToAnchor(stopPosition(stop), anchor);
        if (plan.arrival + plan.wait + plan.stay + toAnchor > anchor.startMinute) {
          decision = plan.wait > 0 && plan.arrival + plan.stay + toAnchor <= anchor.startMinute ? "go_no_wait" : "anchor";
        }
      }
      if (decision === "anchor") {
        const arrival = clock! + minutesToAnchor(position!, anchor!);
        if (lunchCheckpoint(Math.max(anchor!.endMinute, arrival), false)) continue;
        visitAnchor(pending.shift()!);
        if (lunchGap === "after_anchor") lunchCheckpoint(null, true);
        continue;
      }
      const wait = plan && decision === "go" ? plan.wait : 0;
      if (lunchCheckpoint(plan ? plan.arrival + wait + plan.stay : null, false)) continue;
      if (clock !== null) {
        pushWait(clock, wait);
        clock += wait;
      }
      const arrival = travel(stopPosition(stop));
      if (arrival === null || !plan) {
        rows.push({ kind: "stop", stopId: stop.id, minute: null, stayMinutes: plan?.stay ?? stayOf(stop), mealFloor: false, earlyMinutes: 0, label: null });
      } else {
        rows.push({ kind: "stop", stopId: stop.id, minute: arrival, stayMinutes: plan.stay, mealFloor: plan.stay > stayOf(stop),
          earlyMinutes: wait < FREE_TIME_ROW_MINUTES ? wait : 0, label: null });
        plans.set(rows.length - 1, plan.meal);
        if (plan.meal === "lunch") {
          lunchByPlace = true;
          lunchClaimed = true;
        }
        if (plan.meal === "dinner") dinnerClaimed = true;
        clock = arrival + plan.stay;
      }
      firstStopSeen = true;
      break;
    }
  }

  // (d) and rule (5): what is still due follows the last stop, each meal gap before the first fixed item it fits.
  while (pending.length > 0) {
    lunchCheckpoint(null, true);
    dinnerGap();
    visitAnchor(pending.shift()!);
  }
  lunchCheckpoint(null, true);
  dinnerGap();

  const terminal = frame.terminal;
  if (terminal && position) {
    const anchorEnd = terminal.kind === "anchor";
    const to = anchorEnd ? pointOf(terminal.anchor.start, true) : pointOf(terminal.point, false);
    const departureMinute = anchorEnd && terminal.anchor.itemType === "flight" ? terminal.anchor.startMinute : null;
    const arriveByMinute = anchorEnd && departureMinute !== null ? terminal.arriveByMinute : null;
    const leg = measure(position, to);
    if (longLeg) {
      // A long day names its end without a time and says nothing more about the tail.
      rows.push({ kind: "leg", fromId: position.id, toId: to.id, minutes: null, straightLine: leg.straightLine, metres: leg.metres, long: false });
      rows.push({ kind: "end", terminal: anchorEnd ? "anchor" : "lodging", minute: null, toId: to.id, departureMinute, arriveByMinute });
      // Same tail rule as a timed day: an uncertain tail is not compared.
      if (!isLong(leg)) moveMinutes = moveMinutes === null || leg.minutes === null ? null : moveMinutes + leg.minutes;
    } else if (isLong(leg)) {
      rows.push({ kind: "tail_unknown", fromId: position.id, toId: to.id, departureMinute, arriveByMinute });
    } else {
      rows.push({ kind: "leg", fromId: position.id, toId: to.id, minutes: leg.minutes, straightLine: leg.straightLine, metres: leg.metres, long: false });
      moveMinutes = moveMinutes === null || leg.minutes === null ? null : moveMinutes + leg.minutes;
      rows.push({ kind: "end", terminal: anchorEnd ? "anchor" : "lodging", minute: clock === null || leg.minutes === null ? null : clock + leg.minutes,
        toId: to.id, departureMinute, arriveByMinute });
    }
  } else {
    rows.push({ kind: "end", terminal: "none", minute: clock, toId: null, departureMinute: null, arriveByMinute: null });
  }

  if (meals && !longLeg) {
    const firstStop = rows.findIndex((row) => row.kind === "stop");
    const breakfastOpen = !fixedMeals.has("breakfast") && frame.origin?.kind === "lodging"
      && frame.windowStartMinute <= BREAKFAST_LATEST_MINUTE;
    rows.forEach((row, index) => {
      if (row.kind !== "stop" || row.minute === null) return;
      const meal = plans.get(index);
      const restaurant = stops.find((stop) => stop.id === row.stopId)?.type === "restaurant";
      if (meal === "lunch" || meal === "dinner") {
        const latest = meal === "lunch" ? LUNCH_LATEST_MINUTE : DINNER_LATEST_MINUTE;
        row.label = { kind: "meal", meal, lateMinutes: Math.max(0, row.minute - latest) };
      } else if (meal === "breakfast_candidate" && breakfastOpen) {
        row.label = { kind: "breakfast_candidate" };
      } else if (restaurant) {
        row.label = { kind: lunchByPlace ? "lunch_exists" : "off_meal_time" };
      }
    });
    const first = rows[firstStop];
    if (breakfastOpen && first?.kind === "stop" && first.minute !== null && first.label?.kind !== "breakfast_candidate") {
      rows.unshift({ kind: "breakfast_before" });
    }
  }
  return { rows, longLeg, moveMinutes, needsLunchGap: lunchNeeded && !lunchClaimed && !longLeg };
}

/**
 * The day's timeline for these stops in this order (f5 §1). Null for a day without stops: no
 * timeline is drawn. Deterministic: no clock, no randomness; the same inputs give the same rows.
 */
export function simulateDay(
  frame: DayTimelineFrame,
  stops: readonly DayTimelineStop[],
  transit?: DayTimelineTransit,
): DayTimeline | null {
  if (stops.length === 0) return null;
  if (frame.windowEndMinute <= frame.windowStartMinute) return { kind: "no_window" };
  const plain = run(frame, stops, transit, { meals: false, lunchGap: false });
  const chosen = plain.longLeg ? plain : (() => {
    const first = run(frame, stops, transit, { meals: true, lunchGap: false });
    return first.needsLunchGap ? run(frame, stops, transit, { meals: true, lunchGap: true }) : first;
  })();
  return { kind: "rows", rows: chosen.rows, longLeg: chosen.longLeg, moveMinutes: chosen.moveMinutes };
}

function invalid(): never {
  throw new Error("Invalid day timeline");
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : invalid();
}

function text(value: unknown): string {
  return typeof value === "string" ? value : invalid();
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : invalid();
}

function nullableFinite(value: unknown): number | null {
  return value === null ? null : finite(value);
}

function nullableText(value: unknown): string | null {
  return value === null ? null : text(value);
}

function bool(value: unknown): boolean {
  return typeof value === "boolean" ? value : invalid();
}

function oneOf<const T extends string>(value: unknown, values: readonly T[]): T {
  return typeof value === "string" && (values as readonly string[]).includes(value) ? value as T : invalid();
}

const ITEM_TYPES = ["flight", "lodging", "transport", "reservation", "meal", "activity", "free-time"] as const satisfies readonly ItineraryItemType[];
const MEALS = ["breakfast", "lunch", "dinner"] as const;

function point(value: unknown): DayTimelinePoint {
  const row = record(value);
  return { id: text(row.id), latitude: nullableFinite(row.latitude), longitude: nullableFinite(row.longitude) };
}

function anchor(value: unknown): DayTimelineAnchor {
  const row = record(value);
  return { id: text(row.id), itemType: oneOf(row.itemType, ITEM_TYPES), startMinute: finite(row.startMinute),
    endMinute: finite(row.endMinute), start: point(row.start), end: point(row.end) };
}

export function parseDayTimelineFrame(value: unknown): DayTimelineFrame {
  const row = record(value);
  const origin = row.origin === null ? null : record(row.origin);
  const terminal = row.terminal === null ? null : record(row.terminal);
  const move = record(row.move);
  const names = record(row.names);
  return {
    windowStartMinute: finite(row.windowStartMinute),
    windowEndMinute: finite(row.windowEndMinute),
    origin: origin === null ? null : origin.kind === "anchor" ? { kind: "anchor", anchor: anchor(origin.anchor) }
      : origin.kind === "lodging" ? { kind: "lodging", point: point(origin.point) } : invalid(),
    anchors: Array.isArray(row.anchors) ? row.anchors.map(anchor) : invalid(),
    terminal: terminal === null ? null
      : terminal.kind === "anchor" ? { kind: "anchor", anchor: anchor(terminal.anchor), arriveByMinute: nullableFinite(terminal.arriveByMinute) }
        : terminal.kind === "lodging" ? { kind: "lodging", point: point(terminal.point) } : invalid(),
    unresolved: bool(row.unresolved),
    move: { detourFactor: finite(move.detourFactor), speedKmh: finite(move.speedKmh), perLegMinutes: finite(move.perLegMinutes) },
    names: Object.fromEntries(Object.entries(names).map(([key, name]) => [key, text(name)])),
  };
}

function stopLabel(value: unknown): DayTimelineStopLabel | null {
  if (value === null) return null;
  const row = record(value);
  if (row.kind === "breakfast_candidate" || row.kind === "lunch_exists" || row.kind === "off_meal_time") return { kind: row.kind };
  if (row.kind === "meal") return { kind: "meal", meal: oneOf(row.meal, ["lunch", "dinner"] as const), lateMinutes: finite(row.lateMinutes) };
  return invalid();
}

function timelineRow(value: unknown): DayTimelineRow {
  const row = record(value);
  switch (row.kind) {
    case "breakfast_before": return { kind: "breakfast_before" };
    case "start": return { kind: "start", minute: nullableFinite(row.minute), pointId: nullableText(row.pointId) };
    case "anchor": return { kind: "anchor", anchorId: text(row.anchorId), minute: nullableFinite(row.minute),
      meal: row.meal === null ? null : oneOf(row.meal, MEALS), lateMinutes: finite(row.lateMinutes), earlyMinutes: finite(row.earlyMinutes) };
    case "leg": return { kind: "leg", fromId: text(row.fromId), toId: text(row.toId), minutes: nullableFinite(row.minutes),
      straightLine: bool(row.straightLine), metres: nullableFinite(row.metres), long: bool(row.long) };
    case "free": return { kind: "free", minute: finite(row.minute), minutes: finite(row.minutes) };
    case "stop": return { kind: "stop", stopId: text(row.stopId), minute: nullableFinite(row.minute), stayMinutes: finite(row.stayMinutes),
      mealFloor: bool(row.mealFloor), earlyMinutes: finite(row.earlyMinutes), label: stopLabel(row.label) };
    case "meal_gap": return { kind: "meal_gap", meal: oneOf(row.meal, ["lunch", "dinner"] as const), minute: finite(row.minute),
      nearId: text(row.nearId), lateMinutes: finite(row.lateMinutes) };
    case "end": return { kind: "end", terminal: oneOf(row.terminal, ["lodging", "anchor", "none"] as const), minute: nullableFinite(row.minute),
      toId: nullableText(row.toId), departureMinute: nullableFinite(row.departureMinute), arriveByMinute: nullableFinite(row.arriveByMinute) };
    case "tail_unknown": return { kind: "tail_unknown", fromId: text(row.fromId), toId: text(row.toId),
      departureMinute: nullableFinite(row.departureMinute), arriveByMinute: nullableFinite(row.arriveByMinute) };
    default: return invalid();
  }
}

export function parseDayTimeline(value: unknown): DayTimeline {
  const row = record(value);
  if (row.kind === "no_window") return { kind: "no_window" };
  if (row.kind !== "rows" || !Array.isArray(row.rows)) return invalid();
  return { kind: "rows", rows: row.rows.map(timelineRow), longLeg: bool(row.longLeg), moveMinutes: nullableFinite(row.moveMinutes) };
}
