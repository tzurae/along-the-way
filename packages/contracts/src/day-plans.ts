import { isRecord } from "./type-guards";

/** `current` is saved order, `suggested` minimizes travel cost, `custom` is member-arranged. */
export type DayRouteOrder = "current" | "suggested" | "custom";

export type TransitProvider = "navitime" | "google_routes";
export type TransitNotice = "navitime_quota" | "navitime_unavailable" | "transit_quota" | "transit_unavailable";

/** Same bound as the arrangement writer, so an existing large day remains reorderable. */
export const MAX_DAY_ROUTE_STOPS = 100;

export interface CreateDayRouteInput {
  order: DayRouteOrder;
  /** Only suggested may fetch missing transit data; omitted means cached, never a paid call. */
  transit?: "cached" | "fetch";
  /** Required with transit=fetch: confirmed paid units (Google matrix elements, NAVITIME calls). */
  maxTransitCalls?: number;
  /** Only with `custom`: this day's places in the wanted order, each once. Omitting one previews taking it off the day. */
  orderedTripPlaceIds?: string[];
}

/** A lodging the route starts or ends at. */
export interface DayRouteLodgingDto {
  placeId: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  /** Google place ID when known, so a Maps link names the place instead of showing coordinates. */
  providerPlaceId: string | null;
}

export interface DayRouteStopDto {
  tripPlaceId: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  /** Google place ID when known, so a Maps link names the place instead of showing coordinates. */
  providerPlaceId: string | null;
  /** Straight-line metres (rounded integer) from the previous point (startsAt lodging, else previous stop); null when either point lacks coordinates or there is no previous point. */
  metersFromPrevious: number | null;
  minutesFromPrevious: number | null;
  /** Empty for a walk-only leg. */
  linesFromPrevious: string[];
  /** Straight-line move estimate for the leg from the previous point, with the day's planning settings (same formula as day load); null when metersFromPrevious is null. */
  estimatedMoveMinutesFromPrevious: number | null;
  /** Minutes spent at this stop: member-entered, else AI or type default; 0 for stations and airports. Null from an older API. */
  stayMinutes: number | null;
  /** True when stayMinutes is not member-entered (AI or type default). */
  stayEstimated: boolean;
}

export interface DayRouteDto {
  dayId: string;
  date: string;
  /** trip_days version; the expectedVersion for PUT place-order / arrangement. */
  version: number;
  order: DayRouteOrder;
  /** Every planned place in route order; located places first (ordered), places without coordinates appended in their saved order. Saving stores exactly this. */
  orderedTripPlaceIds: string[];
  /** The morning's lodging, where the day starts; null when none. */
  startsAt: DayRouteLodgingDto | null;
  /** That night's lodging, where the day ends; null when none. */
  endsAt: DayRouteLodgingDto | null;
  stops: DayRouteStopDto[];
  /** Straight-line metres from the last stop to endsAt; null when unknown or no endsAt. */
  metersToEnd: number | null;
  /** Sum of all non-null legs including metersToEnd. */
  totalMeters: number;
  travelSource: TransitProvider | "straight_line";
  travelNotice?: TransitNotice;
  /** Selected provider, including before minutes are fetched or after a failure. */
  transitProvider: TransitProvider | null;
  /** A transit provider is configured and applicable, independently of matrix success. */
  routeShapesAvailable: boolean;
  minutesToEnd: number | null;
  linesToEnd: string[];
  totalMinutes: number | null;
  transitMatrix: TransitMatrixEntry[];
  /** NAVITIME missing coordinate pairs, or the full Google matrix element count (never cached). */
  transitCallsNeeded: number;
  /** Fresh cached minutes cover the matrix; the value is the cache validity window in days. */
  transitCacheDays: number | null;
  /** Local minutes after midnight the day starts (planning settings with this day's override); null from an older API. */
  dayStartMinute: number | null;
  /** Minutes of the day's timed fixed items inside its planning window, as the day load counts them; null from an older API. */
  fixedMinutes: number | null;
  /** Straight-line move estimate from the last stop to endsAt; null when metersToEnd is null. */
  estimatedMoveMinutesToEnd: number | null;
}

export interface DayRouteResponse {
  route: DayRouteDto;
}

export interface TransitMatrixEntry {
  fromId: string;
  toId: string;
  /** Null only when parsing an older response; such an entry cannot supply travel minutes. */
  fromLatitude: number | null;
  fromLongitude: number | null;
  toLatitude: number | null;
  toLongitude: number | null;
  minutes: number;
  lines: string[];
}

export interface TransitGeoJson {
  type: "FeatureCollection";
  features: {
    type: "Feature";
    geometry:
      | { type: "LineString"; coordinates: [number, number][] }
      | { type: "MultiLineString"; coordinates: [number, number][][] };
    properties: { ways: "walk" | "transport"; inline: { color: string | null } };
  }[];
}

export interface DayRouteShapesResponse {
  legs: { fromId: string; toId: string; geojson: TransitGeoJson | null }[];
  travelNotice?: TransitNotice;
}

function invalid(): never {
  throw new Error("Invalid day route response");
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : invalid();
}

function text(value: unknown): string {
  return typeof value === "string" ? value : invalid();
}

function integer(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : invalid();
}

function nullableInteger(value: unknown): number | null {
  return value === null ? null : integer(value);
}

function nullableNumber(value: unknown): number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value)) ? value : invalid();
}

function nullableText(value: unknown): string | null {
  return value === null ? null : text(value);
}

function point(value: unknown): DayRouteLodgingDto | null {
  if (value === null) return null;
  const entry = record(value);
  return {
    placeId: text(entry.placeId),
    name: text(entry.name),
    latitude: nullableNumber(entry.latitude),
    longitude: nullableNumber(entry.longitude),
    providerPlaceId: nullableText(entry.providerPlaceId),
  };
}

function stop(value: unknown): DayRouteStopDto {
  const entry = record(value);
  return {
    tripPlaceId: text(entry.tripPlaceId),
    name: text(entry.name),
    latitude: nullableNumber(entry.latitude),
    longitude: nullableNumber(entry.longitude),
    providerPlaceId: nullableText(entry.providerPlaceId),
    metersFromPrevious: nullableInteger(entry.metersFromPrevious),
    minutesFromPrevious: nullableInteger(entry.minutesFromPrevious ?? null),
    linesFromPrevious: texts(entry.linesFromPrevious ?? []),
    estimatedMoveMinutesFromPrevious: nullableInteger(entry.estimatedMoveMinutesFromPrevious ?? null),
    stayMinutes: nullableInteger(entry.stayMinutes ?? null),
    stayEstimated: entry.stayEstimated === undefined ? false
      : typeof entry.stayEstimated === "boolean" ? entry.stayEstimated : invalid(),
  };
}

function order(value: unknown): DayRouteOrder {
  return value === "current" || value === "suggested" || value === "custom" ? value : invalid();
}

function transitProvider(value: unknown): TransitProvider | null {
  return value == null ? null : value === "navitime" || value === "google_routes" ? value : invalid();
}

function transitNotice(value: unknown): TransitNotice {
  return value === "navitime_quota" || value === "navitime_unavailable"
    || value === "transit_quota" || value === "transit_unavailable" ? value : invalid();
}

function route(value: unknown): DayRouteDto {
  const entry = record(value);
  return {
    dayId: text(entry.dayId),
    date: text(entry.date),
    version: integer(entry.version),
    order: order(entry.order),
    orderedTripPlaceIds: Array.isArray(entry.orderedTripPlaceIds)
      ? entry.orderedTripPlaceIds.map(text)
      : invalid(),
    startsAt: point(entry.startsAt),
    endsAt: point(entry.endsAt),
    stops: Array.isArray(entry.stops) ? entry.stops.map(stop) : invalid(),
    metersToEnd: nullableInteger(entry.metersToEnd),
    totalMeters: integer(entry.totalMeters),
    travelSource: entry.travelSource === undefined || entry.travelSource === "straight_line"
      ? "straight_line" : transitProvider(entry.travelSource) ?? invalid(),
    ...(entry.travelNotice === undefined ? {} : { travelNotice: transitNotice(entry.travelNotice) }),
    transitProvider: transitProvider(entry.transitProvider),
    routeShapesAvailable: entry.routeShapesAvailable === undefined ? false
      : typeof entry.routeShapesAvailable === "boolean" ? entry.routeShapesAvailable : invalid(),
    minutesToEnd: nullableInteger(entry.minutesToEnd ?? null),
    linesToEnd: texts(entry.linesToEnd ?? []),
    totalMinutes: nullableInteger(entry.totalMinutes ?? null),
    transitCallsNeeded: integer(entry.transitCallsNeeded ?? 0),
    transitCacheDays: nullableInteger(entry.transitCacheDays ?? null),
    dayStartMinute: nullableInteger(entry.dayStartMinute ?? null),
    fixedMinutes: nullableInteger(entry.fixedMinutes ?? null),
    estimatedMoveMinutesToEnd: nullableInteger(entry.estimatedMoveMinutesToEnd ?? null),
    transitMatrix: entry.transitMatrix === undefined ? [] : Array.isArray(entry.transitMatrix)
      ? entry.transitMatrix.map((value) => {
        const leg = record(value);
        return {
          fromId: text(leg.fromId), toId: text(leg.toId), minutes: integer(leg.minutes), lines: texts(leg.lines),
          fromLatitude: nullableNumber(leg.fromLatitude ?? null),
          fromLongitude: nullableNumber(leg.fromLongitude ?? null),
          toLatitude: nullableNumber(leg.toLatitude ?? null),
          toLongitude: nullableNumber(leg.toLongitude ?? null),
        };
      }) : invalid(),
  };
}

export function parseDayRouteResponse(value: unknown): DayRouteResponse {
  return { route: route(record(value).route) };
}

function texts(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text) : invalid();
}

/** Reordering checks the coordinate snapshot; Google results live only in this open dialog. */
export function withTransitMatrix(route: DayRouteDto, matrix: TransitMatrixEntry[], provider: TransitProvider): DayRouteDto {
  const points = new Map<string, { latitude: number | null; longitude: number | null }>(
    route.stops.map((stop) => [stop.tripPlaceId, stop]),
  );
  if (route.startsAt) points.set(route.startsAt.placeId, route.startsAt);
  if (route.endsAt) points.set(route.endsAt.placeId, route.endsAt);
  const byFrom = new Map<string, Map<string, TransitMatrixEntry>>();
  for (const leg of matrix) {
    const from = points.get(leg.fromId);
    const to = points.get(leg.toId);
    if (!from || !to || from.latitude === null || from.longitude === null || to.latitude === null || to.longitude === null
      || from.latitude !== leg.fromLatitude || from.longitude !== leg.fromLongitude
      || to.latitude !== leg.toLatitude || to.longitude !== leg.toLongitude) continue;
    if (!byFrom.has(leg.fromId)) byFrom.set(leg.fromId, new Map());
    byFrom.get(leg.fromId)!.set(leg.toId, leg);
  }
  let total = 0;
  let complete = true;
  const stops = route.stops.map((stop, index) => {
    const from = index === 0 ? route.startsAt?.placeId : route.stops[index - 1]!.tripPlaceId;
    const leg = from ? byFrom.get(from)?.get(stop.tripPlaceId) : undefined;
    if (from && !leg) complete = false;
    total += leg?.minutes ?? 0;
    return { ...stop, minutesFromPrevious: leg?.minutes ?? null, linesFromPrevious: leg?.lines ?? [] };
  });
  const last = stops.at(-1);
  const end = last && route.endsAt ? byFrom.get(last.tripPlaceId)?.get(route.endsAt.placeId) : undefined;
  if (last && route.endsAt && !end) complete = false;
  total += end?.minutes ?? 0;
  return {
    ...route, stops, travelSource: provider, transitProvider: provider, transitMatrix: matrix,
    minutesToEnd: end?.minutes ?? null, linesToEnd: end?.lines ?? [],
    totalMinutes: complete ? total : null,
  };
}

export function parseTransitGeoJson(value: unknown): TransitGeoJson {
  const collection = record(value);
  if (collection.type !== "FeatureCollection" || !Array.isArray(collection.features)) return invalid();
  const position = (value: unknown): [number, number] => {
    if (!Array.isArray(value) || value.length < 2) return invalid();
    const [longitude, latitude] = value;
    if (typeof longitude !== "number" || !Number.isFinite(longitude) || Math.abs(longitude) > 180
      || typeof latitude !== "number" || !Number.isFinite(latitude) || Math.abs(latitude) > 90) return invalid();
    return [longitude, latitude];
  };
  const line = (value: unknown) => Array.isArray(value) && value.length >= 2 ? value.map(position) : invalid();
  const features: TransitGeoJson["features"] = [];
  for (const value of collection.features) {
    const feature = record(value);
    if (feature.type !== "Feature") return invalid();
    const geometry = record(feature.geometry);
    if (geometry.type !== "LineString" && geometry.type !== "MultiLineString") continue;
    const properties = record(feature.properties);
    if (properties.ways !== "walk" && properties.ways !== "transport") return invalid();
    const inline = properties.inline == null ? {} : record(properties.inline);
    features.push({
      type: "Feature",
      geometry: geometry.type === "LineString"
        ? { type: "LineString", coordinates: line(geometry.coordinates) }
        : { type: "MultiLineString", coordinates: Array.isArray(geometry.coordinates) ? geometry.coordinates.map(line) : invalid() },
      properties: {
        ways: properties.ways,
        inline: { color: typeof inline.color === "string" && /^#[0-9a-f]{6}$/i.test(inline.color) ? inline.color : null },
      },
    });
  }
  if (features.length === 0) return invalid();
  return { type: "FeatureCollection", features };
}

export function parseDayRouteShapesResponse(value: unknown): DayRouteShapesResponse {
  const entry = record(value);
  if (!Array.isArray(entry.legs)) return invalid();
  return { ...(entry.travelNotice === undefined ? {} : { travelNotice: transitNotice(entry.travelNotice) }), legs: entry.legs.map((value) => {
    const leg = record(value);
    return {
      fromId: text(leg.fromId), toId: text(leg.toId),
      geojson: leg.geojson === null ? null : parseTransitGeoJson(leg.geojson),
    };
  }) };
}
