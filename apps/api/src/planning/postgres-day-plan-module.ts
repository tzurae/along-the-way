import { Temporal } from "@js-temporal/polyfill";
import {
  MAX_DAY_ROUTE_STOPS,
  withTransitMatrix,
  type CreateDayRouteInput,
  type DayRouteDto,
  type DayRouteShapesResponse,
  type TransitMatrixEntry,
  type TransitGeoJson,
  type TransitProvider,
} from "@along-the-way/contracts/day-plans";
import { estimatedMoveMinutes } from "@along-the-way/contracts/day-timeline";
import type { TripPlaceDto } from "@along-the-way/contracts/trip-places";
import type { TripSkeletonDto } from "@along-the-way/contracts/trip-skeleton";
import type { Kysely, Transaction } from "kysely";

import type { AlongTheWayDatabase } from "../database/database";
import { AppError } from "../private-trips/private-trip-module";
import {
  lockMutation,
  recordEvent,
  remember,
  replayed,
  requireDayVersion,
  requireIdempotencyKey,
  requireScheduler,
} from "../private-trips/postgres-private-trip-store";
import type { TripPlaceModule } from "../trip-places/trip-place-module";
import type { TripSkeletonModule } from "../trip-skeleton/trip-skeleton-module";
import { computePlanningWindow } from "./day-load";
import { planDayOrder } from "./day-order";
import { buildDayFrame } from "./day-frame";
import { buildDayRoute, timelineStop, type DayRouteInput, type DayRouteTiming, type RoutePlace } from "./day-route";
import { orderByCost, routeLength, type GeoPoint } from "./day-route-order";
import { NavitimeError, type NavitimeProvider } from "./navitime-provider";
import type { GoogleRoutesProvider } from "./google-routes-provider";
import { mapTransitLegs, TransitError } from "./transit-batch";
import { PostgresTransitLegCache, TRANSIT_CACHE_DAYS, transitLegKey } from "./postgres-transit-leg-cache";
import { buildPlanningSnapshot, PLACE_ESTIMATE_DEFAULTS_V1 } from "./planning-snapshot";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ApplyDayPlaceOrderInput {
  expectedVersion: number;
  orderedTripPlaceIds: string[];
}

interface DayPlaceOrderResponse {
  orderedTripPlaceIds: string[];
  version: number;
}

export interface DayPlanModule {
  route(userId: string, tripId: string, dayId: string, input: CreateDayRouteInput): Promise<DayRouteDto>;
  routeShapes(userId: string, tripId: string, dayId: string, orderedTripPlaceIds: string[]): Promise<DayRouteShapesResponse>;
  applyOrder(
    userId: string,
    tripId: string,
    dayId: string,
    idempotencyKey: string,
    input: ApplyDayPlaceOrderInput,
  ): Promise<DayPlaceOrderResponse>;
}

interface ModuleOptions {
  database: Kysely<AlongTheWayDatabase>;
  tripSkeleton: TripSkeletonModule;
  tripPlaces: TripPlaceModule;
  navitime?: NavitimeProvider;
  googleRoutes?: GoogleRoutesProvider;
}

/** Applied order first; places without one keep their list order after them. */
function byDayPosition(left: TripPlaceDto, right: TripPlaceDto): number {
  if (left.dayPosition === right.dayPosition) return 0;
  if (left.dayPosition === null) return 1;
  if (right.dayPosition === null) return -1;
  return left.dayPosition - right.dayPosition;
}

/** A booked stay for this night, whether or not its hotel has map coordinates. */
function bookedLodgingForNight(skeleton: TripSkeletonDto, date: string) {
  for (const item of skeleton.items) {
    if (item.type !== "lodging") continue;
    const start = item.endpoints.find((endpoint) => endpoint.role === "start");
    const end = item.endpoints.find((endpoint) => endpoint.role === "end");
    if (
      !start
      || !end
      || start.localDateTime.slice(0, 10) > date
      || end.localDateTime.slice(0, 10) <= date
    ) {
      continue;
    }
    const place = skeleton.places.find((entry) => entry.id === start.placeId);
    if (place) return place;
  }
  return null;
}

function located(place: RoutePlace): place is RoutePlace & GeoPoint {
  return place.latitude !== null && place.longitude !== null;
}

type CountryStop = { id: string; country_code: string; time_zone: string | null };

/**
 * Days have no country-stop column. Resolve from booked nights and dated itinerary endpoints;
 * ambiguous/cross-border days fail closed. A single-country trip needs no booked travel.
 */
function dayCountries(
  skeleton: TripSkeletonDto,
  date: string,
  countries: CountryStop[],
): CountryStop[] {
  const ids = new Set<string>();
  const previousDate = Temporal.PlainDate.from(date).subtract({ days: 1 }).toString();
  for (const item of skeleton.items) {
    if (item.type === "lodging") {
      const start = item.endpoints.find((entry) => entry.role === "start");
      const end = item.endpoints.find((entry) => entry.role === "end");
      if (start?.countryStopId && end && start.localDateTime.slice(0, 10) <= date
        && end.localDateTime.slice(0, 10) > previousDate) ids.add(start.countryStopId);
    }
    for (const endpoint of item.endpoints) {
      if (endpoint.localDateTime.slice(0, 10) !== date) continue;
      if (endpoint.countryStopId === null) return [];
      ids.add(endpoint.countryStopId);
    }
  }
  if (ids.size === 0) {
    const latest = skeleton.items.filter((item) => item.type === "flight" || item.type === "transport")
      .flatMap((item) => item.endpoints)
      .filter((endpoint) => endpoint.localDateTime.slice(0, 10) <= date)
      .sort((a, b) => b.instant.localeCompare(a.instant))[0];
    if (latest) {
      if (latest.countryStopId === null) return [];
      ids.add(latest.countryStopId);
    }
  }
  const relevant = ids.size > 0 ? countries.filter((country) => ids.has(country.id)) : countries;
  return ids.size > 0 && relevant.length !== ids.size ? [] : relevant;
}

function dayIsInJapan(countries: CountryStop[], planned: TripPlaceDto[], relevant: CountryStop[]): boolean {
  if (relevant.length === 0 || relevant.some((country) => country.country_code !== "JP")) return false;
  // A known foreign stop's timezone on a day's point contradicts its Japan assignment.
  return !planned.some((place) => place.timeZone && countries.some((country) =>
    country.time_zone === place.timeZone && country.country_code !== "JP"));
}

/** A day has no timezone column. Prefer its places, then lodging/endpoints, then country stops. */
function dayTimeZone(skeleton: TripSkeletonDto, date: string, relevant: CountryStop[], planned: TripPlaceDto[]): string | null {
  const previousDate = Temporal.PlainDate.from(date).subtract({ days: 1 }).toString();
  const sources = [
    planned.map((place) => place.timeZone),
    [bookedLodgingForNight(skeleton, previousDate)?.timeZone, bookedLodgingForNight(skeleton, date)?.timeZone],
    skeleton.items.flatMap((item) => item.endpoints)
      .filter((endpoint) => endpoint.localDateTime.slice(0, 10) === date).map((endpoint) => endpoint.timeZone),
    relevant.map((country) => country.time_zone),
  ];
  for (const source of sources) {
    const zones = new Set(source.filter((zone): zone is string => Boolean(zone)));
    if (zones.size > 0) return zones.size === 1 ? [...zones][0]! : null;
  }
  return null;
}

/** Every writer takes the trip row before a day row, keeping the repository's lock order. */
async function lockTrip(transaction: Transaction<AlongTheWayDatabase>, tripId: string): Promise<void> {
  const trip = await transaction.selectFrom("trips")
    .select("id")
    .where("id", "=", tripId)
    .forUpdate()
    .executeTakeFirst();
  if (!trip) throw new AppError("trip_not_found", "Trip not found", 404);
}

export class PostgresDayPlanModule implements DayPlanModule {
  private readonly database: Kysely<AlongTheWayDatabase>;
  private readonly tripSkeleton: TripSkeletonModule;
  private readonly tripPlaces: TripPlaceModule;
  private readonly navitime: NavitimeProvider | undefined;
  private readonly googleRoutes: GoogleRoutesProvider | undefined;
  private readonly transitCache: PostgresTransitLegCache;

  constructor(options: ModuleOptions) {
    this.database = options.database;
    this.tripSkeleton = options.tripSkeleton;
    this.tripPlaces = options.tripPlaces;
    this.navitime = options.navitime;
    this.googleRoutes = options.googleRoutes;
    this.transitCache = new PostgresTransitLegCache(options.database);
  }

  private async routeInput(
    userId: string,
    tripId: string,
    dayId: string,
    input: CreateDayRouteInput,
    withTiming: boolean,
  ): Promise<{ input: DayRouteInput; transitProvider: TransitProvider | null; timeZone: string | null }> {
    const order = input?.order;
    if (order !== "current" && order !== "suggested" && order !== "custom") {
      throw new AppError("validation_error", "order must be current, suggested or custom");
    }
    if (input.transit !== undefined && (order !== "suggested" || (input.transit !== "cached" && input.transit !== "fetch"))) {
      throw new AppError("validation_error", "transit must be cached or fetch, and is only valid with suggested order");
    }
    if (
      (input.transit === "fetch" && (typeof input.maxTransitCalls !== "number"
        || !Number.isSafeInteger(input.maxTransitCalls) || input.maxTransitCalls < 0))
      || (input.transit !== "fetch" && input.maxTransitCalls !== undefined)
    ) {
      throw new AppError("validation_error", "maxTransitCalls must be a non-negative integer and is required only with transit=fetch");
    }
    if (order !== "custom" && input.orderedTripPlaceIds !== undefined) {
      throw new AppError("validation_error", "orderedTripPlaceIds is only valid with custom order");
    }
    if (order === "custom" && !Array.isArray(input.orderedTripPlaceIds)) {
      throw new AppError("validation_error", "orderedTripPlaceIds is required with custom order");
    }

    const normalizedDayId = dayId.toLowerCase();
    const beforeVersion = await this.dayVersion(userId, tripId, normalizedDayId);
    const [skeleton, places, countries, snapshot] = await Promise.all([
      this.tripSkeleton.getSkeleton(userId, tripId),
      this.tripPlaces.list(userId, tripId),
      this.navitime?.configured || this.googleRoutes?.configured
        ? this.database.selectFrom("trip_country_stops").select(["id", "country_code", "time_zone"])
          .where("trip_id", "=", tripId).execute()
        : Promise.resolve([]),
      // The day load's own sources (settings with this day's override, stored AI profiles, fixed items);
      // reading stored profiles never calls a model.
      withTiming ? buildPlanningSnapshot(this.database, tripId, { useAi: true }) : Promise.resolve(null),
    ]);
    const version = await this.dayVersion(userId, tripId, normalizedDayId);
    if (version !== beforeVersion) {
      throw new AppError("conflict", "The day changed while its route was being read", 409, undefined, version, normalizedDayId);
    }
    const day = skeleton.days.find((entry) => entry.id === normalizedDayId);
    if (!day) throw new AppError("trip_day_not_found", "Trip day not found", 404);

    const planned = places
      .filter((place) => place.assignedDayId === normalizedDayId && !place.scheduled)
      .sort(byDayPosition);
    const requestedIds = order === "custom"
      ? input.orderedTripPlaceIds!.map((id) => typeof id === "string" ? id.toLowerCase() : "")
      : [];
    const requested = new Set(requestedIds);
    const plannedById = new Map(planned.map((place) => [place.id, place]));
    if (
      order === "custom"
      && (requested.size !== requestedIds.length || requestedIds.some((id) => !plannedById.has(id)))
    ) {
      throw new AppError("validation_error", "orderedTripPlaceIds must list distinct places from this day");
    }
    if ((order === "custom" ? requestedIds.length : planned.length) > MAX_DAY_ROUTE_STOPS) {
      throw new AppError("validation_error", `A route may contain at most ${MAX_DAY_ROUTE_STOPS} stops`);
    }

    // Snapshot freshness is checked above before membership validation can misclassify a race.
    // Lodging comes from the itinerary, whose places carry no Google ID; a wishlist entry backed by
    // the same itinerary place supplies one when the hotel was also added from Google.
    const lodgingOn = (date: string) => {
      const lodging = bookedLodgingForNight(skeleton, date);
      if (!lodging) return null;
      const providerPlaceId = places.find((place) => place.legacyPlaceId === lodging.id && place.providerPlaceId)
        ?.providerPlaceId ?? null;
      return { place: { ...lodging, providerPlaceId } };
    };
    const planningDay = snapshot?.input.days.find((entry) => entry.id === normalizedDayId);
    let timing: DayRouteTiming | undefined;
    if (snapshot && planningDay) {
      const caps = planningDay.caps;
      // The day load's window: settings/override start, pushed past a landing plus its buffer.
      const planningWindow = computePlanningWindow(planningDay, caps);
      const start = Temporal.Instant.fromEpochMilliseconds(Math.round(planningWindow.windowStartMinute * 60_000)).toZonedDateTimeISO(planningDay.timeZone);
      timing = {
        dayStartMinute: Temporal.PlainDate.from(planningDay.date).until(start.toPlainDate()).days * 1440 + start.hour * 60 + start.minute,
        fixedMinutes: planningWindow.fixedOccupancyMinutes,
        places: new Map(planned.map((place) => {
          const facts = { type: place.type, mealRole: place.mealRole ?? null };
          // Stations and airports are transfer points, not visits.
          if (place.type === "station" || place.type === "airport") return [place.id, { ...facts, stayMinutes: 0, stayEstimated: false }];
          const estimate = snapshot.estimates[place.id];
          return [place.id, estimate
            ? { ...facts, stayMinutes: estimate.visitMinutes, stayEstimated: estimate.visitSource !== "member" }
            : { ...facts, stayMinutes: place.durationMinutes ?? PLACE_ESTIMATE_DEFAULTS_V1[place.type].visitMinutes, stayEstimated: place.durationMinutes === null }];
        })),
        moveMinutes: (metres) => estimatedMoveMinutes(metres, caps),
        // Fixed items and points are named here: the dialog has no itinerary of its own.
        frame: buildDayFrame(planningDay, new Map([
          ...skeleton.places.map((place) => [place.id, place.name] as const),
          ...skeleton.items.map((item) => [item.id, item.title] as const),
        ])),
      };
    }
    const routeInput: DayRouteInput = {
      dayId: normalizedDayId,
      date: day.date,
      version,
      order,
      planned,
      ...(order === "custom" ? { orderedIds: requestedIds } : {}),
      morningLodging: lodgingOn(Temporal.PlainDate.from(day.date).subtract({ days: 1 }).toString()),
      nightLodging: lodgingOn(day.date),
      ...(timing ? { timing } : {}),
    };
    const relevant = dayCountries(skeleton, day.date, countries);
    const routePlaces = order === "custom" ? planned.filter((place) => requested.has(place.id)) : planned;
    const japan = dayIsInJapan(countries, routePlaces, relevant);
    const countryCode = relevant[0]?.country_code;
    const knownNonJapan = countryCode && countryCode !== "JP"
      && relevant.every((country) => country.country_code === countryCode)
      && !routePlaces.some((place) => place.timeZone && countries.some((country) =>
        country.time_zone === place.timeZone && country.country_code !== countryCode));
    return {
      input: routeInput,
      transitProvider: japan ? (this.navitime?.configured ? "navitime" : null)
        : knownNonJapan && this.googleRoutes?.configured ? "google_routes" : null,
      timeZone: dayTimeZone(skeleton, day.date, relevant, routePlaces),
    };
  }

  async route(userId: string, tripId: string, dayId: string, request: CreateDayRouteInput): Promise<DayRouteDto> {
    const { input, transitProvider, timeZone } = await this.routeInput(userId, tripId, dayId, request, true);
    // Built only where it is returned: a suggested route runs the order search, and only once per request (p9 §2.8).
    let built: DayRouteDto | undefined;
    const fallback = () => built ??= { ...buildDayRoute(input), transitProvider, routeShapesAvailable: transitProvider !== null };
    if (!transitProvider || input.order === "current") return fallback();
    const selected = input.order === "custom" ? new Set(input.orderedIds) : null;
    const stops = input.planned.filter((place) => !selected || selected.has(place.id)).filter(located);
    const start = input.morningLodging?.place;
    const end = input.nightLodging?.place;
    const morning = start && located(start) ? start : null;
    const night = end && located(end) ? end : null;
    const pairs: { from: GeoPoint; to: GeoPoint }[] = [];
    const seen = new Set<string>();
    const add = (from: GeoPoint, to: GeoPoint) => {
      const key = `${from.id}:${to.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      pairs.push({ from, to });
    };
    for (const stop of stops) {
      if (morning) add(morning, stop);
      for (const other of stops) if (other.id !== stop.id) add(stop, other);
      if (night) add(stop, night);
    }
    const googlePairs = transitProvider === "google_routes" ? pairs.filter(({ from, to }) => from.id !== to.id) : [];
    let cached = new Map<string, { minutes: number; lines: string[] }>();
    const missing = new Map<string, { from: GeoPoint; to: GeoPoint }>();
    for (const pair of pairs) {
      if (pair.from.id !== pair.to.id) missing.set(transitLegKey(pair.from, pair.to), pair);
    }
    const matrixSnapshot = (): TransitMatrixEntry[] => pairs.flatMap(({ from, to }) => {
      const value = from.id === to.id ? { minutes: 0, lines: [] } : cached.get(transitLegKey(from, to));
      return value ? [{
        fromId: from.id, toId: to.id,
        fromLatitude: from.latitude, fromLongitude: from.longitude,
        toLatitude: to.latitude, toLongitude: to.longitude,
        ...value,
      }] : [];
    });
    try {
      let matrix: TransitMatrixEntry[];
      let allCached = false;
      if (transitProvider === "google_routes") {
        if (request.transit === "fetch" && googlePairs.length > request.maxTransitCalls!) {
          throw new AppError(
            "transit_calls_changed", "The required transit elements exceed the confirmed amount",
            409, undefined, undefined, undefined, undefined, googlePairs.length,
          );
        }
        if (request.transit !== "fetch") return { ...fallback(), transitCallsNeeded: googlePairs.length };
        matrix = googlePairs.length > 0 ? await this.googleRoutes!.matrix(googlePairs, input.date, timeZone) : [];
        matrix.push(...matrixSnapshot()); // Only zero-minute self legs; Google never reads or writes the DB cache.
      } else {
        cached = await this.transitCache.minutes(tripId, input.date);
        for (const key of cached.keys()) missing.delete(key);
        if (request.transit === "fetch" && missing.size > request.maxTransitCalls!) {
          throw new AppError(
            "transit_calls_changed", "The required transit calls exceed the confirmed amount",
            409, undefined, undefined, undefined, undefined, missing.size,
          );
        }
        allCached = missing.size === 0;
        if (input.order === "custom") {
          const matrix = matrixSnapshot();
          return matrix.length > 0
            ? withTransitMatrix({ ...fallback(), transitCacheDays: allCached ? TRANSIT_CACHE_DAYS : null }, matrix, transitProvider)
            : fallback();
        }
        if (!allCached && request.transit !== "fetch") {
          return { ...fallback(), transitCallsNeeded: missing.size, transitMatrix: matrixSnapshot() };
        }
        if (!allCached) {
          await mapTransitLegs([...missing], async ([key, { from, to }], signal) => {
            const value = await this.navitime!.transit(from, to, input.date, signal);
            // Commit each success independently: a later leg's error must not discard paid results.
            await this.transitCache.saveMinutes(tripId, input.date, from, to, value);
            cached.set(key, value);
            missing.delete(key);
          });
        }
        matrix = matrixSnapshot();
      }
      const costs = new Map(matrix.map((leg) => [`${leg.fromId}:${leg.toId}`, leg.minutes]));
      const cost = (from: GeoPoint, to: GeoPoint) => costs.get(`${from.id}:${to.id}`)!;
      const byId = new Map(stops.map((stop) => [stop.id, stop]));
      // Meals first with the matrix minutes (p9 §2.8); the saved order is the base and the ranks.
      const timing = input.timing;
      const planned = timing ? planDayOrder({
        frame: timing.frame, stops: input.planned.map((place) => timelineStop(place, timing)),
        transit: (from, to) => costs.get(`${from}:${to}`) ?? null,
        base: stops.map((place) => timelineStop(place, timing)),
        ranks: new Map(stops.map((place, index) => [place.id, index])),
        start: morning, end: night, distanceOrder: (points, from, to) => orderByCost(points, from, to, cost, 7, true),
      }) : null;
      let chosen: GeoPoint[];
      if (planned?.orderedIds) {
        chosen = planned.orderedIds.map((id) => byId.get(id)!);
      } else {
        const suggested = orderByCost(stops, morning, night, cost, 7, true).map((id) => byId.get(id)!);
        chosen = routeLength(suggested, morning, night, cost) <= routeLength(stops, morning, night, cost) ? suggested : stops;
      }
      const route = buildDayRoute({
        ...input, order: "custom",
        orderedIds: [...chosen.map((stop) => stop.id), ...input.planned.filter((place) => !located(place)).map((place) => place.id)],
      });
      return withTransitMatrix({
        ...route, order: "suggested", routeShapesAvailable: true, transitProvider,
        orderBasis: planned ? planned.orderBasis : "distance", orderReason: planned ? planned.orderReason : "no_frame",
        transitCallsNeeded: googlePairs.length,
        transitCacheDays: allCached ? TRANSIT_CACHE_DAYS : null,
      }, matrix, transitProvider);
    } catch (error) {
      if (error instanceof AppError && error.code === "transit_calls_changed") throw error;
      return {
        ...fallback(), transitCallsNeeded: transitProvider === "google_routes" ? googlePairs.length
          : input.order === "suggested" ? missing.size : 0,
        transitMatrix: transitProvider === "google_routes" ? [] : matrixSnapshot(),
        travelNotice: transitProvider === "google_routes"
          ? error instanceof TransitError ? error.code : "transit_unavailable"
          : error instanceof NavitimeError ? error.code : "navitime_unavailable",
      };
    }
  }

  async routeShapes(userId: string, tripId: string, dayId: string, orderedTripPlaceIds: string[]): Promise<DayRouteShapesResponse> {
    const { input, transitProvider, timeZone } = await this.routeInput(userId, tripId, dayId, { order: "custom", orderedTripPlaceIds }, false);
    if (!transitProvider) throw new AppError("route_shapes_unavailable", "Transit route shapes are unavailable for this day", 422);
    const byId = new Map(input.planned.map((place) => [place.id, place]));
    // Keep the requested adjacency, including unlocated places; never bridge a missing point.
    const stops = input.orderedIds!.map((id) => byId.get(id)!);
    if (stops.length === 0) return { legs: [] };
    const points = [
      ...(input.morningLodging ? [input.morningLodging.place] : []),
      ...stops,
      ...(input.nightLodging ? [input.nightLodging.place] : []),
    ];
    const pairs = points.slice(1).map((to, index) => ({ from: points[index]!, to }));
    if (transitProvider === "google_routes") {
      const results = await mapTransitLegs(pairs, async ({ from, to }, signal) => {
        const leg = { fromId: from.id, toId: to.id, geojson: null };
        if (!located(from) || !located(to) || from.id === to.id) return { leg };
        try {
          const geojson = await this.googleRoutes!.shape(from, to, input.date, timeZone, signal);
          return { leg: { ...leg, geojson } };
        } catch (error) {
          return { leg, notice: error instanceof TransitError ? error.code : "transit_unavailable" as const };
        }
      }, ({ from, to }) => ({
        leg: { fromId: from.id, toId: to.id, geojson: null },
        notice: "transit_unavailable" as const,
      }));
      const travelNotice = results.find((result) => result.notice === "transit_quota")?.notice
        ?? results.find((result) => result.notice)?.notice;
      return { legs: results.map((result) => result.leg), ...(travelNotice ? { travelNotice } : {}) };
    }
    let cached: Map<string, TransitGeoJson>;
    try {
      cached = await this.transitCache.shapes(tripId, input.date);
    } catch {
      // An unreadable cache is not permission to spend quota re-fetching every leg.
      return { legs: pairs.map(({ from, to }) => ({ fromId: from.id, toId: to.id, geojson: null })) };
    }
    const missing = new Map<string, { from: GeoPoint; to: GeoPoint }>();
    for (const { from, to } of pairs) {
      if (!located(from) || !located(to)) continue;
      const key = transitLegKey(from, to);
      if (!cached.has(key)) missing.set(key, { from, to });
    }
    const fetched = await mapTransitLegs([...missing], async ([key, { from, to }], signal) => {
      try {
        const geojson = await this.navitime!.shape(from, to, input.date, signal);
        await this.transitCache.saveShape(tripId, input.date, from, to, geojson);
        return { key, geojson };
      } catch {
        return { key, geojson: null };
      }
    }, ([key]) => ({ key, geojson: null }));
    for (const { key, geojson } of fetched) if (geojson) cached.set(key, geojson);
    return { legs: pairs.map(({ from, to }) => ({
      fromId: from.id, toId: to.id,
      geojson: located(from) && located(to) ? cached.get(transitLegKey(from, to)) ?? null : null,
    })) };
  }

  async applyOrder(
    userId: string,
    tripId: string,
    dayId: string,
    rawKey: string,
    input: ApplyDayPlaceOrderInput,
  ): Promise<DayPlaceOrderResponse> {
    const ids = Array.isArray(input.orderedTripPlaceIds) ? input.orderedTripPlaceIds : null;
    if (!ids || ids.length === 0 || ids.length > MAX_DAY_ROUTE_STOPS || ids.some((id) => typeof id !== "string" || !UUID.test(id))) {
      throw new AppError("validation_error", `orderedTripPlaceIds must contain 1 to ${MAX_DAY_ROUTE_STOPS} place IDs`);
    }
    const orderedTripPlaceIds = ids.map((id) => id.toLowerCase());
    if (new Set(orderedTripPlaceIds).size !== orderedTripPlaceIds.length) {
      throw new AppError("validation_error", "orderedTripPlaceIds cannot repeat a place");
    }
    const day = dayId.toLowerCase();
    const key = requireIdempotencyKey(rawKey);
    const operation = `dpo:${tripId.toLowerCase()}:${day}`;
    return this.database.transaction().execute(async (transaction) => {
      await requireScheduler(transaction, userId, tripId);
      await lockMutation(transaction, userId, operation, key);
      const replay = await replayed(transaction, userId, operation, key);
      if (replay) return replay as DayPlaceOrderResponse;
      await lockTrip(transaction, tripId);
      await requireDayVersion(transaction, tripId, day, input.expectedVersion);
      const assignments = await transaction.selectFrom("trip_place_day_assignments")
        .select("trip_place_id")
        .where("trip_id", "=", tripId)
        .where("trip_day_id", "=", day)
        .forUpdate()
        .execute();
      const onDay = new Set(assignments.map((row) => row.trip_place_id));
      if (orderedTripPlaceIds.some((id) => !onDay.has(id))) {
        throw new AppError("conflict", "This day's places changed; plan the day again", 409);
      }
      await transaction.updateTable("trip_place_day_assignments").set({ day_position: null })
        .where("trip_id", "=", tripId).where("trip_day_id", "=", day).execute();
      for (const [position, id] of orderedTripPlaceIds.entries()) {
        await transaction.updateTable("trip_place_day_assignments").set({ day_position: position })
          .where("trip_place_id", "=", id).execute();
      }
      await recordEvent(transaction, {
        tripId,
        actorId: userId,
        eventType: "trip_day.places_ordered",
        targetType: "trip_day",
        targetId: day,
        summary: `Ordered ${orderedTripPlaceIds.length} planned places for a day`,
      });
      const saved = await transaction.selectFrom("trip_days").select("version").where("id", "=", day).executeTakeFirstOrThrow();
      const response = { orderedTripPlaceIds, version: saved.version };
      await remember(transaction, userId, operation, key, response);
      return response;
    });
  }

  private async dayVersion(userId: string, tripId: string, dayId: string): Promise<number> {
    const member = await this.database.selectFrom("trip_members")
      .select("id")
      .where("trip_id", "=", tripId)
      .where("user_id", "=", userId)
      .where("removed_at", "is", null)
      .executeTakeFirst();
    if (!member) throw new AppError("trip_not_found", "Trip not found", 404);
    const day = await this.database.selectFrom("trip_days")
      .select("version")
      .where("trip_id", "=", tripId)
      .where("id", "=", dayId)
      .executeTakeFirst();
    if (!day) throw new AppError("trip_day_not_found", "Trip day not found", 404);
    return day.version;
  }
}
