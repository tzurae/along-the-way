import type { PreferenceLevel } from "@along-the-way/contracts/trip-places";

import { straightLineMeters, type GeoPoint } from "./day-route-order";
import type { DayHours } from "./opening-hours";

/** A day with a planned place, fixed item or lodging this close (straight line) counts as nearby. */
export const NEARBY_METERS = 10_000;
/** A day takes new places while its estimated load stays at or below this share of its hours. */
export const LOAD_LIMIT_PERCENT = 70;

const PREFERENCE_PRIORITY: Record<PreferenceLevel, number> = {
  must: 0,
  want: 1,
  optional: 2,
  neutral: 3,
  dislike: 4,
};

/** Lower is planned first: the best preference any member gave; unrated counts as neutral. */
export function preferencePriority(levels: Array<PreferenceLevel | null>) {
  const ranks = levels.flatMap((level) => (level === null ? [] : [PREFERENCE_PRIORITY[level]]));
  return ranks.length === 0 ? PREFERENCE_PRIORITY.neutral : Math.min(...ranks);
}

export interface StayPoint extends GeoPoint {
  stayMinutes: number;
}

export interface DistributionDay {
  id: string;
  date: string;
  windowMinutes: number;
  /** Time of fixed itinerary items inside the day's hours. */
  fixedMinutes: number;
  /** That night's lodging; the estimate starts and ends there. */
  lodging: GeoPoint | null;
  /** Places already planned for the day, in order. They never move. */
  kept: StayPoint[];
  /** Stays of places planned for the day without a map location: time, but no estimated travel. */
  unmappedStays: number[];
  /** Located fixed items: they make a day nearby but add no estimated travel. */
  fixedPoints: GeoPoint[];
}

export interface DistributionCandidate extends StayPoint {
  /** Lower comes first: the best preference any member gave the place. */
  priority: number;
  hours(dayId: string): DayHours;
}

export type DistributionReason = "closed_all_trip_days" | "no_day_fits";

export interface Distribution {
  /** Places added to each day, by day ID, in the order they were added. */
  added: Map<string, string[]>;
  unplaced: Array<{ id: string; reason: DistributionReason }>;
}

/**
 * Rough minutes between two places from their straight-line distance: walking up to 1.2 km,
 * otherwise a train with 15 minutes of overhead at 30 km/h. Only used to decide which day has
 * room; the timetable later checks real routes.
 */
export function estimatedTravelMinutes(from: GeoPoint, to: GeoPoint) {
  const km = straightLineMeters(from, to) / 1000;
  return Math.ceil(km <= 1.2 ? km * 12.5 : 15 + 2 * km);
}

/** Fixed time, stays, and estimated travel from the lodging through the places and back. */
export function estimatedLoadMinutes(day: DistributionDay, places: StayPoint[]) {
  const path: GeoPoint[] = day.lodging ? [day.lodging, ...places, day.lodging] : places;
  let travel = 0;
  for (let index = 1; index < path.length; index += 1) {
    travel += estimatedTravelMinutes(path[index - 1]!, path[index]!);
  }
  return day.fixedMinutes
    + day.unmappedStays.reduce((sum, stay) => sum + stay, 0)
    + places.reduce((sum, place) => sum + place.stayMinutes, 0)
    + travel;
}

/**
 * Adds each candidate, best preference first and otherwise in list order, to a day where it
 * is open and the estimated load stays within the limit. The nearest day with something
 * within 10 km wins; otherwise the earliest day without places; otherwise it stays unplaced.
 * New places go after a day's existing ones. The result depends only on the input.
 */
export function distributePlaces(days: DistributionDay[], candidates: DistributionCandidate[]): Distribution {
  const byDate = [...days].sort((left, right) => left.date.localeCompare(right.date));
  // A stable sort keeps list order within one preference level.
  const ordered = [...candidates].sort((left, right) => left.priority - right.priority);
  const placed = new Map(byDate.map((day) => [day.id, [...day.kept]]));
  const added = new Map(byDate.map((day) => [day.id, [] as string[]]));
  const unplaced: Distribution["unplaced"] = [];

  for (const candidate of ordered) {
    const open = byDate.filter((day) => candidate.hours(day.id).status !== "closed");
    if (open.length === 0) {
      unplaced.push({ id: candidate.id, reason: "closed_all_trip_days" });
      continue;
    }
    const roomy = open.filter((day) =>
      estimatedLoadMinutes(day, [...placed.get(day.id)!, candidate]) * 100 <= day.windowMinutes * LOAD_LIMIT_PERCENT);
    let chosen: DistributionDay | null = null;
    let chosenDistance = Number.POSITIVE_INFINITY;
    for (const day of roomy) {
      const anchors = [...placed.get(day.id)!, ...day.fixedPoints, ...(day.lodging ? [day.lodging] : [])];
      for (const anchor of anchors) {
        const distance = straightLineMeters(anchor, candidate);
        // Strictly nearer only, so an equally near later day never displaces an earlier one.
        if (distance <= NEARBY_METERS && distance < chosenDistance) {
          chosen = day;
          chosenDistance = distance;
        }
      }
    }
    chosen ??= roomy.find((day) => placed.get(day.id)!.length === 0 && day.unmappedStays.length === 0) ?? null;
    if (!chosen) {
      unplaced.push({ id: candidate.id, reason: "no_day_fits" });
      continue;
    }
    placed.get(chosen.id)!.push(candidate);
    added.get(chosen.id)!.push(candidate.id);
  }
  return { added, unplaced };
}
