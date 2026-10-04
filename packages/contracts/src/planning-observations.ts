export type RouteMode = "walking" | "transit";

export interface RouteLocation {
  placeId: string;
  latitude: number | null;
  longitude: number | null;
}

export interface RouteObservationQuery {
  origin: RouteLocation;
  destination: RouteLocation;
  /** An offset-bearing instant, not a Trip-local wall-clock string. */
  departureTime: string;
}

export type RouteUnavailableReason =
  | "location_unknown"
  | "provider_not_configured"
  | "unsupported_departure_time"
  | "unsupported_mode"
  | "timeout"
  | "quota"
  | "provider_unavailable"
  | "no_route"
  | "invalid_response";

interface RouteObservationSource {
  originPlaceId: string;
  destinationPlaceId: string;
  requestedDepartureTime: string;
  mode: RouteMode;
  provider: string;
  attribution: string;
  observedAt: string;
  /** Freshness bound only; not permission to persist provider content. */
  expiresAt: string;
}

export type RouteObservation = RouteObservationSource & (
  | {
      status: "available";
      /** Rounded up, never down, to whole minutes from provider duration. */
      durationMinutes: number;
      distanceMeters: number;
      /** Consecutive walking instructions form one leg; null means unknown. */
      walkingLegMinutes: number[] | null;
      manualChecks: ("walking_duration_unknown" | "transit_duration_estimated")[];
      warnings: string[];
    }
  | {
      status: "unavailable";
      reason: RouteUnavailableReason;
      durationMinutes: null;
      distanceMeters: null;
      walkingLegMinutes: null;
    }
);

export interface RouteObservationProvider {
  /** Returns walking then transit, independently; invalid input throws TypeError. */
  observe(query: RouteObservationQuery): Promise<RouteObservation[]>;
}
