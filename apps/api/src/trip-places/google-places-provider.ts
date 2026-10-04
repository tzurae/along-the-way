import type { ProviderPlaceCandidateDto } from "@along-the-way/contracts/trip-places";
import type { PlaceType } from "@along-the-way/contracts/trip-skeleton";

import type {
  BusinessStatus,
  OpeningPeriod,
  OpeningPoint,
  PlaceHoursLookup,
  PlaceOpeningHours,
} from "../planning/opening-hours";

// Opening hours move a Place Details request to the Enterprise SKU (about US$0.02 each).
const HOURS_FIELD_MASK = "regularOpeningHours,currentOpeningHours,businessStatus";

const BUSINESS_STATUS: Record<string, BusinessStatus> = {
  OPERATIONAL: "operational",
  CLOSED_TEMPORARILY: "closed_temporarily",
  CLOSED_PERMANENTLY: "closed_permanently",
  FUTURE_OPENING: "future_opening",
};

function openingPoint(value: unknown): OpeningPoint | null {
  if (typeof value !== "object" || value === null) return null;
  const point = value as Record<string, unknown>;
  const integer = (field: unknown, maximum: number) =>
    typeof field === "number" && Number.isInteger(field) && field >= 0 && field <= maximum ? field : null;
  const day = integer(point.day, 6);
  const hour = integer(point.hour, 24);
  const minute = integer(point.minute, 59);
  if (day === null || hour === null || minute === null) return null;
  const date = typeof point.date === "object" && point.date !== null ? point.date as Record<string, unknown> : null;
  const isoDate = date && [date.year, date.month, date.day].every((part) => typeof part === "number")
    ? `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`
    : null;
  return { day, hour, minute, date: isoDate };
}

/** Periods as reported; null when the provider reported no hours at all. */
function openingPeriods(value: unknown): OpeningPeriod[] | null {
  if (typeof value !== "object" || value === null) return null;
  const periods = (value as Record<string, unknown>).periods;
  if (!Array.isArray(periods)) return null;
  return periods.flatMap((raw): OpeningPeriod[] => {
    if (typeof raw !== "object" || raw === null) return [];
    const period = raw as Record<string, unknown>;
    const open = openingPoint(period.open);
    if (!open) return [];
    return [{ open, close: period.close === undefined ? null : openingPoint(period.close) }];
  });
}

export class ProviderUnavailableError extends Error {
  constructor(
    message = "Google Places is temporarily unavailable; use manual entry instead",
  ) {
    super(message);
  }
}

export interface PlaceSearchOptions {
  /** BCP-47 language Google uses for place names and addresses. */
  languageCode?: string;
}

export interface PlaceProvider {
  readonly attribution: string;
  readonly available?: boolean;
  search(query: string, options?: PlaceSearchOptions): Promise<ProviderPlaceCandidateDto[]>;
  getPlace(providerPlaceId: string): Promise<ProviderPlaceCandidateDto>;
}

export interface RatedPlaceCandidate {
  candidate: ProviderPlaceCandidateDto;
  /** Google star rating and review count: used only to screen, never stored or shown (Google terms). */
  rating: number | null;
  userRatingCount: number | null;
  /** The place's own website, which is not an independent recommendation. */
  websiteUri: string | null;
}

export interface RatedPlaceLookup {
  readonly attribution: string;
  readonly available?: boolean;
  /** Text Search Enterprise: a few best matches for a short "area name" query. */
  lookup(query: string, options?: PlaceSearchOptions): Promise<RatedPlaceCandidate[]>;
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
// rating, userRatingCount and websiteUri move the request to the Enterprise SKU.
const LOOKUP_FIELD_MASK = [
  SEARCH_FIELD_MASK,
  "places.rating",
  "places.userRatingCount",
  "places.websiteUri",
].join(",");
const LOOKUP_RESULT_COUNT = 3;
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

export class GooglePlacesProvider implements PlaceProvider, RatedPlaceLookup, PlaceHoursLookup {
  readonly attribution = "Google Maps";
  readonly available: boolean;
  private readonly apiKey: string | undefined;
  private readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  private readonly now: () => Date;
  private readonly timeoutMs: number;

  constructor(options: GooglePlacesProviderOptions = {}) {
    this.apiKey = options.apiKey?.trim() || undefined;
    this.available = Boolean(this.apiKey);
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? 3_000;
  }

  async search(rawQuery: string, options: PlaceSearchOptions = {}) {
    const query = rawQuery.trim();
    if (!query || query.length > 300) {
      throw new TypeError("Search query must contain 1 to 300 characters");
    }
    const value = await this.request(
      "https://places.googleapis.com/v1/places:searchText",
      {
        method: "POST",
        body: JSON.stringify({
          textQuery: query,
          maxResultCount: 8,
          ...(options.languageCode ? { languageCode: options.languageCode } : {}),
        }),
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

  async lookup(rawQuery: string, options: PlaceSearchOptions = {}): Promise<RatedPlaceCandidate[]> {
    const query = rawQuery.trim();
    if (!query || query.length > 300) {
      throw new TypeError("Search query must contain 1 to 300 characters");
    }
    const value = await this.request(
      "https://places.googleapis.com/v1/places:searchText",
      {
        method: "POST",
        body: JSON.stringify({
          textQuery: query,
          maxResultCount: LOOKUP_RESULT_COUNT,
          ...(options.languageCode ? { languageCode: options.languageCode } : {}),
        }),
        headers: {
          "Content-Type": "application/json",
          "X-Goog-FieldMask": LOOKUP_FIELD_MASK,
        },
      },
    );
    const places = record(value)?.places;
    if (!Array.isArray(places)) return [];
    return places.map((place) => {
      const item = record(place);
      const rating = typeof item?.rating === "number" && item.rating >= 1 && item.rating <= 5 ? item.rating : null;
      const count = item?.userRatingCount;
      return {
        candidate: this.candidate(place),
        rating,
        userRatingCount: typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : null,
        websiteUri: typeof item?.websiteUri === "string" ? item.websiteUri : null,
      };
    });
  }

  /** The place's opening hours for evaluating a visit; returned to the caller, never stored. */
  async openingHours(rawProviderPlaceId: string): Promise<PlaceOpeningHours> {
    const providerPlaceId = rawProviderPlaceId.trim();
    if (!/^[A-Za-z0-9_-]{8,300}$/.test(providerPlaceId)) {
      throw new TypeError("Invalid Google place ID");
    }
    const value = record(await this.request(
      `https://places.googleapis.com/v1/places/${encodeURIComponent(providerPlaceId)}`,
      { headers: { "X-Goog-FieldMask": HOURS_FIELD_MASK } },
    ));
    return {
      businessStatus: typeof value?.businessStatus === "string" ? BUSINESS_STATUS[value.businessStatus] ?? null : null,
      regular: openingPeriods(value?.regularOpeningHours),
      current: openingPeriods(value?.currentOpeningHours),
    };
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
