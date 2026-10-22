import type { NearbyActivitiesResponse, NearbyActivityDto } from "@along-the-way/contracts/trip-places";

/** Counts one uncached lookup against the caller's quota; throws `rate_limited` when exhausted. */
export type ClaimNearbyActivityLookup = () => Promise<void>;

export interface NearbyActivityModule {
  /** View only: never changes the trip. Any active member may ask. */
  nearbyActivities(
    userId: string,
    tripId: string,
    dayId: string,
    tripPlaceId: string,
    claimLookup: ClaimNearbyActivityLookup,
  ): Promise<NearbyActivitiesResponse>;
}

export interface NearbyActivityQuery {
  stopName: string;
  address: string | null;
  latitude: number;
  longitude: number;
  /** The day's local date, YYYY-MM-DD. */
  date: string;
  timeZone: string | null;
  /** ISO 3166-1 alpha-2, when the stop's country is known. */
  countryCode: string | null;
}

/** An activity as the provider found it; the server adds the straight-line distance. */
export type FoundNearbyActivity = Omit<NearbyActivityDto, "straightLineMeters">;

export interface NearbyActivityModel {
  readonly available: boolean;
  /** Every returned item cites a page the provider's own web search returned in the same call. */
  find(query: NearbyActivityQuery): Promise<FoundNearbyActivity[]>;
}
