import type { ProviderPlaceCandidateDto } from "@along-the-way/contracts/trip-places";
import type { PlaceType } from "@along-the-way/contracts/trip-skeleton";

export class ProviderUnavailableError extends Error {
  constructor(
    message = "Google Places is temporarily unavailable; use manual entry instead",
  ) {
    super(message);
  }
}

export interface PlaceProvider {
  readonly attribution: string;
  search(query: string): Promise<ProviderPlaceCandidateDto[]>;
  getPlace(providerPlaceId: string): Promise<ProviderPlaceCandidateDto>;
}

interface GooglePlacesProviderOptions {
  apiKey?: string;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  now?: () => Date;
  timeoutMs?: number;
}

interface GooglePlaceValue {
  id?: unknown;
  displayName?: unknown;
  formattedAddress?: unknown;
  location?: unknown;
  primaryType?: unknown;
  googleMapsUri?: unknown;
}

const SEARCH_FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.location",
  "places.primaryType",
  "places.googleMapsUri",
].join(",");
const DETAILS_FIELD_MASK = [
  "id",
  "displayName",
  "formattedAddress",
  "location",
  "primaryType",
  "googleMapsUri",
].join(",");

function mappedPlaceType(value: string): PlaceType {
  if (value.includes("airport")) return "airport";
  if (
    value.includes("station") ||
    value === "transit_station" ||
    value === "subway_station"
  ) return "station";
  if (value === "lodging" || value.includes("hotel")) return "lodging";
  if (
    value.includes("restaurant") ||
    value === "cafe" ||
    value === "bakery" ||
    value === "bar"
  ) return "restaurant";
  if (
    value.includes("museum") ||
    value.includes("park") ||
    value.includes("tourist_attraction") ||
    value.includes("amusement") ||
    value.includes("zoo") ||
    value.includes("aquarium")
  ) return "activity";
  return "other";
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export class GooglePlacesProvider implements PlaceProvider {
  readonly attribution = "Google Maps";
  private readonly apiKey: string | undefined;
  private readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  private readonly now: () => Date;
  private readonly timeoutMs: number;

  constructor(options: GooglePlacesProviderOptions = {}) {
    this.apiKey = options.apiKey?.trim() || undefined;
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? 3_000;
  }

  async search(rawQuery: string) {
    const query = rawQuery.trim();
    if (!query || query.length > 300) {
      throw new TypeError("Search query must contain 1 to 300 characters");
    }
    const value = await this.request(
      "https://places.googleapis.com/v1/places:searchText",
      {
        method: "POST",
        body: JSON.stringify({ textQuery: query, maxResultCount: 8 }),
        headers: {
          "Content-Type": "application/json",
          "X-Goog-FieldMask": SEARCH_FIELD_MASK,
        },
      },
    );
    const places = record(value)?.places;
    if (!Array.isArray(places)) return [];
    return places.map((place) => this.candidate(place));
  }

  async getPlace(rawProviderPlaceId: string) {
    const providerPlaceId = rawProviderPlaceId.trim();
    if (!/^[A-Za-z0-9_-]{8,300}$/.test(providerPlaceId)) {
      throw new TypeError("Invalid Google place ID");
    }
    const value = await this.request(
      `https://places.googleapis.com/v1/places/${encodeURIComponent(providerPlaceId)}`,
      {
        headers: { "X-Goog-FieldMask": DETAILS_FIELD_MASK },
      },
    );
    return this.candidate(value);
  }

  private async request(url: string, init: RequestInit) {
    if (!this.apiKey) throw new ProviderUnavailableError();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "X-Goog-Api-Key": this.apiKey,
          ...init.headers,
        },
      });
      if (!response.ok) throw new ProviderUnavailableError();
      return await response.json();
    } catch (error) {
      if (error instanceof ProviderUnavailableError) throw error;
      throw new ProviderUnavailableError();
    } finally {
      clearTimeout(timer);
    }
  }

  private candidate(raw: unknown): ProviderPlaceCandidateDto {
    const value = record(raw);
    const displayName = record(value?.displayName);
    const location = record(value?.location);
    if (
      !value ||
      typeof value.id !== "string" ||
      typeof displayName?.text !== "string"
    ) {
      throw new ProviderUnavailableError(
        "Google Places returned an incomplete place result; use manual entry instead",
      );
    }
    const observedAt = this.now();
    const expiresAt = new Date(observedAt.getTime() + 30 * 24 * 60 * 60 * 1_000);
    const latitude =
      typeof location?.latitude === "number" ? location.latitude : null;
    const longitude =
      typeof location?.longitude === "number" ? location.longitude : null;
    return {
      provider: "google",
      providerPlaceId: value.id,
      name: displayName.text,
      type: mappedPlaceType(
        typeof value.primaryType === "string" ? value.primaryType : "",
      ),
      address:
        typeof value.formattedAddress === "string"
          ? value.formattedAddress
          : null,
      latitude: latitude === null || longitude === null ? null : latitude,
      longitude: latitude === null || longitude === null ? null : longitude,
      timeZone: null,
      sourceUrl:
        typeof value.googleMapsUri === "string" ? value.googleMapsUri : null,
      attribution: this.attribution,
      observedAt: observedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
  }
}
