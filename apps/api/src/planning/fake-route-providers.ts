import { Temporal } from "@js-temporal/polyfill";
import type {
  RouteLocation,
  RouteMode,
  RouteObservation,
  RouteObservationProvider,
  RouteObservationQuery,
} from "@along-the-way/contracts/planning-observations";
import type {
  OpeningPeriod,
  PlaceHoursLookup,
  PlaceOpeningHours,
} from "./opening-hours";

interface FakeRouteProviderOptions {
  now?: () => Date;
}

const EARTH_RADIUS_KM = 6_371;
const FRESHNESS_MS = 15 * 60 * 1_000;

function validateLocation(location: RouteLocation) {
  if (!location || typeof location.placeId !== "string" || !location.placeId.trim()) {
    throw new TypeError("Route locations require a place ID");
  }
  const { latitude, longitude } = location;
  if ((latitude !== null && (typeof latitude !== "number" || !Number.isFinite(latitude) || Math.abs(latitude) > 90))
    || (longitude !== null && (typeof longitude !== "number" || !Number.isFinite(longitude) || Math.abs(longitude) > 180))) {
    throw new TypeError("Route coordinates must be valid degrees or null");
  }
}

function straightLineKilometers(origin: RouteLocation, destination: RouteLocation) {
  const toRadians = Math.PI / 180;
  const originLatitude = origin.latitude! * toRadians;
  const destinationLatitude = destination.latitude! * toRadians;
  const latitudeDelta = destinationLatitude - originLatitude;
  const longitudeDelta = (destination.longitude! - origin.longitude!) * toRadians;
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(originLatitude) * Math.cos(destinationLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  const bounded = Math.max(0, Math.min(1, haversine));
  return 2 * EARTH_RADIUS_KM * Math.atan2(Math.sqrt(bounded), Math.sqrt(1 - bounded));
}

/**
 * Offline route estimates for local development and browser E2E:
 * walking is straight-line distance at 4.8 km/h; transit adds 8 boarding minutes and travels
 * at 30 km/h, but is offered only above 0.8 km; driving adds 3 minutes and travels at 40 km/h.
 * Every estimate rounds up to a whole minute and performs no network requests.
 */
export class FakeRouteProvider implements RouteObservationProvider {
  private readonly now: () => Date;

  constructor(options: FakeRouteProviderOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async observe(query: RouteObservationQuery): Promise<RouteObservation[]> {
    validateLocation(query.origin);
    validateLocation(query.destination);
    let departureTime: string;
    try {
      departureTime = Temporal.Instant.from(query.departureTime).toString();
    } catch {
      throw new TypeError("Route departure time must be a valid offset-bearing instant");
    }

    const origin = { ...query.origin };
    const destination = { ...query.destination };
    const modes = query.modes ?? ["walking", "transit"];
    if (origin.latitude === null || origin.longitude === null
      || destination.latitude === null || destination.longitude === null) {
      return modes.map((mode) => this.unavailable(origin, destination, departureTime, mode, "location_unknown"));
    }

    const distanceKilometers = straightLineKilometers(origin, destination);
    const distanceMeters = Math.round(distanceKilometers * 1_000);
    return modes.map((mode) => {
      if (mode === "transit" && distanceKilometers <= 0.8) {
        return this.unavailable(origin, destination, departureTime, mode, "no_route");
      }
      const durationMinutes = Math.ceil(mode === "walking"
        ? distanceKilometers / 4.8 * 60
        : mode === "transit"
          ? 8 + distanceKilometers / 30 * 60
          : 3 + distanceKilometers / 40 * 60);
      return {
        ...this.source(origin, destination, departureTime, mode),
        status: "available" as const,
        durationMinutes,
        distanceMeters,
        walkingLegMinutes: mode === "walking" ? [durationMinutes] : [],
        manualChecks: [],
        warnings: [],
      };
    });
  }

  private source(origin: RouteLocation, destination: RouteLocation, departureTime: string, mode: RouteMode) {
    const observedAt = this.now();
    return {
      originPlaceId: origin.placeId,
      destinationPlaceId: destination.placeId,
      requestedDepartureTime: departureTime,
      mode,
      provider: "fake",
      attribution: "Fake routes",
      observedAt: observedAt.toISOString(),
      expiresAt: new Date(observedAt.getTime() + FRESHNESS_MS).toISOString(),
    };
  }

  private unavailable(
    origin: RouteLocation,
    destination: RouteLocation,
    departureTime: string,
    mode: RouteMode,
    reason: "location_unknown" | "no_route",
  ): RouteObservation {
    return {
      ...this.source(origin, destination, departureTime, mode),
      status: "unavailable",
      reason,
      durationMinutes: null,
      distanceMeters: null,
      walkingLegMinutes: null,
    };
  }
}

function hash(value: string) {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return result >>> 0;
}

function dailyPeriods(openHour: number, closeHour: number, closedDay?: number): OpeningPeriod[] {
  return Array.from({ length: 7 }, (_, day) => day)
    .filter((day) => day !== closedDay)
    .map((day) => ({
      open: { day, hour: openHour, minute: 0, date: null },
      close: { day, hour: closeHour, minute: 0, date: null },
    }));
}

/** Stable fake hours selected from four weekly patterns by the provider place ID; no network is used. */
export class FakePlaceHours implements PlaceHoursLookup {
  async openingHours(providerPlaceId: string): Promise<PlaceOpeningHours> {
    const value = hash(providerPlaceId);
    let regular: OpeningPeriod[];
    switch (value % 4) {
      case 0:
        regular = dailyPeriods(9, 17);
        break;
      case 1:
        regular = dailyPeriods(10, 20);
        break;
      case 2:
        regular = [{ open: { day: 0, hour: 0, minute: 0, date: null }, close: null }];
        break;
      default:
        regular = dailyPeriods(9, 17, (value >>> 2) % 7);
        break;
    }
    return { businessStatus: "operational", regular, current: null };
  }
}
