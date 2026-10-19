import { comparePlannerIds, computeDayLoad } from "./day-load";
import type { PlannerDayLoad, PlannerInput, PlannerPlace, PlannerResult, PlannerValidation } from "./planner-model";

const VERIFIED_LOAD_FIELDS = [
  "windowStartMinute", "windowEndMinute", "windowMinutes", "fixedOccupancyMinutes", "mealReserveMinutes",
  "restMinutes", "slackMinutes", "budgetMinutes", "visitMinutes", "travelMinutes", "loadMinutes", "totalMinutes",
  "count", "effort", "straightMetres", "status",
] as const satisfies readonly (keyof PlannerDayLoad)[];

/** Independent of construction and its distance matrix, cached loads, search state and moves. */
export function validateWholeTripPlan(input: PlannerInput, result: PlannerResult): PlannerValidation {
  const errors: string[] = [];
  const days: PlannerValidation["days"] = [];
  if (result.status === "baseline_conflict") return { valid: false, errors: ["baseline_conflict"], days };
  const snapshots = new Map(input.days.map((day) => [day.id, day]));
  const flexible = new Map(input.flexiblePlaces.map((place) => [place.id, place]));
  const seenDays = new Set<string>();
  const seenFlexible = new Set<string>();
  const seenPinned = new Set<string>();
  for (const output of result.days) {
    const snapshot = snapshots.get(output.dayId);
    if (!snapshot || seenDays.has(output.dayId)) {
      errors.push(`unknown_or_duplicate_day:${output.dayId}`);
      continue;
    }
    seenDays.add(output.dayId);
    const pinned = new Map(snapshot.pinned.map((place) => [place.id, place]));
    const middle: PlannerPlace[] = [];
    for (const placeId of output.orderedPlaceIds) {
      const pinnedPlace = pinned.get(placeId);
      if (pinnedPlace) {
        if (seenPinned.has(placeId)) errors.push(`duplicate_pinned:${placeId}`);
        seenPinned.add(placeId);
        middle.push(pinnedPlace);
        continue;
      }
      const place = flexible.get(placeId);
      if (!place || seenFlexible.has(placeId)) {
        errors.push(`unknown_or_duplicate_place:${placeId}`);
        continue;
      }
      seenFlexible.add(placeId);
      if (input.mode === "keep" && place.assignedDayId !== null && place.assignedDayId !== snapshot.id) {
        errors.push(`kept_place_moved:${placeId}`);
      }
      middle.push(place);
    }
    for (const place of snapshot.pinned) {
      if (!output.orderedPlaceIds.includes(place.id)) errors.push(`missing_pinned:${place.id}`);
    }
    // No matrix from the constructor: Haversine, occupancy, meal cover and every cap are recalculated.
    const load = computeDayLoad(snapshot, middle);
    if (load.status !== "valid") errors.push(`invalid_day:${snapshot.id}:${load.status}`);
    if (VERIFIED_LOAD_FIELDS.some((key) => output.load[key] !== load[key])) errors.push(`load_mismatch:${snapshot.id}`);
    days.push({ dayId: snapshot.id, orderedPlaceIds: [...output.orderedPlaceIds], load });
  }
  for (const day of input.days) {
    if (!seenDays.has(day.id)) errors.push(`missing_day:${day.id}`);
  }
  const unplacedIds = new Set<string>();
  for (const entry of result.unplaced) {
    if (!flexible.has(entry.placeId) || unplacedIds.has(entry.placeId) || seenFlexible.has(entry.placeId)) {
      errors.push(`invalid_unplaced:${entry.placeId}`);
    }
    unplacedIds.add(entry.placeId);
  }
  for (const place of input.flexiblePlaces) {
    if (seenFlexible.has(place.id)) continue;
    if (!unplacedIds.has(place.id)) errors.push(`missing_place:${place.id}`);
    if (result.status === "complete") errors.push(`incomplete_complete_plan:${place.id}`);
    if (input.mode === "keep" && place.assignedDayId !== null) errors.push(`kept_place_unplaced:${place.id}`);
  }
  if (result.status === "complete" && (result.unplaced.length !== 0 || result.conflicts.length !== 0)) {
    errors.push("complete_has_conflicts_or_unplaced");
  }
  const expectedExcluded = input.excludedPlaces.map((place) => place.id).sort(comparePlannerIds);
  const actualExcluded = [...result.excludedPlaceIds].sort(comparePlannerIds);
  if (expectedExcluded.length !== actualExcluded.length || expectedExcluded.some((id, index) => id !== actualExcluded[index])) {
    errors.push("excluded_places_mismatch");
  }
  return { valid: errors.length === 0, errors, days };
}
