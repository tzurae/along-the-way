import type { DayRouteDto, DayRouteOrder, DayRouteOrderBasis, DayRouteOrderReason } from "@along-the-way/contracts/day-plans";
import type { DayTimelineFrame, DayTimelineStop } from "@along-the-way/contracts/day-timeline";
import type { TripPlaceMealRole } from "@along-the-way/contracts/trip-places";
import type { PlaceType } from "@along-the-way/contracts/trip-skeleton";

import { planDayOrder } from "./day-order";
import { orderByStraightLine, straightLineMeters, type GeoPoint } from "./day-route-order";

export interface RoutePlace {
  id: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  /** Google place ID when known; carried through for Maps links, never used for distance. */
  providerPlaceId: string | null;
}

export interface DayRouteInput {
  dayId: string;
  date: string;
  version: number;
  order: DayRouteOrder;
  /** The day's places in their saved order. */
  planned: RoutePlace[];
  /** Only with `custom`: a validated subset of `planned`, in the wanted order. */
  orderedIds?: string[];
  /** Where the day starts: the previous night's lodging. */
  morningLodging: { place: RoutePlace } | null;
  /** Where the day ends: that night's lodging. */
  nightLodging: { place: RoutePlace } | null;
  /** Planning-derived timing; omitted, every timing field of the DTO is null. */
  timing?: DayRouteTiming;
}

export interface DayRouteTiming {
  dayStartMinute: number;
  fixedMinutes: number;
  /** Every planned place's stay and meal facts. */
  places: ReadonlyMap<string, { stayMinutes: number; stayEstimated: boolean; type: PlaceType; mealRole: TripPlaceMealRole | null }>;
  /** The day load's straight-line move estimate for rounded metres. */
  moveMinutes(metres: number): number;
  /** The day's timeline frame (f5 §1.1). */
  frame: DayTimelineFrame;
}

/** The timeline's view of a planned place (f5 §1.1 stays; 1b 哪一餐). */
export function timelineStop(place: RoutePlace, timing: DayRouteTiming): DayTimelineStop {
  const facts = timing.places.get(place.id);
  return { id: place.id, type: facts?.type ?? null, stayMinutes: facts?.stayMinutes ?? 0, mealRole: facts?.mealRole ?? null,
    latitude: place.latitude, longitude: place.longitude };
}

function located(place: RoutePlace): place is RoutePlace & GeoPoint {
  return place.latitude !== null && place.longitude !== null;
}

/** The DTO total: each known leg rounds independently, and an unlocated tail hides the end leg. */
function displayedTotalMeters(
  order: Array<RoutePlace & GeoPoint>,
  start: GeoPoint | null,
  end: GeoPoint | null,
  hasUnlocatedTail: boolean,
) {
  if (order.length === 0) return 0;
  let total = start ? Math.round(straightLineMeters(start, order[0]!)) : 0;
  for (let index = 1; index < order.length; index += 1) {
    total += Math.round(straightLineMeters(order[index - 1]!, order[index]!));
  }
  if (end && !hasUnlocatedTail) {
    total += Math.round(straightLineMeters(order.at(-1)!, end));
  }
  return total;
}

/**
 * The day as a route: located places in the requested order (or the suggested one: meals first, then
 * distance, p9 §2; distance alone when the day cannot be timed), places without coordinates after
 * them in saved order, and each leg's rounded straight-line metres. Lodging without coordinates is
 * named but never measured, so it cannot stand in as (0, 0).
 */
export function buildDayRoute(input: DayRouteInput): DayRouteDto {
  const { order, planned } = input;
  const start = input.morningLodging?.place ?? null;
  const end = input.nightLodging?.place ?? null;
  const morning = start && located(start) ? start : null;
  const night = end && located(end) ? end : null;

  const plannedById = new Map(planned.map((place) => [place.id, place]));
  const candidates = order === "custom" ? input.orderedIds!.map((id) => plannedById.get(id)!) : planned;
  const candidateIds = new Set(candidates.map((place) => place.id));
  const locatedCandidates = candidates.filter(located);
  const unlocated = planned.filter((place) => candidateIds.has(place.id) && !located(place));
  let orderedLocated = locatedCandidates;
  let orderBasis: DayRouteOrderBasis | null = null;
  let orderReason: DayRouteOrderReason | null = null;
  const timing = input.timing;
  if (order === "suggested") {
    // The saved order is the base (p9 §2.1): its located places, in order, give the ranks.
    const planned = timing ? planDayOrder({
      frame: timing.frame, stops: candidates.map((place) => timelineStop(place, timing)), transit: null,
      base: locatedCandidates.map((place) => timelineStop(place, timing)),
      ranks: new Map(locatedCandidates.map((place, index) => [place.id, index])),
      start: morning, end: night, distanceOrder: orderByStraightLine,
    }) : null;
    if (planned?.orderedIds) {
      orderedLocated = planned.orderedIds.map((id) => plannedById.get(id)! as RoutePlace & GeoPoint);
    } else {
      const suggested = orderByStraightLine(locatedCandidates, morning, night)
        .map((id) => plannedById.get(id)! as RoutePlace & GeoPoint);
      // Compare exactly what the client displays: rounded known legs, with no end leg after an
      // unlocated tail. This also protects heuristic days from a longer suggestion.
      if (
        displayedTotalMeters(suggested, morning, night, unlocated.length > 0)
        <= displayedTotalMeters(locatedCandidates, morning, night, unlocated.length > 0)
      ) {
        orderedLocated = suggested;
      }
    }
    // No timing at all is p9's no_frame; a day with nothing to order says nothing.
    orderBasis = planned ? planned.orderBasis : "distance";
    orderReason = planned ? planned.orderReason : "no_frame";
  }
  const orderedPlaces = [...orderedLocated, ...unlocated];

  const stops = orderedPlaces.map((place, index) => {
    const previous = index === 0 ? morning : orderedPlaces[index - 1]!;
    const metersFromPrevious = previous && located(previous) && located(place)
      ? Math.round(straightLineMeters(previous, place))
      : null;
    const facts = timing?.places.get(place.id);
    return {
      tripPlaceId: place.id,
      name: place.name,
      latitude: place.latitude,
      longitude: place.longitude,
      providerPlaceId: place.providerPlaceId,
      metersFromPrevious,
      minutesFromPrevious: null,
      linesFromPrevious: [],
      estimatedMoveMinutesFromPrevious: timing && metersFromPrevious !== null ? timing.moveMinutes(metersFromPrevious) : null,
      stayMinutes: facts?.stayMinutes ?? null,
      stayEstimated: facts?.stayEstimated ?? false,
    };
  });
  const last = orderedPlaces.at(-1);
  const metersToEnd = last && night && located(last) ? Math.round(straightLineMeters(last, night)) : null;
  const totalMeters = stops.reduce((total, stop) => total + (stop.metersFromPrevious ?? 0), metersToEnd ?? 0);

  return {
    dayId: input.dayId,
    date: input.date,
    version: input.version,
    order,
    orderedTripPlaceIds: orderedPlaces.map((place) => place.id),
    startsAt: start
      ? { placeId: start.id, name: start.name, latitude: start.latitude, longitude: start.longitude, providerPlaceId: start.providerPlaceId }
      : null,
    endsAt: end
      ? { placeId: end.id, name: end.name, latitude: end.latitude, longitude: end.longitude, providerPlaceId: end.providerPlaceId }
      : null,
    stops,
    metersToEnd,
    totalMeters,
    travelSource: "straight_line",
    transitProvider: null,
    routeShapesAvailable: false,
    minutesToEnd: null,
    linesToEnd: [],
    totalMinutes: null,
    transitMatrix: [],
    transitCallsNeeded: 0,
    transitCacheDays: null,
    dayStartMinute: timing?.dayStartMinute ?? null,
    fixedMinutes: timing?.fixedMinutes ?? null,
    estimatedMoveMinutesToEnd: timing && metersToEnd !== null ? timing.moveMinutes(metersToEnd) : null,
    frame: timing?.frame ?? null,
    orderBasis,
    orderReason,
  };
}
