import { TAXI_BUFFER_MINUTES, type DayLegDto, type TravelMode } from "@along-the-way/contracts/day-plans";
import type { RouteMode, RouteObservation } from "@along-the-way/contracts/planning-observations";

import type { TimetableResult } from "./day-timetable";

/** Walking this long or less is preferred to transit on a 大眾運輸 day. */
export const PREFERRED_WALK_MINUTES = 15;

type AvailableObservation = Extract<RouteObservation, { status: "available" }>;

function firstAvailable(observations: RouteObservation[], mode: RouteMode) {
  return observations.find((entry): entry is AvailableObservation =>
    entry.mode === mode && entry.status === "available") ?? null;
}

/** What to ask the route providers for a leg travelled this way. */
export function routeModesFor(mode: TravelMode): RouteMode[] {
  return mode === "taxi" ? ["drive"] : ["walking", "transit"];
}

/** The walk a leg may take before transit is used instead. */
export function walkLimitFor(mode: TravelMode, dayWalkLimit: number) {
  return mode === "walk" ? dayWalkLimit : PREFERRED_WALK_MINUTES;
}

/**
 * One leg from what the providers observed. Taxi is the drive plus time to get a cab.
 * Otherwise walk within the limit, else transit; with neither, the leg is unknown, never a
 * long walk standing in for missing transit.
 */
export function legFor(
  observations: RouteObservation[],
  names: { fromName: string; toName: string },
  mode: TravelMode,
  walkLimit: number,
): DayLegDto {
  const reasons = [...new Set(observations.flatMap((entry) => entry.status === "unavailable" ? [entry.reason] : []))];
  if (mode === "taxi") {
    const drive = firstAvailable(observations, "drive");
    return {
      ...names,
      mode: drive ? "taxi" : null,
      durationMinutes: drive ? drive.durationMinutes + TAXI_BUFFER_MINUTES : null,
      walkingMinutes: null,
      transitMinutes: null,
      estimated: false,
      attribution: drive?.attribution ?? null,
      unavailableReason: drive ? null : (reasons.join(", ") || "no_route"),
    };
  }
  const walking = firstAvailable(observations, "walking");
  const transit = firstAvailable(observations, "transit");
  const chosen = walking && walking.durationMinutes <= walkLimit ? walking : transit;
  return {
    ...names,
    mode: chosen ? (chosen.mode === "walking" ? "walking" : "transit") : null,
    durationMinutes: chosen?.durationMinutes ?? null,
    walkingMinutes: walking?.durationMinutes ?? null,
    transitMinutes: transit?.durationMinutes ?? null,
    estimated: chosen?.manualChecks.includes("transit_duration_estimated") ?? false,
    attribution: chosen?.attribution ?? null,
    unavailableReason: chosen ? null : (reasons.join(", ") || (walking ? "no_transit" : "no_route")),
  };
}

export function visitIds(result: TimetableResult) {
  return new Set(result.rows.flatMap((row) => (row.kind === "visit" ? [row.tripPlaceId] : [])));
}

/**
 * A place just dropped into a day did not fit as the day travels, or pushed a placed one out:
 * try taxi for the leg into it and the leg out of it. A short walk can beat waiting for a cab,
 * so each leg is tried with and without taxi, one leg before both. When none fits, no mix of each
 * leg's own way and taxi does; another way (say, walking a short leg of a taxi day) is not tried.
 *
 * `draft` schedules `orderedIds` with these leg modes (keyed by the place a leg arrives at).
 * Returns null when the drop already fits, or when no taxi choice makes it fit.
 */
export async function taxiAlternative(input: {
  orderedIds: string[];
  placeId: string;
  legModes: Record<string, TravelMode>;
  draft: (orderedIds: string[], legModes: Record<string, TravelMode>) => Promise<TimetableResult>;
  /** The draft with the place, as the day travels, when already made. */
  withPlace?: TimetableResult;
}): Promise<{ legModes: Record<string, TravelMode>; result: TimetableResult } | null> {
  const { orderedIds, placeId, legModes, draft } = input;
  const placedBefore = visitIds(await draft(orderedIds.filter((id) => id !== placeId), legModes));
  const fits = (result: TimetableResult) => {
    const placed = visitIds(result);
    return placed.has(placeId) && [...placedBefore].every((id) => placed.has(id));
  };
  if (fits(input.withPlace ?? await draft(orderedIds, legModes))) return null;
  // The leg out arrives at the next stop that is actually placed, not at a listed one the day
  // could not hold.
  const next = orderedIds.slice(orderedIds.indexOf(placeId) + 1).find((id) => placedBefore.has(id));
  const combinations = next ? [[placeId], [next], [placeId, next]] : [[placeId]];
  for (const taxiLegs of combinations) {
    const taxiModes: Record<string, TravelMode> = { ...legModes, ...Object.fromEntries(taxiLegs.map((id) => [id, "taxi" as const])) };
    const result = await draft(orderedIds, taxiModes);
    if (fits(result)) return { legModes: taxiModes, result };
  }
  return null;
}
