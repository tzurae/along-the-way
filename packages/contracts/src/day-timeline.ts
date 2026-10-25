import type { TripPlaceMealRole } from "./trip-places";
import type { ItineraryItemType, PlaceType } from "./trip-skeleton";
import { isRecord } from "./type-guards";

/**
 * One day's timeline (f5 §1, p9 §2): where the day starts and ends, its fixed items, when each meal
 * falls, and how far an order strays from the meal bands. `simulateDay` walks an order with
 * `simulateStep`, the same step the api's order search runs, so the search, whole-trip drafts and
 * both dialog columns follow one rule set. Every minute is a local minute after the day's midnight.
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
/** f5 §1.5: lateness and early arrivals score one point per started quarter hour. */
const BAND_STEP_MINUTES = 15;
const LUNCH_GAP_CLOCK_MINUTE = 11 * 60;
const NO_TIME = Number.NEGATIVE_INFINITY;

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
  /** 哪一餐 (f5 §1.2, 1b): a marked meal is that meal; "none" is never one; null leaves it to the automatic rule. */
  mealRole: TripPlaceMealRole | null;
  latitude: number | null;
  longitude: number | null;
}

/** Transit minutes between two non-anchor points (lodging or stop) when known; null falls back to the straight-line estimate. */
export type DayTimelineTransit = (fromId: string, toId: string) => number | null;

export type DayTimelineMeal = "breakfast" | "lunch" | "dinner";

/**
 * Which stops carry a meal before any order is chosen (p9 §2.2.2–§2.2.4). Resolved once from the
 * base order (the saved order) by `resolveDayMeals` and passed to every `simulateDay` of that day,
 * so the saved column, the suggested column and the order search agree on who is dinner.
 */
export interface DayMealRoles {
  /** δ: the dinner stop. Last in the day it waits for 17:30 however early it arrives and stays 75 minutes. */
  dinnerStopId: string | null;
  /** λ: the base order's last stop, an unmarked restaurant that is not δ; the search keeps it last. */
  lastRestaurantId: string | null;
  /** λ reached lunch 10:30–15:00 in the base order: it is this day's lunch (「午餐・系統判斷」). */
  lastRestaurantLunch: boolean;
  /** β: the breakfast stop; an order scores +1 when it is not the first stop or arrives after 10:30. */
  breakfastStopId: string | null;
}

export const NO_DAY_MEAL_ROLES: DayMealRoles = { dinnerStopId: null, lastRestaurantId: null, lastRestaurantLunch: false, breakfastStopId: null };

/** f5 §1.5 levels 1–2 for one order, smaller is better; travel is `moveMinutes`. */
export interface DayTimelineScore {
  /** Fixed items reached late, plus a last stop or lunch gap running past a flight day's window (f5 :170-172). */
  missedFixed: number;
  /** Meals outside their bands: late seats, early restaurants, β moved, marked dinner before 16:30 (f5 :173-178, p9 §2.2). */
  mealOffBands: number;
}

/** Where the lunch gap sits: after `beforeId` (null: before any stop) and before `afterId` (null: after the last stop). */
export interface DayLunchGap {
  beforeId: string | null;
  afterId: string | null;
}

export type DayTimelineStopLabel =
  /** 「可當早餐」 */
  | { kind: "breakfast_candidate" }
  /**
   * marked: the member's 哪一餐, 「早餐」「午餐」「晚餐」; else the automatic 「午餐・系統判斷」「晚餐・系統判斷」.
   * tooEarly: a marked meal reached before its band, 「午餐・太早」「晚餐・太早」. 「，晚了約 N 分」 when lateMinutes > 0.
   */
  | { kind: "meal"; meal: DayTimelineMeal; marked: boolean; tooEarly: boolean; lateMinutes: number }
  /** 1a 「午餐已經有了，這家也是餐廳」; 1b 「也是餐廳」 with ［當晚餐］［移到備案］ */
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
   * score: null when the day could not be timed through (long or unknown leg, unknown start).
   * lunchGap: where 「午餐・還沒選地方」 was drawn; null when a stop or fixed meal is lunch, or none is placed.
   */
  | { kind: "rows"; rows: DayTimelineRow[]; longLeg: boolean; moveMinutes: number | null; score: DayTimelineScore | null; lunchGap: DayLunchGap | null };

type Position = DayTimelinePoint & { anchor: boolean };

/** Transfer points and lodging are passed through, never visited (f5 §1.1). */
const ZERO_STAY_TYPES: Partial<Record<PlaceType, true>> = { lodging: true, airport: true, station: true };

function stayOf(stop: DayTimelineStop) {
  return stop.type !== null && ZERO_STAY_TYPES[stop.type] ? 0 : Math.max(0, stop.stayMinutes);
}

export function isLocatedStop<S extends DayTimelineStop>(stop: S): stop is S & LatLng {
  return stop.latitude !== null && stop.longitude !== null;
}

interface MeasuredLeg {
  minutes: number | null;
  straightLine: boolean;
  metres: number | null;
}

function mealOfAnchor(anchor: DayTimelineAnchor): DayTimelineMeal | null {
  if (anchor.itemType !== "meal") return null;
  if (anchor.startMinute < BREAKFAST_LATEST_MINUTE) return "breakfast";
  if (anchor.startMinute <= LUNCH_BAND_END_MINUTE) return "lunch";
  if (anchor.startMinute >= DINNER_BAND_START_MINUTE && anchor.startMinute <= DINNER_LATEST_MINUTE) return "dinner";
  return null;
}

/** f5 §1.2 table: how the day's lunch is found. "marked" includes λ as lunch (p9 §2.2.4). */
export type DayLunchMode = "off" | "fixed" | "marked" | "auto";

/**
 * Everything about one day that does not depend on the order: the frame, the meal roles and the
 * meal modes (p9 §2.2.1). Built once by `createDayWalk`, then shared by every order of that day.
 * Legs are measured once per pair and cached.
 */
export interface DayWalk {
  readonly frame: DayTimelineFrame;
  readonly roles: DayMealRoles;
  readonly anchors: readonly DayTimelineAnchor[];
  /** anchorEnds[i]: the latest end among anchors[0..i−1]; a late seat is measured from the fixed item that pushed it (f5 :174). */
  readonly anchorEnds: readonly number[];
  readonly origin: Position | null;
  /** Null when the day cannot be timed (unknown start, unresolved fixed item). Known also when meals are off: stops before a long leg still get times (f5 §1.4). */
  readonly startClock: number | null;
  /** Meals are placed: the start is known and the caller asked for meals. */
  readonly meals: boolean;
  readonly lunchNeeded: boolean;
  readonly dinnerNeeded: boolean;
  readonly lunchMode: DayLunchMode;
  readonly fixedMeals: ReadonlySet<DayTimelineMeal>;
  /** A stop or a fixed meal is lunch (「午餐已經有了」) before any order is walked. */
  readonly lunchByPlace: boolean;
  /** Dinner is already arranged (a fixed dinner or a marked δ): no dinner gap. */
  readonly dinnerArranged: boolean;
  /** f5 §1.2 breakfast conditions (1)(2): 「可當早餐」/「早餐・出門前」 may be drawn. */
  readonly breakfastOpen: boolean;
  readonly transit: DayTimelineTransit | undefined;
  readonly legs: Map<string, MeasuredLeg>;
}

/**
 * The walk state after each step (p9 §2.3): the clock and position, the next fixed item, the lunch
 * state μ, the gap branch's no-gap twin (shadow) and the score so far. Plain data: copy, never share.
 */
export interface DayStepState {
  clock: number;
  position: Position;
  /** Index of the next window anchor still to visit. */
  anchorIndex: number;
  /**
   * μ: settled (lunch is a stop, a fixed meal, or found), open (automatic lunch, nothing decided),
   * store (this order finds a restaurant, no gap), gap (the gap is placed, or deferred past a fixed item).
   */
  lunch: "settled" | "open" | "store" | "gap";
  /** A wanted gap could not precede the next fixed item: it follows that item (f5 :118). */
  lunchDeferred: boolean;
  lunchByPlace: boolean;
  dinnerArranged: boolean;
  /** The gap branch's no-gap twin; the branch is wrong once the twin finds a restaurant in the lunch band. */
  shadow: DayStepState | null;
  /** No stop visited yet. */
  first: boolean;
  lastStopId: string | null;
  /** End of the latest stop or lunch gap (f5 :172 flight-day exception). */
  lastEnd: number;
  missed: number;
  level: number;
  travel: number;
}

type StopMeal =
  | { kind: "meal"; meal: DayTimelineMeal; marked: boolean; tooEarly: boolean }
  | { kind: "breakfast_candidate" }
  /** A restaurant in a meal's band on a day that does not place that meal (rule 8): a plain stop, no label. */
  | { kind: "unscheduled" };

interface Visit {
  /** Before any seat wait. */
  arrival: number;
  wait: number;
  stay: number;
  meal: StopMeal | null;
  level: number;
  /** This restaurant becomes the automatic lunch. */
  lunchFound: boolean;
  /** δ at the end of the day: dinner is arranged, no gap. */
  dinnerFound: boolean;
}

/** Rows and the facts the label pass needs; null while the order search only scores. */
export interface DayStepRecorder {
  rows: DayTimelineRow[];
  /** Row index → the stop's meal decision; labels are assigned after the walk. */
  plans: Map<number, StopMeal | null>;
  /** Every measured leg, also when its row hides the minutes (f5 §1.4); null once a leg cannot be measured. */
  moveMinutes: number | null;
  lunchGap: DayLunchGap | null;
  /** Each timed stop's arrival before its seat wait (base-order facts, p9 §2.1). */
  arrivals: Map<string, number>;
  /** The unmarked restaurant the automatic rule took as lunch, if any. */
  autoLunchId: string | null;
}

export type DayStepMode =
  /** f5's first simulation: never a gap; the order is expected to find lunch itself. */
  | "store"
  /** f5's second simulation: the gap goes at the first checkpoint whose condition holds. */
  | "gap"
  /** The order search: an undecided lunch splits into a store twin and a gap twin at that checkpoint (p9 §2.3). */
  | "branch";

export interface DayStepOptions {
  /** This is the day's last located stop. */
  last: boolean;
  /** δ last in the day (p9 §2.2.2 (d)): an undecided lunch gap goes before leaving for it, whatever the clock. */
  forcedLunch: boolean;
  mode: DayStepMode;
  record: DayStepRecorder | null;
}

export type DayStepOutcome =
  | { kind: "ok"; state: DayStepState }
  /** branch mode: the gap checkpoint held here; `state` is the walk at that checkpoint, before any gap. */
  | { kind: "split"; state: DayStepState; deferred: boolean }
  /** A long or unmeasurable leg: the rest of the day is untimed (rows were recorded up to this stop). */
  | { kind: "untimed"; long: boolean; position: Position; anchorIndex: number };

function pointOf(point: DayTimelinePoint, anchor: boolean): Position {
  return { ...point, anchor };
}

function stopPosition(stop: DayTimelineStop): Position {
  return { id: stop.id, latitude: stop.latitude, longitude: stop.longitude, anchor: false };
}

export function createDayWalk(
  frame: DayTimelineFrame,
  stops: readonly DayTimelineStop[],
  transit: DayTimelineTransit | null | undefined,
  roles: DayMealRoles,
  meals = true,
): DayWalk {
  const anchors = [...frame.anchors].sort((left, right) =>
    left.startMinute - right.startMinute || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const anchorEnds = [NO_TIME];
  for (const anchor of anchors) anchorEnds.push(Math.max(anchorEnds.at(-1)!, anchor.endMinute));
  const fixedMeals = new Set<DayTimelineMeal>();
  for (const anchor of [...(frame.origin?.kind === "anchor" ? [frame.origin.anchor] : []), ...anchors]) {
    const meal = mealOfAnchor(anchor);
    if (meal) fixedMeals.add(meal);
  }
  let origin: Position | null = null;
  let startClock: number | null = null;
  if (frame.origin?.kind === "anchor") {
    origin = pointOf(frame.origin.anchor.end, true);
    startClock = frame.unresolved ? null : Math.max(frame.windowStartMinute, frame.origin.anchor.endMinute);
  } else if (frame.origin?.kind === "lodging") {
    origin = pointOf(frame.origin.point, false);
    startClock = frame.unresolved ? null : frame.windowStartMinute;
  }
  const timed = meals && startClock !== null;
  // Rule 8: lunch only when the day starts before 15:00 and runs past 12:30; dinner only when it runs past 18:45.
  const lunchNeeded = timed && startClock! < LUNCH_BAND_END_MINUTE && frame.windowEndMinute >= LUNCH_SEAT_MINUTE + LUNCH_MINUTES;
  const dinnerNeeded = timed && frame.windowEndMinute >= DINNER_SEAT_MINUTE + DINNER_MINUTES;
  const ids = new Set(stops.map((stop) => stop.id));
  const inDay = (id: string | null) => id !== null && ids.has(id) ? id : null;
  // Roles only bind to stops of this order; a removed δ, λ or β simply has no effect.
  const dayRoles: DayMealRoles = {
    dinnerStopId: dinnerNeeded ? inDay(roles.dinnerStopId) : null,
    lastRestaurantId: inDay(roles.lastRestaurantId),
    lastRestaurantLunch: roles.lastRestaurantLunch && inDay(roles.lastRestaurantId) !== null,
    breakfastStopId: inDay(roles.breakfastStopId),
  };
  const markedLunch = stops.some((stop) => stop.mealRole === "lunch") || dayRoles.lastRestaurantLunch;
  const dinnerStop = dayRoles.dinnerStopId === null ? null : stops.find((stop) => stop.id === dayRoles.dinnerStopId) ?? null;
  return {
    frame, roles: dayRoles, anchors, anchorEnds, origin, startClock, meals: timed,
    lunchNeeded, dinnerNeeded,
    lunchMode: !lunchNeeded ? "off" : fixedMeals.has("lunch") ? "fixed" : markedLunch ? "marked" : "auto",
    fixedMeals,
    lunchByPlace: fixedMeals.has("lunch") || markedLunch,
    dinnerArranged: fixedMeals.has("dinner") || dinnerStop?.mealRole === "dinner",
    breakfastOpen: timed && !fixedMeals.has("breakfast") && !stops.some((stop) => stop.mealRole === "breakfast")
      && frame.origin?.kind === "lodging" && frame.windowStartMinute <= BREAKFAST_LATEST_MINUTE,
    transit: transit ?? undefined,
    legs: new Map(),
  };
}

/** The walk before any stop; null when the day cannot be timed. */
export function initialDayStep(walk: DayWalk): DayStepState | null {
  if (walk.startClock === null || !walk.origin) return null;
  return {
    clock: walk.startClock, position: walk.origin, anchorIndex: 0,
    lunch: walk.lunchMode === "auto" ? "open" : "settled", lunchDeferred: false,
    lunchByPlace: walk.lunchByPlace, dinnerArranged: walk.dinnerArranged,
    shadow: null, first: true, lastStopId: null, lastEnd: walk.startClock, missed: 0, level: 0, travel: 0,
  };
}

function measure(walk: DayWalk, from: Position | null, to: Position): MeasuredLeg {
  if (!from) return { minutes: null, straightLine: false, metres: null };
  const key = `${from.id}\u0000${from.anchor ? 1 : 0}\u0000${to.id}\u0000${to.anchor ? 1 : 0}`;
  const cached = walk.legs.get(key);
  if (cached) return cached;
  const metres = from.latitude !== null && from.longitude !== null && to.latitude !== null && to.longitude !== null
    ? Math.round(straightLineMeters(from as LatLng, to as LatLng)) : null;
  const transitMinutes = !from.anchor && !to.anchor && walk.transit ? walk.transit(from.id, to.id) : null;
  const leg: MeasuredLeg = transitMinutes !== null
    ? { minutes: transitMinutes, straightLine: false, metres }
    : { minutes: metres === null ? null : estimatedMoveMinutes(metres, walk.frame.move), straightLine: true, metres };
  walk.legs.set(key, leg);
  return leg;
}

const isLong = (leg: MeasuredLeg) => leg.straightLine && leg.minutes !== null && leg.minutes > LONG_LEG_MINUTES;

/** Rule (4): an unknown leg to a fixed item only positions it, as 0 minutes. */
function minutesToAnchor(walk: DayWalk, from: Position, anchor: DayTimelineAnchor) {
  return measure(walk, from, pointOf(anchor.start, true)).minutes ?? 0;
}

function addMove(record: DayStepRecorder | null, leg: MeasuredLeg) {
  if (!record) return;
  record.moveMinutes = record.moveMinutes === null || leg.minutes === null ? null : record.moveMinutes + leg.minutes;
}

function pushLeg(record: DayStepRecorder | null, from: Position, to: Position, leg: MeasuredLeg, minutes: number | null, long: boolean) {
  record?.rows.push({ kind: "leg", fromId: from.id, toId: to.id, minutes, straightLine: leg.straightLine, metres: leg.metres, long });
  addMove(record, leg);
}

function pushWait(record: DayStepRecorder | null, from: number, minutes: number) {
  if (minutes >= FREE_TIME_ROW_MINUTES) record?.rows.push({ kind: "free", minute: from, minutes });
}

const quarters = (minutes: number) => Math.floor(minutes / BAND_STEP_MINUTES);

/** f5 :175-178: points for arriving before a band. */
const earlyPoints = (bandStart: number, arrival: number) => quarters(bandStart - arrival) + 1;

/** f5 :174: lateness from the latest seat, the day's start or the fixed item that pushed the meal. */
function latePoints(walk: DayWalk, state: DayStepState, latest: number, arrival: number) {
  return quarters(Math.max(0, arrival - Math.max(latest, walk.startClock ?? NO_TIME, walk.anchorEnds[state.anchorIndex]!)));
}

/** f5 §1.2 and p9 §2.2: what this stop is when reached at `arrival`, and what it costs. */
function classify(walk: DayWalk, state: DayStepState, stop: DayTimelineStop, last: boolean, arrival: number): Visit {
  let stay = stayOf(stop);
  let wait = 0;
  let meal: StopMeal | null = null;
  let level = 0;
  let lunchFound = false;
  let dinnerFound = false;
  if (walk.meals) {
    const role = stop.mealRole;
    const restaurant = stop.type === "restaurant";
    const isDelta = stop.id === walk.roles.dinnerStopId;
    const isLambda = stop.id === walk.roles.lastRestaurantId;
    const isBeta = stop.id === walk.roles.breakfastStopId;
    if (role === "breakfast") {
      meal = { kind: "meal", meal: "breakfast", marked: true, tooEarly: false };
      level += latePoints(walk, state, BREAKFAST_LATEST_MINUTE, arrival);
    } else if (role === "lunch" || (isLambda && walk.roles.lastRestaurantLunch)) {
      // Rules 3–4: within an hour early waits for a seat; before the band is 「午餐・太早」, no wait.
      const tooEarly = arrival < BREAKFAST_LATEST_MINUTE;
      meal = { kind: "meal", meal: "lunch", marked: role === "lunch", tooEarly };
      wait = tooEarly ? 0 : Math.max(0, LUNCH_SEAT_MINUTE - arrival);
      stay = Math.max(stay, LUNCH_MINUTES);
      level += tooEarly ? (walk.lunchNeeded ? earlyPoints(BREAKFAST_LATEST_MINUTE, arrival) : 0) : latePoints(walk, state, LUNCH_LATEST_MINUTE, arrival);
    } else if (isDelta) {
      if (last) {
        // δ at the end of the day waits for 17:30 however early it arrives (p9 §2.2.2).
        meal = { kind: "meal", meal: "dinner", marked: role === "dinner", tooEarly: false };
        wait = Math.max(0, DINNER_SEAT_MINUTE - arrival);
        stay = Math.max(stay, DINNER_MINUTES);
        level += latePoints(walk, state, DINNER_LATEST_MINUTE, arrival);
        dinnerFound = true;
      } else if (role === "dinner") {
        // A marked dinner the member put before other stops: f5's own rules 3–4 and :177.
        const tooEarly = arrival < DINNER_BAND_START_MINUTE;
        meal = { kind: "meal", meal: "dinner", marked: true, tooEarly };
        wait = tooEarly ? 0 : Math.max(0, DINNER_SEAT_MINUTE - arrival);
        stay = Math.max(stay, DINNER_MINUTES);
        level += tooEarly ? earlyPoints(DINNER_BAND_START_MINUTE, arrival) : latePoints(walk, state, DINNER_LATEST_MINUTE, arrival);
      }
      // An unmarked δ before other stops is a plain stop and never the automatic lunch.
    } else if (role === "dinner") {
      // A second marked dinner is a plain stop (p9 §5), still scored before 16:30 (f5 :177).
      if (walk.dinnerNeeded && arrival < DINNER_BAND_START_MINUTE) level += earlyPoints(DINNER_BAND_START_MINUTE, arrival);
    } else if (role === "none" || isLambda) {
      // Rule 1; λ as a plain stop is no meal and is never the automatic lunch (p9 §2.2.4).
    } else if (state.first && arrival < BREAKFAST_LATEST_MINUTE && (restaurant || stop.type === "cafe")) {
      meal = { kind: "breakfast_candidate" };
      // f5 :176: the only lunch restaurant pushed to breakfast; β is exempt (p9 §2.2.3).
      if (restaurant && walk.lunchMode === "auto" && !isBeta) level += earlyPoints(BREAKFAST_LATEST_MINUTE, arrival);
    } else if (restaurant) {
      if (arrival >= BREAKFAST_LATEST_MINUTE && arrival <= LUNCH_BAND_END_MINUTE) {
        if (walk.lunchMode === "auto" && state.lunch !== "settled" && state.lunch !== "gap") {
          meal = { kind: "meal", meal: "lunch", marked: false, tooEarly: false };
          wait = Math.max(0, LUNCH_SEAT_MINUTE - arrival);
          stay = Math.max(stay, LUNCH_MINUTES);
          level += latePoints(walk, state, LUNCH_LATEST_MINUTE, arrival);
          lunchFound = true;
        } else if (walk.lunchMode === "off") {
          meal = { kind: "unscheduled" };
        }
      } else if (arrival < BREAKFAST_LATEST_MINUTE) {
        if (walk.lunchMode === "auto" && !isBeta) level += earlyPoints(BREAKFAST_LATEST_MINUTE, arrival);
      } else if (walk.lunchMode === "auto" && state.lunch !== "settled") {
        // f5 :178: lunch has no stop and this restaurant only arrives after the band.
        level += quarters(arrival - LUNCH_BAND_END_MINUTE) + 1;
      } else if (last && !walk.dinnerNeeded && arrival >= DINNER_BAND_START_MINUTE && arrival <= DINNER_LATEST_MINUTE) {
        meal = { kind: "unscheduled" };
      }
    }
    if (isBeta && !(state.first && arrival < BREAKFAST_LATEST_MINUTE)) level += 1;
  }
  return { arrival, wait, stay, meal, level, lunchFound, dinnerFound };
}

/** Rule 6 (a)–(c): the clock says lunch, or the next segment would end after the latest seat. */
const gapWanted = (clock: number, nextEnd: number) =>
  clock >= LUNCH_GAP_CLOCK_MINUTE || (clock >= BREAKFAST_LATEST_MINUTE && nextEnd > LUNCH_LATEST_MINUTE);

/** A gap placed now still reaches the next fixed item in time (f5 :118). */
function gapFits(walk: DayWalk, state: DayStepState, anchor: DayTimelineAnchor | undefined) {
  if (!anchor) return true;
  return Math.max(state.clock, LUNCH_SEAT_MINUTE) + LUNCH_MINUTES + minutesToAnchor(walk, state.position, anchor) <= anchor.startMinute;
}

/** Draws 「午餐・還沒選地方」 here; nextStopId is the stop the gap precedes (null after the last stop). */
export function insertLunchGap(walk: DayWalk, state: DayStepState, nextStopId: string | null, record: DayStepRecorder | null) {
  const start = Math.max(state.clock, LUNCH_SEAT_MINUTE);
  pushWait(record, state.clock, start - state.clock);
  record?.rows.push({ kind: "meal_gap", meal: "lunch", minute: start, nearId: state.position.id, lateMinutes: Math.max(0, start - LUNCH_LATEST_MINUTE) });
  if (record) record.lunchGap = { beforeId: state.lastStopId, afterId: nextStopId };
  state.level += latePoints(walk, state, LUNCH_LATEST_MINUTE, start);
  state.clock = start + LUNCH_MINUTES;
  state.lastEnd = state.clock;
  state.lunch = "gap";
  state.lunchDeferred = false;
}

/** The two continuations of an undecided lunch at a checkpoint (p9 §2.3): find a restaurant, or take the gap here. */
export function splitLunch(walk: DayWalk, at: DayStepState, deferred: boolean, nextStopId: string | null): { store: DayStepState; gap: DayStepState } {
  const store: DayStepState = { ...at, lunch: "store", shadow: null };
  const gap: DayStepState = { ...at, lunch: "gap", lunchDeferred: deferred, shadow: null };
  if (!deferred) insertLunchGap(walk, gap, nextStopId, null);
  return { store, gap };
}

/** Rule (1)–(3): travels to the fixed item; "long"/"untimed" when that leg is long or unmeasurable (rule (4)). */
function visitAnchor(walk: DayWalk, state: DayStepState, anchor: DayTimelineAnchor, record: DayStepRecorder | null): "ok" | "untimed" | "long" {
  const to = pointOf(anchor.start, true);
  const leg = measure(walk, state.position, to);
  const meal = mealOfAnchor(anchor);
  state.anchorIndex += 1;
  if (leg.minutes === null || isLong(leg)) {
    pushLeg(record, state.position, to, leg, null, isLong(leg));
    record?.rows.push({ kind: "anchor", anchorId: anchor.id, minute: null, meal, lateMinutes: 0, earlyMinutes: 0 });
    state.position = pointOf(anchor.end, true);
    return isLong(leg) ? "long" : "untimed";
  }
  const arrival = state.clock + leg.minutes;
  pushLeg(record, state.position, to, leg, leg.minutes, false);
  state.travel += leg.minutes;
  if (arrival > anchor.startMinute) {
    const late = arrival - anchor.startMinute;
    record?.rows.push({ kind: "anchor", anchorId: anchor.id, minute: anchor.startMinute, meal, lateMinutes: late, earlyMinutes: 0 });
    state.missed += 1;
    if (meal) state.level += quarters(late);
    state.clock = Math.max(anchor.endMinute, arrival);
  } else {
    const wait = anchor.startMinute - arrival;
    pushWait(record, arrival, wait);
    record?.rows.push({ kind: "anchor", anchorId: anchor.id, minute: anchor.startMinute, meal, lateMinutes: 0,
      earlyMinutes: wait < FREE_TIME_ROW_MINUTES ? wait : 0 });
    state.clock = Math.max(anchor.endMinute, anchor.startMinute);
  }
  state.position = pointOf(anchor.end, true);
  return "ok";
}

/**
 * One step of the walk (p9 §2.3): fixed items that must come first (rule (1)), the lunch checkpoints,
 * the leg, the stop's meal, seat wait and stay. Pure: `state` is not modified.
 */
export function simulateStep(walk: DayWalk, input: DayStepState, stop: DayTimelineStop, options: DayStepOptions): DayStepOutcome {
  const state: DayStepState = { ...input };
  const record = options.record;
  const target = stopPosition(stop);
  /** The day stops being timed here: `long` when a long leg was already met (the fixed item's), else an unmeasurable one. */
  const untimed = (long: boolean): DayStepOutcome => {
    const thisLong = untimedStop(walk, state.position, stop, record, long);
    return { kind: "untimed", long: long || thisLong, position: target, anchorIndex: state.anchorIndex };
  };
  for (;;) {
    const anchor = walk.anchors[state.anchorIndex];
    // p9 §2.2.2 (d): the gap goes before δ, after any fixed item it cannot precede. Never in f5's first
    // simulation (store): that walk only asks whether a restaurant is found; the gap walk places the gap.
    if (options.forcedLunch && options.mode !== "store" && state.lunch === "open") {
      if (gapFits(walk, state, anchor)) {
        insertLunchGap(walk, state, stop.id, record);
      } else {
        const visited = visitAnchor(walk, state, anchor!, record);
        if (visited !== "ok") return untimed(visited === "long");
      }
      continue;
    }
    const leg = measure(walk, state.position, target);
    if (leg.minutes === null || isLong(leg)) {
      // Rule 6 (a)(b) still holds before a leg that cannot be timed: a gap wanted by the clock alone goes here (f5 1a).
      if (options.mode === "gap" && state.lunch === "open" && gapWanted(state.clock, NO_TIME) && gapFits(walk, state, anchor)) {
        insertLunchGap(walk, state, stop.id, record);
      }
      return untimed(false);
    }
    const visit = classify(walk, state, stop, options.last, state.clock + leg.minutes);
    let wait = visit.wait;
    let anchorFirst = false;
    if (anchor) {
      const toAnchor = minutesToAnchor(walk, target, anchor);
      if (visit.arrival + wait + visit.stay + toAnchor > anchor.startMinute) {
        // Rule 3's exception: skip the seat wait rather than miss the fixed item.
        if (wait > 0 && visit.arrival + visit.stay + toAnchor <= anchor.startMinute) wait = 0;
        else anchorFirst = true;
      }
    }
    // Rule 6 (a)(b)(c): before leaving for the next segment (the stop, or the fixed item that comes first).
    if (state.lunch === "open") {
      const nextEnd = anchorFirst
        ? Math.max(anchor!.endMinute, state.clock + minutesToAnchor(walk, state.position, anchor!))
        : visit.arrival + wait + visit.stay;
      if (gapWanted(state.clock, nextEnd)) {
        const deferred = !gapFits(walk, state, anchor);
        if (options.mode === "branch") return { kind: "split", state, deferred };
        if (options.mode === "gap") {
          if (deferred) {
            state.lunch = "gap";
            state.lunchDeferred = true;
          } else {
            insertLunchGap(walk, state, stop.id, record);
          }
          continue;
        }
      }
    }
    if (anchorFirst) {
      const visited = visitAnchor(walk, state, anchor!, record);
      if (visited !== "ok") return untimed(visited === "long");
      // f5 :118: a deferred gap follows the fixed item it could not precede, if it fits before the next one.
      if (state.lunch === "gap" && state.lunchDeferred && gapFits(walk, state, walk.anchors[state.anchorIndex])) {
        insertLunchGap(walk, state, stop.id, record);
      }
      continue;
    }
    // Free time before the leg: a seat wait is spent before travelling (f5 §1.3).
    pushWait(record, state.clock, wait);
    state.clock += wait;
    pushLeg(record, state.position, target, leg, leg.minutes, false);
    state.travel += leg.minutes;
    const arrival = state.clock + leg.minutes;
    if (record) {
      record.rows.push({ kind: "stop", stopId: stop.id, minute: arrival, stayMinutes: visit.stay, mealFloor: visit.stay > stayOf(stop),
        earlyMinutes: wait < FREE_TIME_ROW_MINUTES ? wait : 0, label: null });
      record.plans.set(record.rows.length - 1, visit.meal);
      record.arrivals.set(stop.id, visit.arrival);
      if (visit.lunchFound) record.autoLunchId = stop.id;
    }
    if (visit.lunchFound) {
      state.lunch = "settled";
      state.lunchByPlace = true;
    }
    if (visit.dinnerFound) state.dinnerArranged = true;
    state.level += visit.level;
    state.position = target;
    state.clock = arrival + visit.stay;
    state.lastEnd = state.clock;
    state.lastStopId = stop.id;
    state.first = false;
    return { kind: "ok", state };
  }
}

/** Rule 7: 「晚餐・還沒選地方」 after the last stop, only drawn; moves the clock but never a score. */
function dinnerGap(walk: DayWalk, state: DayStepState, record: DayStepRecorder | null) {
  if (!walk.dinnerNeeded || state.dinnerArranged || state.lunch === "open" || (state.lunch === "gap" && state.lunchDeferred)) return;
  const start = Math.max(state.clock, DINNER_SEAT_MINUTE);
  const anchor = walk.anchors[state.anchorIndex];
  if (anchor && start + DINNER_MINUTES + minutesToAnchor(walk, state.position, anchor) > anchor.startMinute) return;
  pushWait(record, state.clock, start - state.clock);
  record?.rows.push({ kind: "meal_gap", meal: "dinner", minute: start, nearId: state.position.id, lateMinutes: Math.max(0, start - DINNER_LATEST_MINUTE) });
  state.clock = start + DINNER_MINUTES;
  state.dinnerArranged = true;
}

function terminalRows(walk: DayWalk, position: Position, clock: number | null, longLeg: boolean, record: DayStepRecorder | null): number {
  const terminal = walk.frame.terminal;
  if (!terminal) {
    record?.rows.push({ kind: "end", terminal: "none", minute: clock, toId: null, departureMinute: null, arriveByMinute: null });
    return 0;
  }
  const anchorEnd = terminal.kind === "anchor";
  const to = anchorEnd ? pointOf(terminal.anchor.start, true) : pointOf(terminal.point, false);
  const departureMinute = anchorEnd && terminal.anchor.itemType === "flight" ? terminal.anchor.startMinute : null;
  const arriveByMinute = anchorEnd && departureMinute !== null ? terminal.arriveByMinute : null;
  const leg = measure(walk, position, to);
  if (longLeg) {
    // A long day names its end without a time and says nothing more about the tail.
    record?.rows.push({ kind: "leg", fromId: position.id, toId: to.id, minutes: null, straightLine: leg.straightLine, metres: leg.metres, long: false });
    record?.rows.push({ kind: "end", terminal: anchorEnd ? "anchor" : "lodging", minute: null, toId: to.id, departureMinute, arriveByMinute });
    // Same tail rule as a timed day: an uncertain tail is not compared.
    if (!isLong(leg)) addMove(record, leg);
    return 0;
  }
  if (isLong(leg)) {
    record?.rows.push({ kind: "tail_unknown", fromId: position.id, toId: to.id, departureMinute, arriveByMinute });
    return 0;
  }
  pushLeg(record, position, to, leg, leg.minutes, false);
  record?.rows.push({ kind: "end", terminal: anchorEnd ? "anchor" : "lodging", minute: clock === null || leg.minutes === null ? null : clock + leg.minutes,
    toId: to.id, departureMinute, arriveByMinute });
  return leg.minutes ?? 0;
}

export type DayFinishOutcome =
  | { kind: "ok"; state: DayStepState }
  /** A fixed item still due could not be reached in time terms; the rest was recorded untimed. */
  | { kind: "untimed"; long: boolean };

/**
 * After the last stop (p9 §2.3 收尾): checkpoint (d), the remaining fixed items (rule (5)), the dinner
 * gap and the tail. The returned state's travel is the order's `moveMinutes`.
 */
export function finishDay(walk: DayWalk, input: DayStepState, record: DayStepRecorder | null): DayFinishOutcome {
  const state: DayStepState = { ...input, shadow: null };
  for (;;) {
    const anchor = walk.anchors[state.anchorIndex];
    // (d): a lunch still open follows the last stop, or the fixed item it cannot precede (f5 :117-118).
    if (state.lunch === "open" || (state.lunch === "gap" && state.lunchDeferred)) {
      if (gapFits(walk, state, anchor)) insertLunchGap(walk, state, null, record);
      else {
        state.lunch = "gap";
        state.lunchDeferred = true;
      }
    }
    dinnerGap(walk, state, record);
    if (!anchor) break;
    const visited = visitAnchor(walk, state, anchor, record);
    if (visited !== "ok") {
      return { kind: "untimed", long: untimedRest(walk, state.position, state.anchorIndex, record, visited === "long") };
    }
  }
  // f5 :172: on a flight day the last stop or lunch gap must end inside the window.
  if (walk.frame.terminal?.kind === "anchor" && state.lastEnd > walk.frame.windowEndMinute) state.missed += 1;
  state.travel += terminalRows(walk, state.position, state.clock, false, record);
  return { kind: "ok", state };
}

/**
 * The fixed items still due (from anchorIndex on) and the tail, without times. A leg to a fixed item
 * can still be the day's long leg; past it no leg shows minutes (f5 §1.4). Returns whether the day is long.
 */
function untimedRest(walk: DayWalk, from: Position, anchorIndex: number, record: DayStepRecorder | null, pastLong: boolean) {
  let position = from;
  let longLeg = pastLong;
  for (let index = anchorIndex; index < walk.anchors.length; index += 1) {
    const anchor = walk.anchors[index]!;
    const to = pointOf(anchor.start, true);
    const leg = measure(walk, position, to);
    const long = !longLeg && isLong(leg);
    if (long) longLeg = true;
    pushLeg(record, position, to, leg, longLeg ? null : leg.minutes, long);
    record?.rows.push({ kind: "anchor", anchorId: anchor.id, minute: null, meal: mealOfAnchor(anchor), lateMinutes: 0, earlyMinutes: 0 });
    position = pointOf(anchor.end, true);
  }
  terminalRows(walk, position, null, longLeg, record);
  return longLeg;
}

/**
 * A stop without a time. Past a long leg no minutes are shown; otherwise this leg may itself be the
 * day's one 「這段很遠」 sentence (f5 §1.4), which is returned.
 */
function untimedStop(walk: DayWalk, position: Position | null, stop: DayTimelineStop, record: DayStepRecorder | null, pastLong: boolean) {
  const target = stopPosition(stop);
  let long = false;
  if (position) {
    const leg = measure(walk, position, target);
    long = !pastLong && isLong(leg);
    pushLeg(record, position, target, leg, pastLong || long ? null : leg.minutes, long);
  }
  record?.rows.push({ kind: "stop", stopId: stop.id, minute: null, stayMinutes: stayOf(stop), mealFloor: false, earlyMinutes: 0, label: null });
  return long;
}

interface WalkResult {
  record: DayStepRecorder;
  longLeg: boolean;
  /** The order was timed through to the end. */
  timed: boolean;
  state: DayStepState | null;
  /** The automatic lunch was still undecided where timing ended: f5's second simulation is due. */
  lunchOpen: boolean;
  lunchByPlace: boolean;
}

/** Walks the whole order in one mode, recording rows; never splits. */
function walkOrder(walk: DayWalk, stops: readonly DayTimelineStop[], mode: "store" | "gap"): WalkResult {
  const record: DayStepRecorder = { rows: [], plans: new Map(), moveMinutes: 0, lunchGap: null, arrivals: new Map(), autoLunchId: null };
  if (walk.frame.origin?.kind === "anchor") {
    const anchor = walk.frame.origin.anchor;
    record.rows.push({ kind: "anchor", anchorId: anchor.id, minute: walk.frame.unresolved ? null : anchor.startMinute, meal: mealOfAnchor(anchor), lateMinutes: 0, earlyMinutes: 0 });
  } else {
    record.rows.push({ kind: "start", minute: walk.frame.unresolved || !walk.frame.origin ? null : walk.frame.windowStartMinute, pointId: walk.frame.origin?.point.id ?? null });
  }
  let state = initialDayStep(walk);
  let lunchOpen = state?.lunch === "open";
  let lunchByPlace = walk.lunchByPlace;
  let position: Position | null = walk.origin;
  let anchorIndex = 0;
  let longLeg = false;
  let lastIndex = -1;
  for (let index = 0; index < stops.length; index += 1) if (isLocatedStop(stops[index]!)) lastIndex = index;
  for (let index = 0; index < stops.length; index += 1) {
    const stop = stops[index]!;
    if (state) {
      const outcome = simulateStep(walk, state, stop, {
        last: index === lastIndex, forcedLunch: index === lastIndex && stop.id === walk.roles.dinnerStopId, mode, record,
      });
      if (outcome.kind === "untimed") {
        longLeg = outcome.long;
        position = outcome.position;
        anchorIndex = outcome.anchorIndex;
        state = null;
      } else if (outcome.kind === "ok") {
        state = outcome.state;
        lunchOpen = state.lunch === "open";
        lunchByPlace = state.lunchByPlace;
      }
    } else {
      if (untimedStop(walk, position, stop, record, longLeg)) longLeg = true;
      position = stopPosition(stop);
    }
  }
  if (state) {
    const finished = finishDay(walk, state, record);
    if (finished.kind === "ok") return { record, longLeg: false, timed: true, state: finished.state, lunchOpen, lunchByPlace };
    return { record, longLeg: finished.long, timed: false, state: null, lunchOpen, lunchByPlace };
  }
  longLeg = untimedRest(walk, position!, anchorIndex, record, longLeg);
  return { record, longLeg, timed: false, state: null, lunchOpen, lunchByPlace };
}

function labelRows(walk: DayWalk, stops: readonly DayTimelineStop[], result: WalkResult) {
  const { rows, plans } = result.record;
  const timed = walk.meals && !result.longLeg;
  const lunchByPlace = result.lunchByPlace;
  const stopsById = new Map(stops.map((stop) => [stop.id, stop]));
  let firstStop = -1;
  rows.forEach((row, index) => {
    if (row.kind !== "stop") return;
    if (firstStop < 0) firstStop = index;
    const stop = stopsById.get(row.stopId)!;
    if (!timed || row.minute === null) {
      // Untimed (long day, unknown leg; f5 §1.4, 1b): a marked stop still names its meal, without a time or a wait.
      if (stop.mealRole !== null && stop.mealRole !== "none") {
        row.label = { kind: "meal", meal: stop.mealRole, marked: true, tooEarly: false, lateMinutes: 0 };
      }
      return;
    }
    const plan = plans.get(index);
    if (plan?.kind === "meal") {
      const latest = plan.meal === "breakfast" ? BREAKFAST_LATEST_MINUTE : plan.meal === "lunch" ? LUNCH_LATEST_MINUTE : DINNER_LATEST_MINUTE;
      row.label = { kind: "meal", meal: plan.meal, marked: plan.marked, tooEarly: plan.tooEarly,
        lateMinutes: plan.tooEarly ? 0 : Math.max(0, row.minute - latest) };
    } else if (plan?.kind === "breakfast_candidate" && walk.breakfastOpen) {
      row.label = { kind: "breakfast_candidate" };
    } else if (plan?.kind !== "unscheduled" && stop.type === "restaurant" && stop.mealRole === null) {
      // Rule 5; a stop marked "none" or a second marked dinner gets no label (rule 1, p9 §5).
      row.label = { kind: lunchByPlace ? "lunch_exists" : "off_meal_time" };
    }
  });
  const first = rows[firstStop];
  if (walk.breakfastOpen && timed && first?.kind === "stop" && first.minute !== null && first.label?.kind !== "breakfast_candidate") {
    rows.unshift({ kind: "breakfast_before" });
  }
}

/** f5's two simulations: a gap only when the first walk leaves the automatic lunch undecided (rule 6). */
function walkWithMeals(walk: DayWalk, stops: readonly DayTimelineStop[]): WalkResult {
  const first = walkOrder(walk, stops, "store");
  const needsGap = walk.lunchMode === "auto" && !first.longLeg && first.lunchOpen;
  return needsGap ? walkOrder(walk, stops, "gap") : first;
}

/**
 * The day's timeline for these stops in this order (f5 §1, p9 §2). Null for a day without stops: no
 * timeline is drawn. `roles` come from `resolveDayMeals` on the base order (the saved order); omitted,
 * this order is its own base. Deterministic: no clock, no randomness.
 */
export function simulateDay(
  frame: DayTimelineFrame,
  stops: readonly DayTimelineStop[],
  transit?: DayTimelineTransit | null,
  roles: DayMealRoles = resolveDayMeals(frame, stops, stops, transit),
): DayTimeline | null {
  if (stops.length === 0) return null;
  if (frame.windowEndMinute <= frame.windowStartMinute) return { kind: "no_window" };
  const plainWalk = createDayWalk(frame, stops, transit, roles, false);
  const plain = walkOrder(plainWalk, stops, "store");
  const walk = plain.longLeg ? plainWalk : createDayWalk(frame, stops, transit, roles, true);
  const chosen = plain.longLeg ? plain : walkWithMeals(walk, stops);
  labelRows(walk, stops, chosen);
  const state = walk.meals && chosen.timed ? chosen.state : null;
  return {
    kind: "rows", rows: chosen.record.rows, longLeg: chosen.longLeg, moveMinutes: chosen.record.moveMinutes,
    score: state ? { missedFixed: state.missed, mealOffBands: state.level } : null,
    lunchGap: chosen.record.lunchGap,
  };
}

/** The base order's walk as f5 1a draws it: arrivals before seat waits and the automatic lunch; null on a long day. */
function baseWalk(frame: DayTimelineFrame, base: readonly DayTimelineStop[], transit: DayTimelineTransit | null | undefined) {
  const plain = walkOrder(createDayWalk(frame, base, transit, NO_DAY_MEAL_ROLES, false), base, "store");
  if (plain.longLeg) return null;
  return walkWithMeals(createDayWalk(frame, base, transit, NO_DAY_MEAL_ROLES, true), base).record;
}

function pickByRank<S extends DayTimelineStop>(stops: readonly S[], ranks: ReadonlyMap<string, number>, unranked: number, wantLast: boolean): S | null {
  let best: S | null = null;
  let bestRank = 0;
  for (const stop of stops) {
    const rank = ranks.get(stop.id) ?? unranked;
    if (!best || (wantLast ? rank > bestRank : rank < bestRank) || (rank === bestRank && stop.id < best.id)) {
      best = stop;
      bestRank = rank;
    }
  }
  return best;
}

/**
 * δ, λ and β for one day (p9 §2.2.2–§2.2.4), decided before any order is searched. `base` is the base
 * order (p9 §2.1: the saved order; for a whole-trip day also the stops a draft moved away), `stops`
 * the stops the day has now, `ranks` the base ranks (default: the position in `base`; a whole-trip day
 * ranks only positioned stops, the rest share the rank after them). Both the saved and the suggested
 * column must receive the same result.
 */
export function resolveDayMeals(
  frame: DayTimelineFrame,
  base: readonly DayTimelineStop[],
  stops: readonly DayTimelineStop[],
  transit?: DayTimelineTransit | null,
  ranks?: ReadonlyMap<string, number>,
): DayMealRoles {
  if (frame.windowEndMinute <= frame.windowStartMinute) return NO_DAY_MEAL_ROLES;
  const baseLocated = base.filter(isLocatedStop);
  const dayLocated = stops.filter(isLocatedStop);
  if (dayLocated.length === 0) return NO_DAY_MEAL_ROLES;
  const walk = createDayWalk(frame, base, transit, NO_DAY_MEAL_ROLES, true);
  if (!walk.meals) return NO_DAY_MEAL_ROLES;
  const walked = baseWalk(frame, baseLocated, transit);
  const arrivals = walked?.arrivals ?? new Map<string, number>();
  const baseRanks = ranks ?? new Map(baseLocated.map((stop, index) => [stop.id, index]));
  const unranked = Math.max(-1, ...baseRanks.values()) + 1;
  const dayIds = new Set(dayLocated.map((stop) => stop.id));
  const baseLast = baseLocated.at(-1);
  const baseFirst = baseLocated[0];
  const stillHere = (stop: DayTimelineStop | undefined) => stop && dayIds.has(stop.id) ? stop : null;
  const unmarkedRestaurant = (stop: DayTimelineStop) => stop.type === "restaurant" && stop.mealRole === null;
  const markedLunch = stops.some((stop) => stop.mealRole === "lunch");

  let dinnerStopId: string | null = null;
  if (walk.dinnerNeeded) {
    const marked = pickByRank(dayLocated.filter((stop) => stop.mealRole === "dinner"), baseRanks, unranked, true);
    const last = stillHere(baseLast);
    const arrival = last ? arrivals.get(last.id) : undefined;
    if (marked) dinnerStopId = marked.id;
    else if (last && unmarkedRestaurant(last) && !walk.fixedMeals.has("dinner") && arrival !== undefined
      && arrival >= DINNER_BAND_START_MINUTE && arrival <= DINNER_LATEST_MINUTE) dinnerStopId = last.id;
  }

  let lastRestaurantId: string | null = null;
  let lastRestaurantLunch = false;
  const last = stillHere(baseLast);
  if (dinnerStopId === null && last && unmarkedRestaurant(last)) {
    lastRestaurantId = last.id;
    const arrival = arrivals.get(last.id);
    // λ is lunch only when the base order itself has it as the automatic lunch (as f5 1a draws it); an earlier restaurant keeps it.
    lastRestaurantLunch = arrival !== undefined && arrival >= BREAKFAST_LATEST_MINUTE && arrival <= LUNCH_BAND_END_MINUTE
      && walk.lunchNeeded && !walk.fixedMeals.has("lunch") && !markedLunch
      && (walked?.autoLunchId === null || walked?.autoLunchId === last.id);
  }

  let breakfastStopId: string | null = null;
  const markedBreakfast = pickByRank(dayLocated.filter((stop) => stop.mealRole === "breakfast"), baseRanks, unranked, false);
  const first = stillHere(baseFirst);
  if (markedBreakfast) breakfastStopId = markedBreakfast.id;
  else if (first && first.mealRole === null && (first.type === "cafe" || first.type === "restaurant")
    && !walk.fixedMeals.has("breakfast") && !stops.some((stop) => stop.mealRole === "breakfast")
    && frame.origin?.kind === "lodging" && frame.windowStartMinute <= BREAKFAST_LATEST_MINUTE) {
    const arrival = arrivals.get(first.id);
    if (arrival !== undefined && arrival < BREAKFAST_LATEST_MINUTE) {
      // p9 §2.2.3: the only restaurant that could be the automatic lunch is not held at breakfast.
      const autoLunch = walk.lunchNeeded && !walk.fixedMeals.has("lunch") && !markedLunch && !lastRestaurantLunch;
      const candidates = dayLocated.filter((stop) => unmarkedRestaurant(stop) && stop.id !== dinnerStopId && stop.id !== lastRestaurantId);
      if (!(autoLunch && first.type === "restaurant" && candidates.length === 1 && candidates[0]!.id === first.id)) breakfastStopId = first.id;
    }
  }
  return { dinnerStopId, lastRestaurantId, lastRestaurantLunch, breakfastStopId };
}

/**
 * p9 §2.2.5 e(v): the earliest clock at which reaching this stop stops costing points; −∞ when every
 * cost only grows with lateness. The order search's dominance rule needs the maximum over unvisited stops.
 */
export function stopBandStart(walk: DayWalk, stop: DayTimelineStop): number {
  if (!walk.meals) return NO_TIME;
  if (stop.mealRole === "lunch" || (stop.id === walk.roles.lastRestaurantId && walk.roles.lastRestaurantLunch)) {
    return walk.lunchNeeded ? BREAKFAST_LATEST_MINUTE : NO_TIME;
  }
  if (stop.mealRole === "dinner") return walk.dinnerNeeded && stop.id !== walk.roles.dinnerStopId ? DINNER_BAND_START_MINUTE : NO_TIME;
  if (stop.mealRole === null && stop.type === "restaurant" && walk.lunchMode === "auto"
    && stop.id !== walk.roles.dinnerStopId && stop.id !== walk.roles.lastRestaurantId && stop.id !== walk.roles.breakfastStopId) {
    return BREAKFAST_LATEST_MINUTE;
  }
  return NO_TIME;
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
  if (row.kind === "meal") {
    // Drafts written by P1 (f5 1a) carry neither flag: an automatic, in-band meal.
    return { kind: "meal", meal: oneOf(row.meal, MEALS), marked: row.marked === undefined ? false : bool(row.marked),
      tooEarly: row.tooEarly === undefined ? false : bool(row.tooEarly), lateMinutes: finite(row.lateMinutes) };
  }
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
  // Drafts written before P2 carry neither score nor lunchGap.
  const score = row.score == null ? null : record(row.score);
  const lunchGap = row.lunchGap == null ? null : record(row.lunchGap);
  return {
    kind: "rows", rows: row.rows.map(timelineRow), longLeg: bool(row.longLeg), moveMinutes: nullableFinite(row.moveMinutes),
    score: score === null ? null : { missedFixed: finite(score.missedFixed), mealOffBands: finite(score.mealOffBands) },
    lunchGap: lunchGap === null ? null : { beforeId: nullableText(lunchGap.beforeId), afterId: nullableText(lunchGap.afterId) },
  };
}
