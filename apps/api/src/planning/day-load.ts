import { Temporal } from "@js-temporal/polyfill";
import { estimatedMoveMinutes, straightLineMeters } from "@along-the-way/contracts/day-timeline";
import type {
  PlannerBlockingCheck,
  PlannerCoordinates,
  PlannerDayLoad,
  PlannerDaySnapshot,
  PlannerEffectiveCaps,
  PlannerEndpoint,
  PlannerInput,
  PlannerPlace,
  PlannerRouteNode,
} from "./planner-model";

export const ARRIVAL_BUFFER_MINUTES = 60;
export const DEPARTURE_BUFFER_MINUTES = 120;
export const UTILISATION_BAND = 0.05;

export function comparePlannerIds(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function hasPlannerCoordinates(value: PlannerCoordinates | null): value is PlannerCoordinates {
  return value !== null && Number.isFinite(value.latitude) && Number.isFinite(value.longitude)
    && Math.abs(value.latitude) <= 90 && Math.abs(value.longitude) <= 180;
}

export type PlannerDistanceMatrix = (from: PlannerEndpoint, to: PlannerEndpoint) => number | null;

function coordinateKey(point: PlannerCoordinates) {
  return `${point.latitude},${point.longitude}`;
}

function directMetres(from: PlannerEndpoint, to: PlannerEndpoint) {
  if (!hasPlannerCoordinates(from.coordinates) || !hasPlannerCoordinates(to.coordinates)) return null;
  return Math.round(straightLineMeters({ id: from.id, ...from.coordinates }, { id: to.id, ...to.coordinates }));
}

/** Each distinct coordinate pair is calculated once, including both endpoints of services. */
export function createPlannerDistanceMatrix(input: PlannerInput): PlannerDistanceMatrix {
  const points: PlannerCoordinates[] = [];
  const indexes = new Map<string, number>();
  const add = (endpoint: PlannerEndpoint | null) => {
    if (!endpoint || !hasPlannerCoordinates(endpoint.coordinates)) return;
    const key = coordinateKey(endpoint.coordinates);
    if (!indexes.has(key)) {
      indexes.set(key, points.length);
      points.push(endpoint.coordinates);
    }
  };
  for (const place of input.flexiblePlaces) add(place);
  for (const day of input.days) {
    add(day.previousLodging);
    add(day.nightLodging);
    for (const place of day.pinned) add(place);
    for (const anchor of day.anchors) {
      add(anchor.start);
      add(anchor.end);
    }
  }
  const size = points.length;
  const metres = new Uint32Array(size * size);
  for (let from = 0; from < size; from += 1) {
    for (let to = from + 1; to < size; to += 1) {
      const distance = Math.round(straightLineMeters({ id: "", ...points[from]! }, { id: "", ...points[to]! }));
      metres[from * size + to] = distance;
      metres[to * size + from] = distance;
    }
  }
  return (from, to) => {
    if (!hasPlannerCoordinates(from.coordinates) || !hasPlannerCoordinates(to.coordinates)) return null;
    const fromIndex = indexes.get(coordinateKey(from.coordinates));
    const toIndex = indexes.get(coordinateKey(to.coordinates));
    if (fromIndex === undefined || toIndex === undefined) throw new Error("planner_distance_matrix_endpoint_missing");
    return metres[fromIndex * size + toIndex]!;
  };
}

export function clockMinutes(value: string) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours! * 60 + minutes!;
}

export function formatClockMinutes(minutes: number) {
  return `${Math.floor(minutes / 60).toString().padStart(2, "0")}:${(minutes % 60).toString().padStart(2, "0")}`;
}

/** Explicit input date, never Temporal.Now. 24:00 is midnight on the following date. */
function localEpochMinute(day: PlannerDaySnapshot, value: string) {
  const minute = clockMinutes(value);
  const date = Temporal.PlainDate.from(day.date).add({ days: minute === 1440 ? 1 : 0 });
  return date.toPlainDateTime({ hour: minute === 1440 ? 0 : Math.floor(minute / 60), minute: minute % 60 })
    .toZonedDateTime(day.timeZone, { disambiguation: "compatible" }).epochMilliseconds / 60_000;
}

export function computePlanningWindow(day: PlannerDaySnapshot, caps: PlannerEffectiveCaps) {
  let start = localEpochMinute(day, caps.dayStart);
  let end = localEpochMinute(day, caps.dayEnd);
  for (const arrival of day.arrivalEndMinutes) start = Math.max(start, arrival + ARRIVAL_BUFFER_MINUTES);
  for (const departure of day.departureStartMinutes) end = Math.min(end, departure - DEPARTURE_BUFFER_MINUTES);
  const windowMinutes = Math.max(0, end - start);
  const intervals = day.occupancy
    .map((item) => [Math.max(start, item.startMinute), Math.min(end, item.endMinute)] as const)
    .filter(([left, right]) => right > left)
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  let fixedOccupancyMinutes = 0;
  let previousEnd = start;
  for (const [left, right] of intervals) {
    fixedOccupancyMinutes += Math.max(0, right - Math.max(previousEnd, left));
    previousEnd = Math.max(previousEnd, right);
  }
  return { windowStartMinute: start, windowEndMinute: end, windowMinutes, fixedOccupancyMinutes };
}

export type PlannerDayLoadEvaluator = (middle: readonly PlannerPlace[], caps?: PlannerEffectiveCaps) => PlannerDayLoad;

function routeEnds(day: PlannerDaySnapshot) {
  const before: PlannerRouteNode[] = [];
  const after: PlannerRouteNode[] = [];
  if (day.previousLodging) before.push({ id: day.previousLodging.id, kind: "lodging", start: day.previousLodging, end: day.previousLodging });
  const anchors = [...day.anchors].sort((left, right) => left.startMinute - right.startMinute || comparePlannerIds(left.id, right.id));
  for (const anchor of anchors) {
    const node: PlannerRouteNode = { id: anchor.id, kind: "anchor", start: anchor.start, end: anchor.end };
    (anchor.localStartMinute < 720 ? before : after).push(node);
  }
  if (day.nightLodging) after.push({ id: day.nightLodging.id, kind: "lodging", start: day.nightLodging, end: day.nightLodging });
  return { before, after };
}

export function middleSegmentEndpoints(day: PlannerDaySnapshot) {
  const { before, after } = routeEnds(day);
  return { start: before.at(-1)?.end ?? null, end: after[0]?.start ?? null };
}

function ratio(value: number, cap: number) {
  if (cap > 0) return value / cap;
  return value === 0 && cap === 0 ? 0 : 1 + Math.max(0, value - cap);
}

export function utilisationBand(load: PlannerDayLoad) {
  return Math.floor(load.utilisation / UTILISATION_BAND + 1e-9);
}

/** Reuses only immutable normalization; every candidate still runs every hard check. */
export function createDayLoadEvaluator(day: PlannerDaySnapshot, distance: PlannerDistanceMatrix = directMetres): PlannerDayLoadEvaluator {
  const originalWindow = computePlanningWindow(day, day.caps);
  const { before, after } = routeEnds(day);
  const pinnedIds = new Set(day.pinned.map((place) => place.id));
  const fixed = [...new Map(day.fixedSelected.map((place) => [place.id, place])).values()];
  const fixedEffort = fixed.reduce((total, place) => total + place.estimate.effortLevel, 0);
  const baselineMeals = new Map<string, number>();
  for (const contribution of day.meals) {
    baselineMeals.set(contribution.id, Math.max(baselineMeals.get(contribution.id) ?? 0, contribution.minutes));
  }
  for (const place of fixed) {
    if (place.type === "restaurant" || place.type === "cafe") {
      baselineMeals.set(place.id, Math.max(baselineMeals.get(place.id) ?? 0, place.estimate.visitMinutes));
    }
  }
  const invalidInstants = [
    ...day.occupancy.filter((item) => !Number.isFinite(item.startMinute) || !Number.isFinite(item.endMinute)
      || item.endMinute < item.startMinute).map((item) => item.id),
    ...day.anchors.filter((item) => !Number.isFinite(item.startMinute) || !Number.isFinite(item.localStartMinute)).map((item) => item.id),
  ];
  const unresolvedItemIds = [...new Set([...day.unresolvedItemIds, ...invalidInstants])].sort(comparePlannerIds);

  return (middle: readonly PlannerPlace[], caps: PlannerEffectiveCaps = day.caps): PlannerDayLoad => {
    const window = caps.dayStart === day.caps.dayStart && caps.dayEnd === day.caps.dayEnd
      ? originalWindow : computePlanningWindow(day, caps);
    const meals = new Map(baselineMeals);
    let count = fixed.length;
    let effort = fixedEffort;
    let visitMinutes = 0;
    const route = [...before];
    for (const place of middle) {
      const pinned = pinnedIds.has(place.id);
      if (!pinned) {
        count += 1;
        effort += place.estimate.effortLevel;
        visitMinutes += place.estimate.visitMinutes;
        if (place.type === "restaurant" || place.type === "cafe") {
          meals.set(place.id, Math.max(meals.get(place.id) ?? 0, place.estimate.visitMinutes));
        }
      }
      route.push({ id: place.id, kind: pinned ? "pinned" : "flexible", start: place, end: place });
    }
    route.push(...after);
    const mealCovered = [...meals.values()].reduce((sum, minutes) => sum + minutes, 0);
    const mealReserveMinutes = Math.max(0, caps.mealReserveMinutes - mealCovered);
    const slackMinutes = Math.ceil(window.windowMinutes * caps.slackPercent / 100);
    const budgetMinutes = window.windowMinutes - window.fixedOccupancyMinutes - mealReserveMinutes - caps.restMinutes - slackMinutes;
    const missingCoordinates = new Set<string>();
    for (const node of route) {
      if (!hasPlannerCoordinates(node.start.coordinates)) missingCoordinates.add(node.start.id);
      if (!hasPlannerCoordinates(node.end.coordinates)) missingCoordinates.add(node.end.id);
    }
    const legs: PlannerDayLoad["legs"] = [];
    let straightMetres = 0;
    let travelMinutes = 0;
    for (let index = 1; index < route.length; index += 1) {
      const from = route[index - 1]!.end;
      const to = route[index]!.start;
      const metres = distance(from, to);
      if (metres === null) continue;
      const minutes = estimatedMoveMinutes(metres, caps);
      legs.push({ fromId: from.id, toId: to.id, metres, travelMinutes: minutes });
      straightMetres += metres;
      travelMinutes += minutes;
    }
    const loadMinutes = visitMinutes + travelMinutes;
    const checks: PlannerBlockingCheck[] = [];
    const check = (code: PlannerBlockingCheck["code"], current: number, cap: number) => {
      if (current > cap) checks.push({ dayId: day.id, code, current, added: 0, cap });
    };
    check("count", count, caps.maxPlacesPerDay);
    check("effort", effort, caps.maxEffortPerDay);
    // §2: a short or empty window (late arrival, early departure, a full-day booked tour) can only
    // carry its fixed baseline. Its reserves can make the budget negative, which must not turn
    // routine days into a whole-trip baseline conflict. The budget therefore binds only once a
    // flexible place is on the day; then a non-positive budget is always a violation.
    const hasFlexible = count > fixed.length;
    if (hasFlexible && budgetMinutes <= 0) checks.push({ dayId: day.id, code: "budget", current: loadMinutes, added: 0, cap: budgetMinutes });
    else if (hasFlexible) check("budget", loadMinutes, budgetMinutes);
    if (missingCoordinates.size > 0) checks.push({ dayId: day.id, code: "unverifiable_distance", current: missingCoordinates.size, added: 0, cap: 0 });
    if (unresolvedItemIds.length > 0) checks.push({ dayId: day.id, code: "baseline_unverifiable", current: unresolvedItemIds.length, added: 0, cap: 0 });
    const status = unresolvedItemIds.length > 0 ? "baseline_unverifiable"
      : missingCoordinates.size > 0 ? "unverifiable_distance" : checks.length > 0 ? "over_cap" : "valid";
    return {
      dayId: day.id, status, caps, ...window, fixedOccupancyMinutes: window.fixedOccupancyMinutes,
      mealReserveMinutes, restMinutes: caps.restMinutes, slackMinutes, budgetMinutes,
      visitMinutes, travelMinutes, loadMinutes,
      totalMinutes: loadMinutes + window.fixedOccupancyMinutes + mealReserveMinutes + caps.restMinutes + slackMinutes,
      count, effort, straightMetres,
      // Distance is not a cap (km caps removed 2026-10-19); it binds only through travel minutes in the budget.
      utilisation: Math.max(ratio(count, caps.maxPlacesPerDay), ratio(effort, caps.maxEffortPerDay),
        hasFlexible || budgetMinutes > 0 ? ratio(loadMinutes, budgetMinutes) : 0),
      noLodging: day.previousLodging === null || day.nightLodging === null,
      missingCoordinateIds: [...missingCoordinates].sort(comparePlannerIds), unresolvedItemIds,
      route, legs, checks,
    };
  };
}

/** Public load / independent-validation path; it does not trust solver caches. */
export function computeDayLoad(day: PlannerDaySnapshot, middle: readonly PlannerPlace[], distance?: PlannerDistanceMatrix) {
  return createDayLoadEvaluator(day, distance)(middle);
}
