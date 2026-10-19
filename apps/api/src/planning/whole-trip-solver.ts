import {
  clockMinutes, comparePlannerIds, computePlanningWindow, createDayLoadEvaluator, createPlannerDistanceMatrix,
  formatClockMinutes, hasPlannerCoordinates, middleSegmentEndpoints, utilisationBand,
  type PlannerDayLoadEvaluator, type PlannerDistanceMatrix,
} from "./day-load";
import { orderByStraightLine, type GeoPoint } from "./day-route-order";
import {
  PLANNER_MAX_DAYS, PLANNER_MAX_FLEXIBLE_PLACES,
  type PlannerBlockingCheck, type PlannerConflict, type PlannerDayLoad, type PlannerDaySnapshot,
  type PlannerEffectiveCaps, type PlannerEndpoint, type PlannerInput, type PlannerPlace, type PlannerResult, type PlannerSuggestion,
} from "./planner-model";
import { validateWholeTripPlan } from "./whole-trip-validator";

export const CONSTRUCTION_ORDERS = ["constrained_first", "largest_first", "smallest_first", "votes_first"] as const;
export const FEASIBILITY_CANDIDATE_LIMIT = 60_000;
export const CONSTRUCTION_CANDIDATE_LIMIT = 60_000;
export const IMPROVEMENT_CANDIDATE_LIMIT = 20_000;
export const EJECTION_CHAIN_MAX_DEPTH = 2;
export const IMPROVEMENT_MAX_PASSES = 4;
export const MAX_PLANNER_SUGGESTIONS = 3;
export const SAME_TYPE_OBJECTIVE = "minimise";
export const CANONICAL_TUPLE_LAYOUT = "days in calendar order (date, then dayId), each followed by its assigned middle placeIds ascending; positions excluded";
export const SUGGESTION_TIE_BREAK = "largest relative increase, fields changed, dayId, placeId, canonical override fields";
export const SUGGESTION_CLOCK_STEP_MINUTES = 1;
export const SUGGESTION_CLOCK_LIMIT_MINUTES = 1440;
/** Fixed work budget for relaxation suggestions (positions + window starts examined), so a
 *  30-day / 150-place incomplete result cannot stall the request; suggestions are best-effort. */
export const SUGGESTION_CANDIDATE_LIMIT = 200_000;

interface Budget { remaining: number }
interface State { middle: PlannerPlace[][]; loads: PlannerDayLoad[] }
interface Context {
  input: PlannerInput;
  days: PlannerDaySnapshot[];
  evaluate: PlannerDayLoadEvaluator[];
  endpoints: { start: PlannerEndpoint | null; end: PlannerEndpoint | null }[];
  distance: PlannerDistanceMatrix;
  movable: Set<string>;
  flexible: Set<string>;
}
interface Insertion { dayIndex: number; position: number; middle: PlannerPlace[]; load: PlannerDayLoad; addedMetres: number }
interface PlaceOrder { place: PlannerPlace; feasibleDays: number; size: number }

function initialState(context: Context): State {
  const middle = context.days.map((day) => [
    ...day.pinned,
    ...context.input.flexiblePlaces.filter((place) => context.input.mode === "keep" && place.assignedDayId === day.id),
  ].sort((left, right) => (left.position ?? Number.MAX_SAFE_INTEGER) - (right.position ?? Number.MAX_SAFE_INTEGER)
    || comparePlannerIds(left.id, right.id)));
  let state: State = { middle, loads: middle.map((places, index) => context.evaluate[index]!(places)) };
  if (context.input.mode !== "keep") return state;
  // Keep mode may change order, so a kept day whose saved order breaks a route-dependent cap
  // is judged after the same deterministic reorder used at the end (spec #158 §5 preflight).
  for (let index = 0; index < context.days.length; index += 1) {
    if (state.loads[index]!.status !== "over_cap") continue;
    const reordered = reorderDay(context, index, state.middle[index]!);
    if (reordered) state = withDay(state, index, reordered.middle, reordered.load);
  }
  return state;
}

function withDay(state: State, dayIndex: number, middle: PlannerPlace[], load: PlannerDayLoad): State {
  const next = { middle: [...state.middle], loads: [...state.loads] };
  next.middle[dayIndex] = middle;
  next.loads[dayIndex] = load;
  return next;
}

function placedIds(context: Context, state: State) {
  const ids = new Set<string>();
  for (const middle of state.middle) for (const place of middle) if (context.flexible.has(place.id)) ids.add(place.id);
  return ids;
}

function objective(context: Context, state: State) {
  let placed = 0;
  let band = 0;
  let metres = 0;
  let targetDeviation = 0;
  let sameType = 0;
  const tuple: string[] = [];
  for (let index = 0; index < context.days.length; index += 1) {
    const day = context.days[index]!;
    const middle = state.middle[index]!;
    const load = state.loads[index]!;
    band = Math.max(band, utilisationBand(load));
    metres += load.straightMetres;
    targetDeviation += Math.abs(load.count - day.caps.targetPlacesPerDay);
    tuple.push(day.id, ...middle.map((place) => place.id).sort(comparePlannerIds), "");
    for (let position = 0; position < middle.length; position += 1) {
      const place = middle[position]!;
      if (!context.flexible.has(place.id)) continue;
      placed += 1;
      const next = middle[position + 1];
      if (next && context.flexible.has(next.id) && next.type === place.type) sameType += 1;
    }
  }
  return { scores: [-placed, band, metres, targetDeviation, sameType], tuple };
}

function compareStates(context: Context, left: State, right: State) {
  const a = objective(context, left);
  const b = objective(context, right);
  for (let index = 0; index < a.scores.length; index += 1) {
    const difference = a.scores[index]! - b.scores[index]!;
    if (difference !== 0) return difference;
  }
  for (let index = 0; index < Math.max(a.tuple.length, b.tuple.length); index += 1) {
    const difference = comparePlannerIds(a.tuple[index] ?? "", b.tuple[index] ?? "");
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Only three matrix lookups; neither Haversine nor a route reorder runs in insertion search. */
function insertionAddedMetres(context: Context, dayIndex: number, middle: readonly PlannerPlace[], place: PlannerPlace, position: number) {
  const endpoints = context.endpoints[dayIndex]!;
  const before = middle[position - 1] ?? endpoints.start;
  const after = middle[position] ?? endpoints.end;
  return (before ? context.distance(before, place)! : 0) + (after ? context.distance(place, after)! : 0)
    - (before && after ? context.distance(before, after)! : 0);
}

function compareInsertions(context: Context, left: Insertion, right: Insertion) {
  return left.addedMetres - right.addedMetres
    || utilisationBand(left.load) - utilisationBand(right.load)
    || comparePlannerIds(context.days[left.dayIndex]!.id, context.days[right.dayIndex]!.id)
    || left.position - right.position;
}

function bestInsertion(context: Context, state: State, place: PlannerPlace, budget: Budget, onlyDay?: number, forbiddenDay?: number) {
  let best: Insertion | null = null;
  for (let dayIndex = 0; dayIndex < context.days.length && budget.remaining > 0; dayIndex += 1) {
    if ((onlyDay !== undefined && dayIndex !== onlyDay) || dayIndex === forbiddenDay) continue;
    const day = context.days[dayIndex]!;
    const baseline = state.loads[dayIndex]!;
    if (baseline.count + 1 > day.caps.maxPlacesPerDay || baseline.effort + place.estimate.effortLevel > day.caps.maxEffortPerDay
      || baseline.windowMinutes <= 0) continue;
    const middle = state.middle[dayIndex]!;
    for (let position = 0; position <= middle.length && budget.remaining > 0; position += 1) {
      budget.remaining -= 1;
      const candidate = [...middle.slice(0, position), place, ...middle.slice(position)];
      const load = context.evaluate[dayIndex]!(candidate);
      if (load.status !== "valid") continue;
      const insertion = { dayIndex, position, middle: candidate, load, addedMetres: insertionAddedMetres(context, dayIndex, middle, place, position) };
      if (best === null || compareInsertions(context, insertion, best) < 0) best = insertion;
    }
  }
  return best;
}

function preflight(context: Context, baseline: State) {
  const conflicts: PlannerConflict[] = [];
  const proofs: PlannerConflict[] = [];
  for (let index = 0; index < context.days.length; index += 1) {
    const day = context.days[index]!;
    const fixedLoad = context.evaluate[index]!([...day.pinned].sort((left, right) =>
      (left.position ?? Number.MAX_SAFE_INTEGER) - (right.position ?? Number.MAX_SAFE_INTEGER) || comparePlannerIds(left.id, right.id)));
    if (fixedLoad.status === "baseline_unverifiable" || fixedLoad.status === "unverifiable_distance") {
      conflicts.push({ code: "baseline_unverifiable", dayId: day.id, checks: fixedLoad.checks });
    } else if (fixedLoad.status !== "valid") {
      conflicts.push({ code: "fixed_baseline_over_cap", dayId: day.id, checks: fixedLoad.checks });
    }
    if (context.input.mode === "keep") {
      for (const check of baseline.loads[index]!.checks) {
        const code = check.code === "baseline_unverifiable" ? "baseline_unverifiable"
          : check.code === "unverifiable_distance" ? "existing_unverifiable_distance" : `existing_${check.code}_over_cap` as const;
        conflicts.push({ code, dayId: day.id, checks: [check] });
      }
    }
  }
  const dayIds = new Set(context.days.map((day) => day.id));
  for (const place of context.input.flexiblePlaces) {
    if (!hasPlannerCoordinates(place.coordinates)) conflicts.push({ code: "missing_coordinates", placeId: place.id, checks: [] });
    if (context.input.mode === "keep" && place.assignedDayId !== null && !dayIds.has(place.assignedDayId)) {
      conflicts.push({ code: "baseline_unverifiable", placeId: place.id, checks: [] });
    }
  }
  if (conflicts.length > 0) return { conflicts, proofs };
  const pending = context.input.flexiblePlaces.filter((place) => context.movable.has(place.id));
  const capacity = baseline.loads.reduce((sum, load) => sum + Math.max(0, load.caps.maxPlacesPerDay - load.count), 0);
  if (capacity < pending.length) proofs.push({ code: "total_capacity", checks: [] });
  for (const place of pending) {
    const checks: PlannerBlockingCheck[] = [];
    const impossible = context.days.every((day, index) => {
      const load = baseline.loads[index]!;
      // Zero travel and full meal cover are admissible optimistic bounds, never a greedy-route proof.
      const optimisticBudget = load.windowMinutes - load.fixedOccupancyMinutes - load.restMinutes - load.slackMinutes;
      if (load.effort + place.estimate.effortLevel > day.caps.maxEffortPerDay) {
        checks.push({ dayId: day.id, code: "effort", current: load.effort, added: place.estimate.effortLevel, cap: day.caps.maxEffortPerDay });
        return true;
      }
      if (load.visitMinutes + place.estimate.visitMinutes > optimisticBudget || load.windowMinutes <= 0) {
        checks.push({ dayId: day.id, code: "budget", current: load.visitMinutes, added: place.estimate.visitMinutes, cap: optimisticBudget });
        return true;
      }
      return false;
    });
    if (impossible) proofs.push({ code: "place_exceeds_every_day", placeId: place.id, checks });
  }
  return { conflicts, proofs };
}

function constructionOrders(context: Context, baseline: State): PlaceOrder[] {
  const budget: Budget = { remaining: FEASIBILITY_CANDIDATE_LIMIT };
  return context.input.flexiblePlaces.filter((place) => context.movable.has(place.id)).sort((left, right) => comparePlannerIds(left.id, right.id)).map((place) => {
    let feasibleDays = 0;
    let size = 0;
    for (let index = 0; index < context.days.length; index += 1) {
      const load = baseline.loads[index]!;
      if (bestInsertion(context, baseline, place, budget, index)) feasibleDays += 1;
      size = Math.max(size, place.estimate.effortLevel / load.caps.maxEffortPerDay,
        place.estimate.visitMinutes / Math.max(1, load.budgetMinutes));
    }
    return { place, feasibleDays, size };
  });
}

function comparePlaceOrder(order: typeof CONSTRUCTION_ORDERS[number], left: PlaceOrder, right: PlaceOrder) {
  const tie = right.place.votes - left.place.votes || comparePlannerIds(left.place.id, right.place.id);
  if (order === "largest_first") return right.size - left.size || left.feasibleDays - right.feasibleDays || tie;
  if (order === "smallest_first") return left.size - right.size || left.feasibleDays - right.feasibleDays || tie;
  if (order === "votes_first") return right.place.votes - left.place.votes || left.feasibleDays - right.feasibleDays
    || right.size - left.size || comparePlannerIds(left.place.id, right.place.id);
  return left.feasibleDays - right.feasibleDays || right.size - left.size || tie;
}

function construct(context: Context, baseline: State, places: readonly PlaceOrder[]) {
  let state = baseline;
  const budget: Budget = { remaining: CONSTRUCTION_CANDIDATE_LIMIT };
  for (const { place } of places) {
    const insertion = bestInsertion(context, state, place, budget);
    if (insertion) state = withDay(state, insertion.dayIndex, insertion.middle, insertion.load);
  }
  return state;
}

/** The full queue must be restored before judging a move; intermediate objective regressions are allowed. */
function ejectAndReinsert(context: Context, initial: State, place: PlannerPlace, budget: Budget) {
  interface Pending { place: PlannerPlace; forbiddenDay?: number }
  const repair = (state: State, queue: readonly Pending[], remainingDepth: number, protectedIds: ReadonlySet<string>): State | null => {
    if (queue.length === 0) return state.loads.every((load) => load.status === "valid") ? state : null;
    if (budget.remaining <= 0) return null;
    const current = queue[0]!;
    const rest = queue.slice(1);
    const direct = bestInsertion(context, state, current.place, budget, undefined, current.forbiddenDay);
    if (direct) {
      const result = repair(withDay(state, direct.dayIndex, direct.middle, direct.load), rest, remainingDepth, protectedIds);
      if (result) return result;
    }
    if (remainingDepth === 0) return null;
    for (let dayIndex = 0; dayIndex < context.days.length && budget.remaining > 0; dayIndex += 1) {
      if (dayIndex === current.forbiddenDay) continue;
      const original = state.middle[dayIndex]!;
      const removable = original.filter((entry) => context.movable.has(entry.id) && !protectedIds.has(entry.id))
        .sort((left, right) => comparePlannerIds(left.id, right.id));
      for (let first = 0; first < removable.length && budget.remaining > 0; first += 1) {
        for (let second = -1; second < removable.length && budget.remaining > 0; second += 1) {
          if (second >= 0 && (remainingDepth < 2 || second <= first)) continue;
          const removed = second < 0 ? [removable[first]!] : [removable[first]!, removable[second]!];
          const removedIds = new Set(removed.map((entry) => entry.id));
          const remaining = original.filter((entry) => !removedIds.has(entry.id));
          const shortened = withDay(state, dayIndex, remaining, context.evaluate[dayIndex]!(remaining));
          const insertion = bestInsertion(context, shortened, current.place, budget, dayIndex);
          if (!insertion) continue;
          const nextProtected = new Set([...protectedIds, ...removedIds]);
          const result = repair(withDay(shortened, dayIndex, insertion.middle, insertion.load),
            [...rest, ...removed.map((entry) => ({ place: entry, forbiddenDay: dayIndex }))], remainingDepth - removed.length, nextProtected);
          if (result) return result;
        }
      }
    }
    return null;
  };
  return repair(initial, [{ place }], EJECTION_CHAIN_MAX_DEPTH, new Set([place.id]));
}

function improve(context: Context, initial: State, places: readonly PlaceOrder[]) {
  let state = initial;
  const budget: Budget = { remaining: IMPROVEMENT_CANDIDATE_LIMIT };
  for (let pass = 0; pass < IMPROVEMENT_MAX_PASSES && budget.remaining > 0; pass += 1) {
    let changed = false;
    let assigned = placedIds(context, state);
    for (const { place } of places) {
      if (assigned.has(place.id) || budget.remaining <= 0) continue;
      const repaired = ejectAndReinsert(context, state, place, budget);
      if (repaired && compareStates(context, repaired, state) < 0) {
        state = repaired;
        assigned = placedIds(context, state);
        changed = true;
      }
    }
    for (let source = 0; source < context.days.length && budget.remaining > 0; source += 1) {
      const ids = state.middle[source]!.filter((place) => context.movable.has(place.id)).map((place) => place.id).sort(comparePlannerIds);
      for (const id of ids) {
        const place = state.middle[source]!.find((entry) => entry.id === id);
        if (!place || budget.remaining <= 0) continue;
        const reduced = state.middle[source]!.filter((entry) => entry.id !== id);
        const sourceLoad = context.evaluate[source]!(reduced);
        if (sourceLoad.status !== "valid") continue;
        const removed = withDay(state, source, reduced, sourceLoad);
        for (let target = 0; target < context.days.length && budget.remaining > 0; target += 1) {
          if (target === source) continue;
          const insertion = bestInsertion(context, removed, place, budget, target);
          if (!insertion) continue;
          const candidate = withDay(removed, target, insertion.middle, insertion.load);
          if (compareStates(context, candidate, state) < 0) {
            state = candidate;
            changed = true;
            break;
          }
        }
      }
    }
    for (let leftDay = 0; leftDay < context.days.length && budget.remaining > 0; leftDay += 1) {
      for (let rightDay = leftDay + 1; rightDay < context.days.length && budget.remaining > 0; rightDay += 1) {
        const leftIds = state.middle[leftDay]!.filter((place) => context.movable.has(place.id)).map((place) => place.id).sort(comparePlannerIds);
        const rightIds = state.middle[rightDay]!.filter((place) => context.movable.has(place.id)).map((place) => place.id).sort(comparePlannerIds);
        for (const leftId of leftIds) {
          for (const rightId of rightIds) {
            if (budget.remaining <= 0) break;
            const left = state.middle[leftDay]!.find((place) => place.id === leftId);
            const right = state.middle[rightDay]!.find((place) => place.id === rightId);
            if (!left || !right) continue;
            const leftMiddle = state.middle[leftDay]!.filter((place) => place.id !== left.id);
            const rightMiddle = state.middle[rightDay]!.filter((place) => place.id !== right.id);
            const removed = withDay(withDay(state, leftDay, leftMiddle, context.evaluate[leftDay]!(leftMiddle)),
              rightDay, rightMiddle, context.evaluate[rightDay]!(rightMiddle));
            const insertRight = bestInsertion(context, removed, right, budget, leftDay);
            const insertLeft = bestInsertion(context, removed, left, budget, rightDay);
            if (!insertRight || !insertLeft) continue;
            const candidate = withDay(withDay(removed, leftDay, insertRight.middle, insertRight.load), rightDay, insertLeft.middle, insertLeft.load);
            if (compareStates(context, candidate, state) < 0) { state = candidate; changed = true; }
          }
        }
      }
    }
    if (!changed) break;
  }
  return state;
}

/** Exact intra-day reorder; null when a middle node has no coordinates (that day is unverifiable anyway). */
function reorderDay(context: Context, index: number, middle: readonly PlannerPlace[]) {
  if (middle.length === 0 || !middle.every((place) => hasPlannerCoordinates(place.coordinates))) return null;
  const day = context.days[index]!;
  const endpoints = middleSegmentEndpoints(day);
  if ((endpoints.start && !hasPlannerCoordinates(endpoints.start.coordinates))
    || (endpoints.end && !hasPlannerCoordinates(endpoints.end.coordinates))) return null;
  const points = new Map<GeoPoint, PlannerPlace | NonNullable<typeof endpoints.start>>();
  const point = (endpoint: NonNullable<typeof endpoints.start>): GeoPoint => {
    const value = { id: endpoint.id, ...endpoint.coordinates! };
    points.set(value, endpoint);
    return value;
  };
  const start = endpoints.start ? point(endpoints.start) : null;
  const end = endpoints.end ? point(endpoints.end) : null;
  const orderedIds = orderByStraightLine(middle.map(point), start, end,
    (from, to) => context.distance(points.get(from)!, points.get(to)!)!);
  const places = new Map(middle.map((place) => [place.id, place]));
  const reordered = orderedIds.map((id) => places.get(id)!);
  return { middle: reordered, load: context.evaluate[index]!(reordered) };
}

function finalReorder(context: Context, state: State) {
  let result = state;
  for (let index = 0; index < context.days.length; index += 1) {
    const reordered = reorderDay(context, index, result.middle[index]!);
    // A shorter total route can have a longer single hop or greater rounded travel time.
    // In that case keep the last valid order, then validate it again independently below.
    if (reordered && reordered.load.status === "valid") result = withDay(result, index, reordered.middle, reordered.load);
  }
  return result;
}

function reasonsForPlace(context: Context, state: State, place: PlannerPlace) {
  const reasons: PlannerBlockingCheck[] = [];
  for (let index = 0; index < context.days.length; index += 1) {
    const middle = state.middle[index]!;
    const current = state.loads[index]!;
    let best: PlannerDayLoad | null = null;
    for (let position = 0; position <= middle.length; position += 1) {
      const candidate = context.evaluate[index]!([...middle.slice(0, position), place, ...middle.slice(position)]);
      if (best === null || candidate.checks.length < best.checks.length
        || (candidate.checks.length === best.checks.length && candidate.straightMetres < best.straightMetres)) best = candidate;
    }
    for (const check of best?.checks ?? []) {
      const previous = check.code === "count" ? current.count : check.code === "effort" ? current.effort
        : check.code === "budget" ? current.loadMinutes : check.current;
      reasons.push({ ...check, current: previous, added: check.current - previous });
    }
  }
  return reasons;
}

interface WindowRelaxations {
  originalStart: number;
  originalEnd: number;
  fullScore: number;
  starts: { minute: number; score: number }[];
  ends: { minute: number; prefixMaximum: number }[];
}

/** Prefix maxima retain the best end even when extending into fixed occupancy lowers capacity. */
function windowRelaxations(day: PlannerDaySnapshot): WindowRelaxations {
  const originalStart = clockMinutes(day.caps.dayStart);
  const originalEnd = clockMinutes(day.caps.dayEnd);
  const full = computePlanningWindow(day, { ...day.caps, dayStart: "00:00", dayEnd: "24:00" });
  const usableFraction = 1 - day.caps.slackPercent / 100;
  const fullScore = full.windowMinutes * usableFraction - full.fixedOccupancyMinutes;
  const starts: WindowRelaxations["starts"] = [];
  const ends: WindowRelaxations["ends"] = [];
  for (let minute = originalStart; minute >= 0; minute -= SUGGESTION_CLOCK_STEP_MINUTES) {
    const window = computePlanningWindow(day, { ...day.caps, dayStart: formatClockMinutes(minute), dayEnd: "24:00" });
    starts.push({ minute, score: window.windowMinutes * usableFraction - window.fixedOccupancyMinutes });
  }
  let maximum = Number.NEGATIVE_INFINITY;
  for (let minute = originalEnd; minute <= SUGGESTION_CLOCK_LIMIT_MINUTES; minute += SUGGESTION_CLOCK_STEP_MINUTES) {
    const window = computePlanningWindow(day, { ...day.caps, dayStart: "00:00", dayEnd: formatClockMinutes(minute) });
    maximum = Math.max(maximum, window.windowMinutes * usableFraction - window.fixedOccupancyMinutes);
    ends.push({ minute, prefixMaximum: maximum });
  }
  return { originalStart, originalEnd, fullScore, starts, ends };
}

function compareSuggestions(left: PlannerSuggestion, right: PlannerSuggestion) {
  return left.relativeIncrease - right.relativeIncrease || left.fieldsChanged - right.fieldsChanged
    || comparePlannerIds(left.dayId, right.dayId) || comparePlannerIds(left.placeId, right.placeId)
    || comparePlannerIds(JSON.stringify(left.overrides), JSON.stringify(right.overrides));
}

function suggestionsForPlaces(context: Context, state: State, unplaced: readonly PlannerPlace[]) {
  const suggestions: PlannerSuggestion[] = [];
  const windows = new Map<number, WindowRelaxations>();
  const budget: Budget = { remaining: SUGGESTION_CANDIDATE_LIMIT };
  for (const place of unplaced) {
    if (budget.remaining <= 0) break;
    let best: PlannerSuggestion | null = null;
    for (let dayIndex = 0; dayIndex < context.days.length; dayIndex += 1) {
      const day = context.days[dayIndex]!;
      const original = day.caps;
      const middle = state.middle[dayIndex]!;
      for (let position = 0; position <= middle.length && budget.remaining > 0; position += 1) {
        budget.remaining -= 1;
        const inserted = [...middle.slice(0, position), place, ...middle.slice(position)];
        const load = context.evaluate[dayIndex]!(inserted);
        if (load.status === "baseline_unverifiable" || load.status === "unverifiable_distance") continue;
        const caps: PlannerEffectiveCaps = {
          ...original,
          // An explicit count override must also satisfy the raw target <= max cross-field rule.
          maxPlacesPerDay: load.count > original.maxPlacesPerDay
            ? Math.max(load.count, original.targetPlacesPerDay) : original.maxPlacesPerDay,
          maxEffortPerDay: Math.max(original.maxEffortPerDay, load.effort),
        };
        if (caps.maxPlacesPerDay > 12 || caps.maxEffortPerDay > 25) continue;
        const overrides: PlannerSuggestion["overrides"] = {};
        let capRelativeIncrease = 0;
        for (const key of ["maxPlacesPerDay", "maxEffortPerDay"] as const) {
          if (caps[key] === original[key]) continue;
          overrides[key] = caps[key];
          capRelativeIncrease = Math.max(capRelativeIncrease, (caps[key] - original[key]) / original[key]);
        }
        const consider = (start: number, end: number) => {
          const candidateOverrides = { ...overrides };
          if (start !== clockMinutes(original.dayStart)) candidateOverrides.dayStart = formatClockMinutes(start);
          if (end !== clockMinutes(original.dayEnd)) candidateOverrides.dayEnd = formatClockMinutes(end);
          const baseWindow = clockMinutes(original.dayEnd) - clockMinutes(original.dayStart);
          const relativeIncrease = Math.max(capRelativeIncrease, (end - start - baseWindow) / baseWindow);
          const candidate: PlannerSuggestion = {
            placeId: place.id, dayId: day.id, overrides: candidateOverrides, relativeIncrease,
            fieldsChanged: Object.keys(candidateOverrides).length,
          };
          if (candidate.fieldsChanged === 0 || (best !== null && compareSuggestions(candidate, best) >= 0)) return;
          const verified = context.evaluate[dayIndex]!(inserted, { ...caps, dayStart: formatClockMinutes(start), dayEnd: formatClockMinutes(end) });
          if (verified.status === "valid") best = candidate;
        };
        if (load.loadMinutes <= load.budgetMinutes) {
          consider(clockMinutes(original.dayStart), clockMinutes(original.dayEnd));
          continue;
        }
        let window = windows.get(dayIndex);
        if (!window) { window = windowRelaxations(day); windows.set(dayIndex, window); }
        const required = load.loadMinutes + load.mealReserveMinutes + original.restMinutes;
        for (const start of window.starts) {
          if (budget.remaining <= 0) break;
          budget.remaining -= 1;
          const neededEndScore = window.fullScore - start.score + required;
          let left = 0;
          let right = window.ends.length;
          while (left < right) {
            const midpoint = Math.floor((left + right) / 2);
            if (window.ends[midpoint]!.prefixMaximum + 1e-9 >= neededEndScore) right = midpoint;
            else left = midpoint + 1;
          }
          if (left < window.ends.length) consider(start.minute, window.ends[left]!.minute);
        }
      }
    }
    if (best) suggestions.push(best);
  }
  return suggestions.sort(compareSuggestions).slice(0, MAX_PLANNER_SUGGESTIONS);
}

export function solveWholeTrip(input: PlannerInput): PlannerResult {
  if (input.days.length > PLANNER_MAX_DAYS || input.flexiblePlaces.length > PLANNER_MAX_FLEXIBLE_PLACES) {
    throw new Error("planner_input_too_large");
  }
  // Calendar order (date, then id): output days are shown as 第 N 天 in this order.
  const days = [...input.days].sort((left, right) => comparePlannerIds(left.date, right.date) || comparePlannerIds(left.id, right.id));
  const distance = createPlannerDistanceMatrix(input);
  const context: Context = {
    input, days, distance, evaluate: days.map((day) => createDayLoadEvaluator(day, distance)),
    endpoints: days.map(middleSegmentEndpoints),
    flexible: new Set(input.flexiblePlaces.map((place) => place.id)),
    movable: new Set(input.flexiblePlaces.filter((place) => input.mode === "replan" || place.assignedDayId === null).map((place) => place.id)),
  };
  const baseline = initialState(context);
  const { conflicts, proofs } = preflight(context, baseline);
  const excludedPlaceIds = input.excludedPlaces.map((place) => place.id).sort(comparePlannerIds);
  if (conflicts.length > 0) return { status: "baseline_conflict", days: [], conflicts, unplaced: [], excludedPlaceIds, suggestions: [] };
  const orderedPlaces = constructionOrders(context, baseline);
  let best = baseline;
  for (const order of CONSTRUCTION_ORDERS) {
    const places = [...orderedPlaces].sort((left, right) => comparePlaceOrder(order, left, right));
    const candidate = improve(context, construct(context, baseline, places), places);
    if (compareStates(context, candidate, best) < 0) best = candidate;
  }
  best = finalReorder(context, best);
  const assigned = placedIds(context, best);
  const unplaced = input.flexiblePlaces.filter((place) => !assigned.has(place.id)).sort((left, right) => comparePlannerIds(left.id, right.id));
  const result: PlannerResult = {
    status: unplaced.length === 0 ? "complete" : proofs.length > 0 ? "proven_infeasible" : "search_incomplete",
    days: days.map((day, index) => ({ dayId: day.id, orderedPlaceIds: best.middle[index]!.map((place) => place.id), load: best.loads[index]! })),
    conflicts: unplaced.length === 0 ? [] : proofs,
    unplaced: unplaced.map((place) => ({ placeId: place.id, reasons: reasonsForPlace(context, best, place) })),
    excludedPlaceIds, suggestions: suggestionsForPlaces(context, best, unplaced),
  };
  const validation = validateWholeTripPlan(input, result);
  if (!validation.valid) throw new Error(`planner_validation_failed:${validation.errors.join(",")}`);
  return result;
}
