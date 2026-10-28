import type { DayRouteOrderBasis, DayRouteOrderReason } from "@along-the-way/contracts/day-plans";
import {
  createDayWalk, finishDay, initialDayStep, isLocatedStop, LUNCH_BAND_END_MINUTE, resolveDayMeals, simulateDay, simulateStep,
  splitLunch, stopBandStart,
  type DayMealRoles, type DayStepState, type DayTimelineFrame, type DayTimelineStop, type DayTimelineTransit, type DayWalk,
} from "@along-the-way/contracts/day-timeline";

import { comparePlannerIds } from "./day-load";
import type { GeoPoint } from "./day-route-order";

/**
 * One day's suggested order (p9 §2): meals first, then distance. Both entrances (the day dialog and
 * whole-trip drafts) call `planDayOrder`; the timing and meal rules live in the contracts' `simulateStep`,
 * this file only searches. Deterministic: budgets are counted in steps, buckets are expanded in a fixed order.
 */

/** Exact search only up to this many orderable stops (p9 §2.6). */
export const DAY_ORDER_EXACT_MAX_NODES = 9;
/** `simulateStep` calls one day may spend before the exact search is abandoned (p9 §2.6). */
export const DAY_ORDER_STEP_BUDGET = 20_000;
/** Labels one bucket (state) may hold before the exact search is abandoned (p9 §2.7). */
export const DAY_ORDER_BUCKET_LIMIT = 32;
/** Q2 (B): within the best meal level, travel this close to the minimum ties; fewer swaps then win. */
export const DAY_ORDER_TIE_MINUTES = 10;
/** Search results tried against `accept` before the day falls back (p9 §2.5). */
export const DAY_ORDER_ACCEPT_TRIES = 32;

export type LocatedStop = DayTimelineStop & GeoPoint;

export interface DayOrderInput {
  frame: DayTimelineFrame;
  /** Every stop of the day in its current order (saved, or the solver's). Stops without coordinates are not ordered. */
  stops: readonly DayTimelineStop[];
  /** Known transit minutes between lodging and stops; null for straight-line days. */
  transit: DayTimelineTransit | null;
  /** The base order (p9 §2.1): the saved order's stops; a whole-trip day also lists stops the draft moved away. */
  base: readonly DayTimelineStop[];
  /** Base rank per stop id (p9 §2.1); unranked stops share the rank after the last. */
  ranks: ReadonlyMap<string, number>;
  /** The existing distance ordering's ends (the morning and night lodging, or the middle segment's ends). */
  start: GeoPoint | null;
  end: GeoPoint | null;
  /** The existing distance ordering, for the segmented fallback's segments (p9 §2.6 step 2). */
  distanceOrder: (stops: GeoPoint[], start: GeoPoint | null, end: GeoPoint | null) => string[];
  /** A candidate order must pass this to be chosen (the whole trip: its load is valid); omitted, every order passes. */
  accept?: (orderedIds: readonly string[]) => boolean;
}

export interface DayOrderScore {
  missedFixed: number;
  mealOffBands: number;
  travelMinutes: number;
  /** Pairs swapped against the base ranks. */
  inversions: number;
}

export interface DayOrderResult {
  /** Null: nothing to order (no window, no located stop); the caller says nothing about the basis. */
  orderBasis: DayRouteOrderBasis | null;
  orderReason: DayRouteOrderReason | null;
  /** The chosen order of the located stops; null with `distance`: the caller's existing ordering applies. */
  orderedIds: string[] | null;
  /** δ, λ, β of this day, for drawing the chosen order with the same rules. */
  roles: DayMealRoles;
  score: DayOrderScore | null;
}

interface Scored {
  missed: number;
  level: number;
  travel: number;
  inv: number;
  ids: string[];
}

interface Label {
  state: DayStepState;
  mask: number;
  /** Node index of the current stop; −1 at the origin. */
  last: number;
  inv: number;
  parent: Label | null;
}

interface Bucket {
  key: number[];
  labels: Label[];
}

/** Lexicographic ids: the final tie-break everywhere (p9 §2.4 condition 3, §2.5). */
function compareIds(left: readonly string[], right: readonly string[]) {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const order = comparePlannerIds(left[index]!, right[index]!);
    if (order !== 0) return order;
  }
  return left.length - right.length;
}

function inversionsOf(ids: readonly string[], ranks: ReadonlyMap<string, number>, unranked: number) {
  let count = 0;
  for (let later = 1; later < ids.length; later += 1) {
    const rank = ranks.get(ids[later]!) ?? unranked;
    for (let earlier = 0; earlier < later; earlier += 1) if ((ranks.get(ids[earlier]!) ?? unranked) > rank) count += 1;
  }
  return count;
}

/**
 * Q2 (B) (p9 §2.4, owner 2026-10-25): missed, then meal level; travel within 10 minutes of the best
 * ties; then fewer swaps, then travel, then ids. Null without candidates.
 */
function pickBest(candidates: readonly Scored[]): Scored | null {
  if (candidates.length === 0) return null;
  const best = candidates.reduce((best, candidate) =>
    candidate.missed < best.missed || (candidate.missed === best.missed && candidate.level < best.level) ? candidate : best);
  const group = candidates.filter((candidate) => candidate.missed === best.missed && candidate.level === best.level);
  const least = Math.min(...group.map((candidate) => candidate.travel));
  return group.filter((candidate) => candidate.travel <= least + DAY_ORDER_TIE_MINUTES)
    .sort((left, right) => left.inv - right.inv || left.travel - right.travel || compareIds(left.ids, right.ids))[0]!;
}

function orderOf(label: Label, nodes: readonly LocatedStop[]) {
  const ids: string[] = [];
  for (let current: Label | null = label; current && current.last >= 0; current = current.parent) ids.push(nodes[current.last]!.id);
  return ids.reverse();
}

class ExactSearch {
  private steps = 0;
  private readonly unranked: number;
  private readonly bandStarts: number[];
  /** ω's own band start: λ as lunch still scores before 10:30, so it counts in T* until the end (p9 §2.2.5). */
  private readonly omegaBand: number;
  private readonly nodeRanks: number[];

  constructor(
    private readonly walk: DayWalk,
    private readonly nodes: readonly LocatedStop[],
    private readonly omega: LocatedStop | null,
    private readonly ranks: ReadonlyMap<string, number>,
  ) {
    this.unranked = Math.max(-1, ...ranks.values()) + 1;
    this.bandStarts = nodes.map((stop) => stopBandStart(walk, stop));
    this.omegaBand = omega ? stopBandStart(walk, omega) : Number.NEGATIVE_INFINITY;
    this.nodeRanks = nodes.map((stop) => ranks.get(stop.id) ?? this.unranked);
  }

  /** Completed: every order was examined; null when the budget or a bucket limit was exceeded (p9 §2.6). */
  run(): Scored[] | null {
    const initial = initialDayStep(this.walk);
    if (!initial) return null;
    const count = this.nodes.length;
    const everyNullRestaurant = this.omega === null && this.nodes.every((stop) => stop.type === "restaurant" && stop.mealRole === null);
    let layer: Bucket[] = [{ key: [0, -1], labels: [{ state: initial, mask: 0, last: -1, inv: 0, parent: null }] }];
    for (let size = 0; size < count; size += 1) {
      const next = new Map<string, Bucket>();
      for (const bucket of layer) {
        for (let node = 0; node < count; node += 1) {
          if (bucket.key[0]! & (1 << node)) continue;
          const stop = this.nodes[node]!;
          // p9 §2.2.4: without ω the last stop cannot be an unmarked restaurant.
          if (size + 1 === count && this.omega === null && !everyNullRestaurant && stop.type === "restaurant" && stop.mealRole === null) continue;
          for (const label of bucket.labels) {
            for (const extended of this.expand(label, stop, node)) {
              if (this.steps > DAY_ORDER_STEP_BUDGET || !this.insert(next, extended)) return null;
            }
          }
        }
      }
      // p9 §2.7: expansion order is fixed by the bucket key, never by Map insertion order.
      layer = [...next.values()].sort((left, right) => {
        for (let index = 0; index < left.key.length; index += 1) {
          const order = left.key[index]! - right.key[index]!;
          if (order !== 0) return order;
        }
        return 0;
      });
    }
    const finals: Scored[] = [];
    for (const bucket of layer) {
      for (const label of bucket.labels) {
        const final = this.finish(label);
        if (this.steps > DAY_ORDER_STEP_BUDGET) return null;
        if (final) finals.push(final);
      }
    }
    return finals;
  }

  private expand(label: Label, stop: LocatedStop, node: number): Label[] {
    const state = label.state;
    const inv = label.inv + this.nodeRanks.reduce((count, rank, other) =>
      count + (label.mask & (1 << other) && rank > this.nodeRanks[node]! ? 1 : 0), 0);
    const extend = (next: DayStepState): Label => ({ state: next, mask: label.mask | (1 << node), last: node, inv, parent: label });
    // The gap branch's twin walks the same step without a gap; a restaurant it finds in the lunch band proves this branch wrong.
    let shadow: DayStepState | null = null;
    if (state.lunch === "gap" && state.shadow) {
      this.steps += 1;
      const walked = simulateStep(this.walk, state.shadow, stop, { last: false, forcedLunch: false, mode: "store", record: null });
      if (walked.kind === "ok") {
        if (walked.state.lunch === "settled") return [];
        shadow = walked.state.clock > LUNCH_BAND_END_MINUTE ? null : walked.state;
      }
    }
    this.steps += 1;
    const outcome = simulateStep(this.walk, { ...state, shadow: null }, stop, { last: false, forcedLunch: false, mode: "branch", record: null });
    if (outcome.kind === "untimed") return [];
    if (outcome.kind === "split") {
      const twins = splitLunch(this.walk, outcome.state, outcome.deferred, stop.id);
      this.steps += 2;
      const store = simulateStep(this.walk, twins.store, stop, { last: false, forcedLunch: false, mode: "store", record: null });
      const gap = simulateStep(this.walk, twins.gap, stop, { last: false, forcedLunch: false, mode: "branch", record: null });
      const found = store.kind === "ok" && store.state.lunch === "settled";
      const labels: Label[] = [];
      // 等店 lives while a restaurant can still arrive inside the band; 空格 dies once the twin found one.
      if (store.kind === "ok" && (found || store.state.clock <= LUNCH_BAND_END_MINUTE)) labels.push(extend(store.state));
      if (gap.kind === "ok" && !found) {
        labels.push(extend({ ...gap.state, shadow: store.kind === "ok" && store.state.clock <= LUNCH_BAND_END_MINUTE ? store.state : null }));
      }
      return labels;
    }
    const next = { ...outcome.state, shadow };
    if (next.lunch === "store" && next.clock > LUNCH_BAND_END_MINUTE) return [];
    return [extend(next)];
  }

  private bucketKey(label: Label): number[] {
    const { state } = label;
    const lunch = state.lunch === "settled" ? 0 : state.lunch === "open" ? 1 : state.lunch === "store" ? 2 : 3;
    return [label.mask, label.last, state.anchorIndex, lunch, state.lunchDeferred ? 1 : 0, state.shadow ? state.shadow.anchorIndex : -1];
  }

  /** p9 §2.2.5: T*(S), the latest band start among the stops still to come (unvisited nodes and ω). */
  private bandLimit(mask: number) {
    let limit = this.omegaBand;
    for (let node = 0; node < this.nodes.length; node += 1) if (!(mask & (1 << node))) limit = Math.max(limit, this.bandStarts[node]!);
    return limit;
  }

  /** p9 §2.4: whether `left` makes `right` unnecessary in the same bucket. */
  private dominates(left: Label, right: Label) {
    const a = left.state;
    const b = right.state;
    if (a.missed > b.missed || a.level > b.level || a.travel > b.travel || left.inv > right.inv) return false;
    const sameClock = a.clock === b.clock && (a.shadow?.clock ?? null) === (b.shadow?.clock ?? null);
    const decided = a.lunch === "settled" || (a.lunch === "gap" && !a.lunchDeferred && a.shadow === null);
    const monotone = decided && a.anchorIndex === this.walk.anchors.length && a.clock >= this.bandLimit(left.mask) && a.clock <= b.clock;
    if (!sameClock && !monotone) return false;
    if (a.missed < b.missed || a.level < b.level || a.travel < b.travel || left.inv < right.inv) return true;
    return compareIds(orderOf(left, this.nodes), orderOf(right, this.nodes)) <= 0;
  }

  /** False when the bucket would exceed its limit (p9 §2.6: the exact search is then abandoned). */
  private insert(layer: Map<string, Bucket>, label: Label) {
    const key = this.bucketKey(label);
    const id = key.join(",");
    let bucket = layer.get(id);
    if (!bucket) {
      bucket = { key, labels: [] };
      layer.set(id, bucket);
    }
    if (bucket.labels.some((existing) => this.dominates(existing, label))) return true;
    bucket.labels = bucket.labels.filter((existing) => !this.dominates(label, existing));
    bucket.labels.push(label);
    return bucket.labels.length <= DAY_ORDER_BUCKET_LIMIT;
  }

  /** p9 §2.3 收尾: ω, then the rest of the day; null for a label whose order cannot end validly. */
  private finish(label: Label): Scored | null {
    let state: DayStepState = { ...label.state, shadow: null };
    // 等店 never found its restaurant: that order is really drawn with a gap, by the 空格 twin.
    if (state.lunch === "store") return null;
    const ids = orderOf(label, this.nodes);
    let inv = label.inv;
    if (this.omega) {
      this.steps += 1;
      const walked = simulateStep(this.walk, state, this.omega, {
        last: true, forcedLunch: this.omega.id === this.walk.roles.dinnerStopId, mode: "gap", record: null,
      });
      if (walked.kind !== "ok") return null;
      state = walked.state;
      const rank = this.ranks.get(this.omega.id) ?? this.unranked;
      inv += this.nodeRanks.reduce((count, other, node) => count + (label.mask & (1 << node) && other > rank ? 1 : 0), 0);
      ids.push(this.omega.id);
    }
    this.steps += 1;
    const finished = finishDay(this.walk, state, null);
    if (finished.kind !== "ok") return null;
    return { missed: finished.state.missed, level: finished.state.level, travel: finished.state.travel, inv, ids };
  }
}

/**
 * p9 §2.6: β first, ω last, the middle by the existing distance ordering; then one more order per lunch
 * candidate, placed where the no-lunch walk would draw the gap.
 */
function segmentedOrders(input: DayOrderInput, walk: DayWalk, nodes: readonly LocatedStop[], omega: LocatedStop | null, roles: DayMealRoles) {
  const byId = new Map<string, LocatedStop>([...nodes, ...(omega ? [omega] : [])].map((stop) => [stop.id, stop]));
  const beta = nodes.find((stop) => stop.id === roles.breakfastStopId) ?? null;
  const middle = nodes.filter((stop) => stop !== beta);
  const unmarkedRestaurant = (id: string) => byId.get(id)!.type === "restaurant" && byId.get(id)!.mealRole === null;
  const everyNullRestaurant = [...byId.keys()].every(unmarkedRestaurant);
  /** p9 §2.2.4: without ω the last stop must not be an unmarked restaurant; the last stop that is not moves to the end. */
  const fixLast = (ids: string[]) => {
    if (omega || everyNullRestaurant || ids.length === 0 || !unmarkedRestaurant(ids.at(-1)!)) return ids;
    const index = ids.findLastIndex((id) => !unmarkedRestaurant(id));
    return index < 0 ? ids : [...ids.slice(0, index), ...ids.slice(index + 1), ids[index]!];
  };
  /** p9 §2.6 step 5: an order that still breaks §2.2.4 is dropped. */
  const endsValidly = (ids: string[]) => ids.length > 0
    && (omega ? ids.at(-1) === omega.id : everyNullRestaurant || !unmarkedRestaurant(ids.at(-1)!));
  const order0 = input.distanceOrder(middle, beta ?? input.start, omega ?? input.end);
  const orders = [fixLast([...(beta ? [beta.id] : []), ...order0, ...(omega ? [omega.id] : [])])];
  const candidates = walk.lunchMode === "marked" ? middle.filter((stop) => stop.mealRole === "lunch")
    : walk.lunchMode === "auto" ? middle.filter((stop) => stop.type === "restaurant" && stop.mealRole === null) : [];
  for (const candidate of candidates) {
    const rest = [...(beta ? [beta.id] : []), ...order0.filter((id) => id !== candidate.id), ...(omega ? [omega.id] : [])];
    const timeline = simulateDay(input.frame, rest.map((id) => byId.get(id)!), input.transit, roles);
    const gap = timeline?.kind === "rows" ? timeline.lunchGap : null;
    // Where the gap would be drawn, but never after ω and never last: at most just before the last stop (p9 §2.6 step 4).
    const wanted = gap ? (gap.beforeId === null ? (beta ? 1 : 0) : rest.indexOf(gap.beforeId) + 1) : rest.length - 1;
    const at = Math.max(beta ? 1 : 0, Math.min(wanted, Math.max(0, rest.length - 1)));
    orders.push(fixLast([...rest.slice(0, at), candidate.id, ...rest.slice(at)]));
  }
  const seen = new Set<string>();
  return orders.filter((ids) => {
    const key = ids.join("\n");
    if (seen.has(key) || !endsValidly(ids)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The suggested order for one day (p9 §2.8). The exact search runs for up to 9 orderable stops within
 * the step budget; otherwise the segmented fallback. The result is always the best, by Q2 (B), of the
 * accepted candidates scored with `simulateDay`, and the current order is always one of them (p9 §2.5).
 */
export function planDayOrder(input: DayOrderInput): DayOrderResult {
  const { frame } = input;
  const originPoint = frame.origin?.kind === "anchor" ? frame.origin.anchor.end : frame.origin?.point;
  const located = input.stops.filter(isLocatedStop);
  const roles = resolveDayMeals(frame, input.base, input.stops, input.transit, input.ranks);
  const distance = (orderReason: DayRouteOrderReason): DayOrderResult => ({ orderBasis: "distance", orderReason, orderedIds: null, roles, score: null });
  // Nothing to order: no window, or no located stop. The caller says nothing about a basis.
  if (frame.windowEndMinute <= frame.windowStartMinute || located.length === 0) {
    return { orderBasis: null, orderReason: null, orderedIds: null, roles, score: null };
  }
  // p9 §2.6 no_frame: no known start, an unresolved fixed item; a start without coordinates cannot be timed either.
  if (frame.unresolved || !originPoint || originPoint.latitude === null || originPoint.longitude === null) return distance("no_frame");
  const walk = createDayWalk(frame, input.stops, input.transit, roles);
  if (!walk.meals) return distance("no_frame");
  const omegaId = walk.roles.dinnerStopId ?? walk.roles.lastRestaurantId;
  const omega = located.find((stop) => stop.id === omegaId) ?? null;
  const nodes = located.filter((stop) => stop.id !== omegaId).sort((left, right) => comparePlannerIds(left.id, right.id));
  const stopsById = new Map(located.map((stop) => [stop.id, stop]));
  const unranked = Math.max(-1, ...input.ranks.values()) + 1;
  // p9 §2.5: a candidate counts only as `simulateDay` scores it, without a long leg, and accepted.
  const evaluate = (ids: readonly string[]): Scored | null => {
    const timeline = simulateDay(frame, ids.map((id) => stopsById.get(id)!), input.transit, roles);
    if (timeline?.kind !== "rows" || timeline.longLeg || timeline.score === null || timeline.moveMinutes === null) return null;
    if (input.accept && !input.accept(ids)) return null;
    return { missed: timeline.score.missedFixed, level: timeline.score.mealOffBands, travel: timeline.moveMinutes,
      inv: inversionsOf(ids, input.ranks, unranked), ids: [...ids] };
  };

  const candidates: Scored[] = [];
  let exact = false;
  if (nodes.length <= DAY_ORDER_EXACT_MAX_NODES) {
    const finals = new ExactSearch(walk, nodes, omega, input.ranks).run();
    if (finals) {
      exact = true;
      // p9 §2.5: in the search's own ranking, the accepted orders among the first tries are the search's
      // candidates, re-scored by `simulateDay`; without `accept` only its best is needed.
      const remaining = [...finals];
      const tries = input.accept ? DAY_ORDER_ACCEPT_TRIES : 1;
      for (let tried = 0; tried < tries && remaining.length > 0; tried += 1) {
        const next = pickBest(remaining)!;
        remaining.splice(remaining.indexOf(next), 1);
        const scored = evaluate(next.ids);
        if (scored) candidates.push(scored);
      }
    }
  }
  if (candidates.length === 0) {
    for (const ids of segmentedOrders(input, walk, nodes, omega, roles)) {
      const scored = evaluate(ids);
      if (scored) candidates.push(scored);
    }
  }
  const current = evaluate(located.map((stop) => stop.id));
  if (current) candidates.push(current);
  const best = pickBest(candidates);
  if (!best) return distance("long_leg");
  return {
    orderBasis: "meals", orderReason: exact ? "exact" : "many_places", orderedIds: best.ids, roles,
    score: { missedFixed: best.missed, mealOffBands: best.level, travelMinutes: best.travel, inversions: best.inv },
  };
}
