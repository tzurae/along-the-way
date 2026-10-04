import { Temporal } from "@js-temporal/polyfill";
import type {
  RouteLocation,
  RouteMode,
  RouteObservation,
  RouteObservationProvider,
  RouteObservationQuery,
  RouteUnavailableReason,
} from "@along-the-way/contracts/planning-observations";
import { isRecord } from "@along-the-way/contracts/private-trips";

interface GoogleRoutesProviderOptions {
  apiKey?: string;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  now?: () => Date;
  timeoutMs?: number;
}

const FRESHNESS_MS = 15 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
const NANOSECONDS_PER_MINUTE = 60_000_000_000n;
const MAX_DURATION_NANOSECONDS = 315_576_000_000_999_999_999n;
const FIELD_MASK = [
  "routes.duration",
  "routes.distanceMeters",
  "routes.warnings",
  "routes.legs.steps.travelMode",
  "routes.legs.steps.staticDuration",
].join(",");

function durationNanoseconds(value: unknown): bigint | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,12})(?:\.(\d{1,9}))?s$/.exec(value);
  if (!match) return null;
  const result = BigInt(match[1]!) * 1_000_000_000n
    + BigInt((match[2] ?? "").padEnd(9, "0"));
  return result <= MAX_DURATION_NANOSECONDS ? result : null;
}

function ceilMinutes(nanoseconds: bigint): number {
  // Keep protobuf fractions exact: Number(seconds) can erase a positive nanosecond.
  return Number((nanoseconds + NANOSECONDS_PER_MINUTE - 1n) / NANOSECONDS_PER_MINUTE);
}

function validateLocation(value: RouteLocation) {
  if (!value || typeof value.placeId !== "string" || !value.placeId.trim()) {
    throw new TypeError("Route locations require a place ID");
  }
  for (const [coordinate, bound] of [[value.latitude, 90], [value.longitude, 180]] as const) {
    if (coordinate !== null && (typeof coordinate !== "number" || !Number.isFinite(coordinate) || Math.abs(coordinate) > bound)) {
      throw new TypeError("Route coordinates must be valid degrees or null");
    }
  }
}

function walkingLegs(route: Record<string, unknown>): number[] | null {
  if (!Array.isArray(route.legs) || route.legs.length !== 1) return null;
  const leg: unknown = route.legs[0];
  if (!isRecord(leg) || !Array.isArray(leg.steps) || leg.steps.length === 0) return null;
  const result: number[] = [];
  let walkingNanoseconds = 0n;
  let walking = false;
  const finishWalking = () => {
    if (walking) result.push(ceilMinutes(walkingNanoseconds));
    walkingNanoseconds = 0n;
    walking = false;
  };
  for (const step of leg.steps) {
    if (!isRecord(step)) return null;
    if (step.travelMode === "WALK") {
      const duration = durationNanoseconds(step.staticDuration);
      if (duration === null) return null;
      walkingNanoseconds += duration;
      if (walkingNanoseconds > MAX_DURATION_NANOSECONDS) return null;
      walking = true;
    } else if (step.travelMode === "TRANSIT") {
      finishWalking();
    } else {
      return null;
    }
  }
  finishWalking();
  return result;
}

export class GoogleRoutesProvider implements RouteObservationProvider {
  private readonly apiKey: string | undefined;
  private readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  private readonly now: () => Date;
  private readonly timeoutMs: number;

  constructor(options: GoogleRoutesProviderOptions = {}) {
    this.apiKey = options.apiKey?.trim() || undefined;
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? 3_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new TypeError("Route timeout must be positive integer milliseconds");
    }
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
    // Copy the query before either network request; caller edits cannot rebind observations.
    const input = {
      origin: { ...query.origin },
      destination: { ...query.destination },
      departureTime,
    };
    return Promise.all([
      this.observeMode(input, "walking"),
      this.observeMode(input, "transit"),
    ]);
  }

  private async observeMode(query: RouteObservationQuery, mode: RouteMode): Promise<RouteObservation> {
    const source = () => {
      const observedAt = this.now();
      return {
        originPlaceId: query.origin.placeId,
        destinationPlaceId: query.destination.placeId,
        requestedDepartureTime: query.departureTime,
        mode,
        provider: "google",
        attribution: "Google Maps",
        observedAt: observedAt.toISOString(),
        expiresAt: new Date(observedAt.getTime() + FRESHNESS_MS).toISOString(),
      };
    };
    const unavailable = (reason: RouteUnavailableReason): RouteObservation => ({
      ...source(), status: "unavailable", reason,
      durationMinutes: null, distanceMeters: null, walkingLegMinutes: null,
    });
    if (query.origin.latitude === null || query.origin.longitude === null || query.destination.latitude === null || query.destination.longitude === null) {
      return unavailable("location_unknown");
    }
    if (!this.apiKey) return unavailable("provider_not_configured");
    const offset = Date.parse(query.departureTime) - this.now().getTime();
    if ((mode === "walking" && offset < 0) || (mode === "transit" && (offset < -7 * DAY_MS || offset > 100 * DAY_MS))) {
      return unavailable("unsupported_departure_time");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": this.apiKey,
          "X-Goog-FieldMask": FIELD_MASK,
        },
        body: JSON.stringify({
          origin: { location: { latLng: {
            latitude: query.origin.latitude, longitude: query.origin.longitude,
          } } },
          destination: { location: { latLng: {
            latitude: query.destination.latitude, longitude: query.destination.longitude,
          } } },
          travelMode: mode === "walking" ? "WALK" : "TRANSIT",
          departureTime: query.departureTime,
        }),
      });
      if (!response.ok) return unavailable(response.status === 429 ? "quota" : "provider_unavailable");
      const value: unknown = await response.json();
      if (!isRecord(value)) return unavailable("invalid_response");
      // Protobuf JSON omits repeated fields when empty: {} is a legitimate no-route response.
      if (value.routes === undefined || (Array.isArray(value.routes) && value.routes.length === 0)) {
        return unavailable("no_route");
      }
      if (!Array.isArray(value.routes) || value.routes.length !== 1 || !isRecord(value.routes[0])) {
        return unavailable("invalid_response");
      }
      const route = value.routes[0];
      const duration = durationNanoseconds(route.duration);
      // Protobuf JSON also omits zero scalars: a route between two coincident points has no distance.
      const distance = route.distanceMeters ?? 0;
      if (duration === null || !Number.isSafeInteger(distance) || (distance as number) < 0) {
        return unavailable("invalid_response");
      }
      if (route.warnings !== undefined && (!Array.isArray(route.warnings) || !route.warnings.every((warning) => typeof warning === "string"))) {
        return unavailable("invalid_response");
      }
      const durationMinutes = ceilMinutes(duration);
      const walkingLegMinutes = mode === "walking" ? [durationMinutes] : walkingLegs(route);
      return {
        ...source(), status: "available", durationMinutes, distanceMeters: distance as number,
        walkingLegMinutes,
        manualChecks: walkingLegMinutes === null ? ["walking_duration_unknown"] : [],
        warnings: (route.warnings as string[] | undefined) ?? [],
      };
    } catch {
      return unavailable(controller.signal.aborted ? "timeout" : "provider_unavailable");
    } finally {
      clearTimeout(timer);
    }
  }
}
