import type { DayRouteDto, DayRouteShapesResponse, TransitProvider } from "@along-the-way/contracts/day-plans";

export const BUS_LIKELY_LEG_MIN_METERS = 1_500;

type ShapeLeg = DayRouteShapesResponse["legs"][number];
type CoordinatePoint = { latitude: number; longitude: number };

export interface BusLikelyShapeLeg {
  key: string;
  midpoint: { lat: number; lng: number };
}

export function routeLegKey(fromId: string, toId: string) {
  return `${fromId}:${toId}`;
}

function straightLineMeters(from: CoordinatePoint, to: CoordinatePoint) {
  const toRadians = Math.PI / 180;
  const latitudeDelta = (to.latitude - from.latitude) * toRadians;
  const longitudeDelta = (to.longitude - from.longitude) * toRadians;
  const fromLatitude = from.latitude * toRadians;
  const toLatitude = to.latitude * toRadians;
  const chord = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(fromLatitude) * Math.cos(toLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  const arc = Math.min(1, chord);
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(arc), Math.sqrt(1 - arc));
}

function routePoints(route: DayRouteDto) {
  const points = new Map<string, CoordinatePoint>();
  const add = (id: string, point: { latitude: number | null; longitude: number | null }) => {
    if (point.latitude !== null && point.longitude !== null) {
      points.set(id, { latitude: point.latitude, longitude: point.longitude });
    }
  };
  if (route.startsAt) add(route.startsAt.placeId, route.startsAt);
  for (const stop of route.stops) add(stop.tripPlaceId, stop);
  if (route.endsAt) add(route.endsAt.placeId, route.endsAt);
  return points;
}

/** NAVITIME can return a long walk because its RapidAPI product omits bus route data. */
export function busLikelyShapeLegs(
  route: DayRouteDto,
  shapes: DayRouteShapesResponse["legs"],
): BusLikelyShapeLeg[] {
  if (route.transitProvider !== "navitime") return [];
  const points = routePoints(route);
  const matches: BusLikelyShapeLeg[] = [];
  for (const leg of shapes) {
    const features = leg.geojson?.features;
    if (!features?.length || features.some((feature) => feature.properties.ways === "transport")) continue;
    const from = points.get(leg.fromId);
    const to = points.get(leg.toId);
    if (!from || !to || straightLineMeters(from, to) < BUS_LIKELY_LEG_MIN_METERS) continue;
    matches.push({
      key: routeLegKey(leg.fromId, leg.toId),
      midpoint: {
        lat: (from.latitude + to.latitude) / 2,
        lng: (from.longitude + to.longitude) / 2,
      },
    });
  }
  return matches;
}

/** Minute rows: walk-only NAVITIME minutes over the same unrounded straight line the map uses. */
export function isBusLikelyMinutesLeg(
  provider: TransitProvider | null,
  from: { latitude: number | null; longitude: number | null },
  to: { latitude: number | null; longitude: number | null },
  minutes: number | null,
  lines: string[],
) {
  if (provider !== "navitime" || minutes === null || lines.length > 0) return false;
  if (from.latitude === null || from.longitude === null || to.latitude === null || to.longitude === null) return false;
  return straightLineMeters(
    { latitude: from.latitude, longitude: from.longitude },
    { latitude: to.latitude, longitude: to.longitude },
  ) >= BUS_LIKELY_LEG_MIN_METERS;
}
