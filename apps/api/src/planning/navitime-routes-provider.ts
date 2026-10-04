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

interface NavitimeRoutesProviderOptions {
  apiKey?: string;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  now?: () => Date;
  timeoutMs?: number;
}

const HOST = "navitime-route-totalnavi.p.rapidapi.com";
const FRESHNESS_MS = 15 * 60 * 1_000;
const NANOSECONDS_PER_MINUTE = 60_000_000_000n;
const TRANSIT_MODES: Record<string, true> = {
  domestic_flight: true, ferry: true, superexpress_train: true, sleeper_ultraexpress: true,
  ultraexpress_train: true, express_train: true, rapid_train: true, semiexpress_train: true,
  local_train: true, shuttle_bus: true, local_bus: true, highway_bus: true,
};

function validateLocation(value: RouteLocation) {
  if (!value || typeof value.placeId !== "string" || !value.placeId.trim()) {
    throw new TypeError("Route locations require a place ID");
  }
  const { latitude, longitude } = value;
  if ((latitude !== null && (typeof latitude !== "number" || !Number.isFinite(latitude) || Math.abs(latitude) > 90))
    || (longitude !== null && (typeof longitude !== "number" || !Number.isFinite(longitude) || Math.abs(longitude) > 180))) {
    throw new TypeError("Route coordinates must be valid degrees or null");
  }
}

export class NavitimeRoutesProvider implements RouteObservationProvider {
  private readonly apiKey: string | undefined;
  private readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  private readonly now: () => Date;
  private readonly timeoutMs: number;

  constructor(options: NavitimeRoutesProviderOptions = {}) {
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
    let departure: Temporal.Instant;
    try {
      departure = Temporal.Instant.from(query.departureTime);
    } catch {
      throw new TypeError("Route departure time must be a valid offset-bearing instant");
    }
    // Bind caller-owned values before the first await; no response can be rebound later.
    const originPlaceId = query.origin.placeId;
    const destinationPlaceId = query.destination.placeId;
    const requestedDepartureTime = departure.toString();
    const source = (mode: RouteMode) => {
      const observedAt = this.now();
      return {
        originPlaceId, destinationPlaceId, requestedDepartureTime, mode,
        provider: "navitime", attribution: "NAVITIME",
        observedAt: observedAt.toISOString(),
        expiresAt: new Date(observedAt.getTime() + FRESHNESS_MS).toISOString(),
      };
    };
    const unavailable = (mode: RouteMode, reason: RouteUnavailableReason): RouteObservation => ({
      ...source(mode), status: "unavailable", reason,
      durationMinutes: null, distanceMeters: null, walkingLegMinutes: null,
    });
    // totalnavi is not a pure-walking subscription; do not sum its access walks as one.
    const walking = unavailable("walking", "unsupported_mode");
    const failed = (reason: RouteUnavailableReason): RouteObservation[] => [walking, unavailable("transit", reason)];
    if (query.origin.latitude === null || query.origin.longitude === null || query.destination.latitude === null || query.destination.longitude === null) {
      return failed("location_unknown");
    }
    if (!this.apiKey) return failed("provider_not_configured");
    const url = new URL(`https://${HOST}/route_transit`);
    url.searchParams.set("start", `${query.origin.latitude},${query.origin.longitude}`);
    url.searchParams.set("goal", `${query.destination.latitude},${query.destination.longitude}`);
    // The market API accepts Japan-local seconds without an offset. Never query earlier.
    url.searchParams.set("start_time", departure.toZonedDateTimeISO("Asia/Tokyo").toPlainDateTime().toString({
      smallestUnit: "second", roundingMode: "ceil",
    }));
    url.searchParams.set("limit", "1");
    url.searchParams.set("train_data", "average");
    url.searchParams.set("bus_data", "none");
    url.searchParams.set("datum", "wgs84");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(url, {
        method: "GET", signal: controller.signal,
        headers: { "X-RapidAPI-Key": this.apiKey, "X-RapidAPI-Host": HOST },
      });
      if (!response.ok) return failed(response.status === 429 ? "quota" : "provider_unavailable");
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        return failed(controller.signal.aborted ? "timeout" : "invalid_response");
      }
      if (!isRecord(value) || !Array.isArray(value.items)) return failed("invalid_response");
      if (value.items.length === 0) return failed("no_route");
      if (value.items.length !== 1 || !isRecord(value.items[0])) return failed("invalid_response");
      const route = value.items[0];
      if (!isRecord(route.summary) || !isRecord(route.summary.move)) return failed("invalid_response");
      const move = route.summary.move;
      if (move.type !== "move" || typeof move.time !== "number" || !Number.isFinite(move.time) || move.time < 0
        || !Number.isSafeInteger(Math.ceil(move.time)) || !Number.isSafeInteger(move.distance) || (move.distance as number) < 0) {
        return failed("invalid_response");
      }
      // Live market responses use move_type; the published schema names it move_types.
      const modes: unknown = move.move_type ?? move.move_types;
      if (!Array.isArray(modes) || modes.length === 0 || !modes.every((mode) => typeof mode === "string" && (mode === "walk" || TRANSIT_MODES[mode] === true))) {
        return failed("invalid_response");
      }
      if (!modes.some((mode) => TRANSIT_MODES[mode] === true)) return failed("no_route");
      let durationMinutes: number;
      try {
        const from = Temporal.Instant.from(move.from_time as string);
        const to = Temporal.Instant.from(move.to_time as string);
        if (from.epochNanoseconds < departure.epochNanoseconds || to.epochNanoseconds < from.epochNanoseconds) {
          return failed("invalid_response");
        }
        // Keep summary time (including gaps), and also include any wait before departure.
        const elapsed = to.epochNanoseconds - departure.epochNanoseconds;
        durationMinutes = Math.max(Math.ceil(move.time), Number((elapsed + NANOSECONDS_PER_MINUTE - 1n) / NANOSECONDS_PER_MINUTE));
      } catch {
        return failed("invalid_response");
      }
      return [walking, {
        ...source("transit"), status: "available", durationMinutes, distanceMeters: move.distance as number,
        // Endpoint walk sections do not establish all in-station/transfer walking.
        walkingLegMinutes: null,
        manualChecks: ["transit_duration_estimated", "walking_duration_unknown"],
        warnings: [
          "Rail travel times are averages, not verified train timetables.",
          "Local bus routing is not available on this API market plan.",
        ],
      }];
    } catch {
      return failed(controller.signal.aborted ? "timeout" : "provider_unavailable");
    } finally {
      clearTimeout(timer);
    }
  }
}
