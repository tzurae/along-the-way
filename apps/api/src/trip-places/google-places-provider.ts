import { createHash } from "node:crypto";
import type { GooglePlacePhotoDto } from "@along-the-way/contracts/place-details";
import type { ProviderPlaceCandidateDto } from "@along-the-way/contracts/trip-places";
import type { PlaceType } from "@along-the-way/contracts/trip-skeleton";

import type { BusinessStatus } from "../planning/opening-hours";

const BUSINESS_STATUS: Record<string, BusinessStatus> = {
  OPERATIONAL: "operational",
  CLOSED_TEMPORARILY: "closed_temporarily",
  CLOSED_PERMANENTLY: "closed_permanently",
  FUTURE_OPENING: "future_opening",
};


export class ProviderUnavailableError extends Error {
  constructor(
    message = "Google Places is temporarily unavailable; use manual entry instead",
  ) {
    super(message);
  }
}

export class ProviderQuotaError extends ProviderUnavailableError {
  constructor() {
    super("Google Places daily quota is exhausted");
  }
}

export class PlacePhotoNotFoundError extends Error {}

export interface PlaceSearchOptions {
  /** BCP-47 language Google uses for place names and addresses. */
  languageCode?: string;
  /** CLDR two-letter region code used to bias results. */
  regionCode?: string;
  /** Number of Text Search results requested from Google. */
  pageSize?: number;
}

export interface GoogleProviderPhoto {
  name: string;
  width: number;
  height: number;
  authors: Array<{ displayName: string; uri: string | null }>;
  googleMapsUri: string | null;
}

export function googlePlacePhotoFingerprint(photo: GoogleProviderPhoto): string {
  const attribution = photo.authors
    .map((author) => `${author.displayName}\u0000${author.uri ?? ""}`)
    .join("\u0001");
  return createHash("sha256")
    .update(`${photo.width}x${photo.height}|${attribution}${photo.googleMapsUri ? `|${photo.googleMapsUri}` : ""}`)
    .digest("hex")
    .slice(0, 16);
}

export function googlePlacePhotoDto(
  tripId: string,
  providerPlaceId: string,
  index: 0 | 1 | 2,
  photo: GoogleProviderPhoto,
  capability?: { exp: number; sig: string },
): GooglePlacePhotoDto {
  const prefixName = `places/${providerPlaceId}/photos/`;
  const providerToken = photo.name.startsWith(prefixName) ? photo.name.slice(prefixName.length) : "";
  if (!/^[A-Za-z0-9_-]{1,1000}$/.test(providerToken)) throw new TypeError("Invalid Google photo identity");
  const fingerprint = googlePlacePhotoFingerprint(photo);
  const prefix = `/api/trips/${tripId}/google-place-photos/${providerPlaceId}`;
  const capabilityQuery = capability ? `&exp=${capability.exp}&sig=${capability.sig}` : "";
  return {
    source: "google",
    index,
    id: `google:${providerPlaceId}:${index}:${fingerprint}`,
    thumbnailUrl: `${prefix}?index=${index}&photo=${fingerprint}&maxWidth=192${capabilityQuery}`,
    imageUrl: `${prefix}?index=${index}&photo=${fingerprint}&maxWidth=1024${capabilityQuery}`,
    width: photo.width,
    height: photo.height,
    authors: photo.authors,
    googleMapsUri: photo.googleMapsUri,
  };
}

export interface ProviderPlaceCandidate extends ProviderPlaceCandidateDto {
  /** Provider-only photo metadata. It is never persisted or sent directly to clients. */
  providerPhoto?: GoogleProviderPhoto | null;
}

export interface PlacePhotoMedia {
  bytes: Uint8Array<ArrayBuffer>;
  contentType: string;
}

export interface PlaceProvider {
  readonly attribution: string;
  readonly available?: boolean;
  search(query: string, options?: PlaceSearchOptions): Promise<ProviderPlaceCandidate[]>;
  getPlace(providerPlaceId: string, options?: Pick<PlaceSearchOptions, "languageCode" | "regionCode">): Promise<ProviderPlaceCandidate>;
  getPhotos?(providerPlaceId: string): Promise<GoogleProviderPhoto[]>;
  fetchPhotoMedia?(photoName: string, maxWidthPx: 192 | 1024): Promise<PlacePhotoMedia>;
}

export interface RatedPlaceCandidate {
  candidate: ProviderPlaceCandidateDto;
  /** Google star rating and review count: used only to screen, never stored or shown (Google terms). */
  rating: number | null;
  userRatingCount: number | null;
  /** The place's own website, which is not an independent recommendation. */
  websiteUri: string | null;
  /** Whether the place is open for business: used only to screen, never stored. */
  businessStatus: BusinessStatus | null;
  /** ISO 3166-1 alpha-2 country of the place's address: used only to screen, never stored. */
  countryCode: string | null;
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
  /** Reserves one unit immediately before each paid outbound request. */
  consumeBudget?: () => Promise<boolean>;
}

interface GooglePlaceValue {
  id?: unknown;
  displayName?: unknown;
  formattedAddress?: unknown;
  location?: unknown;
  primaryType?: unknown;
  primaryTypeDisplayName?: unknown;
  googleMapsUri?: unknown;
  photos?: unknown;
}

const PLACE_FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.location",
  "places.primaryType",
  "places.googleMapsUri",
];
const SEARCH_FIELD_MASK = [
  ...PLACE_FIELD_MASK,
  "places.primaryTypeDisplayName",
  "places.photos",
].join(",");
// rating, userRatingCount and websiteUri move the request to the Enterprise SKU; the
// businessStatus and addressComponents (Pro) fields then cost nothing more.
const LOOKUP_FIELD_MASK = [
  ...PLACE_FIELD_MASK,
  "places.rating",
  "places.userRatingCount",
  "places.websiteUri",
  "places.businessStatus",
  "places.addressComponents",
].join(",");

/** The two-letter country code among Google address components, or null when absent. */
function addressCountry(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const raw of value) {
    const component = record(raw);
    if (!Array.isArray(component?.types) || !component.types.includes("country")) continue;
    const code = typeof component.shortText === "string" ? component.shortText.toUpperCase() : "";
    return /^[A-Z]{2}$/.test(code) ? code : null;
  }
  return null;
}

const LOOKUP_RESULT_COUNT = 3;
// displayName and primaryTypeDisplayName are Pro fields; photos is Essentials IDs Only.
const DETAILS_FIELD_MASK = [
  "id",
  "displayName",
  "formattedAddress",
  "location",
  "primaryType",
  "primaryTypeDisplayName",
  "googleMapsUri",
  "photos",
].join(",");

/** Google's fine-grained primary type → one normalized place category (order matters). */
export function mappedPlaceType(value: string): PlaceType {
  if (value.includes("airport")) return "airport";
  // Transit only: gas/charging stations are not where a traveller arrives.
  if (/(^|_)(train|transit|subway|bus|light_rail|railway)_station$/.test(value) || value === "transit_depot") return "station";
  if (value === "lodging" || value.includes("hotel") || value.includes("hostel") || value === "inn" || value.endsWith("_inn") || value === "ryokan") return "lodging";
  if (value.includes("parking")) return "other";
  // A whole area (嵐山、祇園) is visited like a sight, not an "other".
  if (["neighborhood", "locality", "sublocality", "sublocality_level_1", "administrative_area_level_3", "colloquial_area"].includes(value)) return "activity";
  // Google's scenic_spot (嵐山、嵐山竹林小徑) is a sight to visit.
  if (value.includes("scenic")) return "activity";
  // Coffee, tea and sweets before restaurants: `cafe_restaurant`-like types read as a café visit.
  if (
    value.includes("cafe") ||
    value.includes("coffee") ||
    value.includes("tea_house") ||
    value.includes("bakery") ||
    value.includes("dessert") ||
    value.includes("ice_cream") ||
    value.includes("confectionery") ||
    value.includes("candy")
  ) return "cafe";
  if (
    value.includes("restaurant") ||
    value.includes("food_court") ||
    value.includes("diner") ||
    value === "bar" ||
    value.endsWith("_bar") ||
    value === "pub" ||
    value === "brewery" ||
    value === "winery" ||
    value === "meal_takeaway"
  ) return "restaurant";
  if (
    value.includes("temple") ||
    value.includes("shrine") ||
    value.includes("church") ||
    value.includes("mosque") ||
    value.includes("synagogue") ||
    value === "place_of_worship"
  ) return "worship";
  if (
    value.includes("museum") ||
    value.includes("gallery") ||
    value.includes("aquarium") ||
    value.includes("zoo") ||
    value.includes("planetarium") ||
    value === "cultural_center"
  ) return "museum";
  if (
    value.includes("amusement") ||
    value.includes("theme_park") ||
    value.includes("water_park")
  ) return "activity";
  if (
    value.includes("park") ||
    value.includes("garden") ||
    value.includes("hiking") ||
    value.includes("beach") ||
    value.includes("nature") ||
    value.includes("mountain") ||
    value.includes("lake")
  ) return "nature";
  if (
    value.includes("market") ||
    value.includes("shopping") ||
    value.includes("store") ||
    value.includes("_shop") ||
    value === "department_store"
  ) return "shopping";
  if (
    value.includes("tourist_attraction") ||
    value.includes("historical") ||
    value === "monument" ||
    value.includes("observation") ||
    value.includes("landmark") ||
    value.includes("castle")
  ) return "activity";
  return "other";
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function providerHttpsUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 2_000) return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

function isGooglePhotoUri(url: URL) {
  return url.protocol === "https:"
    && (url.hostname === "googleusercontent.com" || url.hostname.endsWith(".googleusercontent.com"));
}

export class GooglePlacesProvider implements PlaceProvider, RatedPlaceLookup {
  readonly attribution = "Google Maps";
  readonly available: boolean;
  private readonly apiKey: string | undefined;
  private readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly consumeBudget: () => Promise<boolean>;

  constructor(options: GooglePlacesProviderOptions = {}) {
    this.apiKey = options.apiKey?.trim() || undefined;
    this.available = Boolean(this.apiKey);
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? 3_000;
    this.consumeBudget = options.consumeBudget ?? (async () => true);
  }

  async search(rawQuery: string, options: PlaceSearchOptions = {}) {
    const query = rawQuery.trim();
    if (!query || query.length > 300) {
      throw new TypeError("Search query must contain 1 to 300 characters");
    }
    const pageSize = options.pageSize;
    if (pageSize !== undefined && (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 20)) {
      throw new TypeError("Search page size must be an integer from 1 to 20");
    }
    const value = await this.request(
      "https://places.googleapis.com/v1/places:searchText",
      {
        method: "POST",
        body: JSON.stringify({
          textQuery: query,
          ...(options.languageCode ? { languageCode: options.languageCode } : {}),
          ...(options.regionCode ? { regionCode: options.regionCode } : {}),
          ...(pageSize === undefined ? {} : { pageSize }),
        }),
        headers: {
          "Content-Type": "application/json",
          "X-Goog-FieldMask": SEARCH_FIELD_MASK,
        },
      },
    );
    const places = record(value)?.places;
    if (!Array.isArray(places)) return [];
    return places.map((place) => this.candidate(place, true));
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
        businessStatus: typeof item?.businessStatus === "string" ? BUSINESS_STATUS[item.businessStatus] ?? null : null,
        countryCode: addressCountry(item?.addressComponents),
      };
    });
  }


  async getPlace(
    rawProviderPlaceId: string,
    options: Pick<PlaceSearchOptions, "languageCode" | "regionCode"> = {},
  ) {
    const providerPlaceId = this.placeId(rawProviderPlaceId);
    const query = new URLSearchParams();
    if (options.languageCode) query.set("languageCode", options.languageCode);
    if (options.regionCode) query.set("regionCode", options.regionCode);
    const parameters = query.toString();
    const suffix = parameters ? `?${parameters}` : "";
    const value = await this.request(
      `https://places.googleapis.com/v1/places/${encodeURIComponent(providerPlaceId)}${suffix}`,
      {
        headers: { "X-Goog-FieldMask": DETAILS_FIELD_MASK },
      },
    );
    return this.candidate(value, true);
  }

  async getPhotos(rawProviderPlaceId: string): Promise<GoogleProviderPhoto[]> {
    const providerPlaceId = this.placeId(rawProviderPlaceId);
    const value = record(await this.request(
      `https://places.googleapis.com/v1/places/${encodeURIComponent(providerPlaceId)}`,
      { headers: { "X-Goog-FieldMask": "photos" } },
    ));
    return this.photos(value?.photos, providerPlaceId);
  }

  async fetchPhotoMedia(rawPhotoName: string, maxWidthPx: 192 | 1024): Promise<PlacePhotoMedia> {
    const photoName = rawPhotoName.trim();
    if (!/^places\/[A-Za-z0-9_-]{8,300}\/photos\/[A-Za-z0-9_-]{1,1000}$/.test(photoName)
      || (maxWidthPx !== 192 && maxWidthPx !== 1024)) {
      throw new TypeError("Invalid Google photo request");
    }
    const metadata = record(await this.request(
      `https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=${maxWidthPx}&skipHttpRedirect=true`,
      { headers: {} },
      true,
    ));
    if (typeof metadata?.photoUri !== "string") throw new ProviderUnavailableError();
    let photoUri: URL;
    try {
      photoUri = new URL(metadata.photoUri);
    } catch {
      throw new ProviderUnavailableError();
    }
    if (!isGooglePhotoUri(photoUri)) throw new ProviderUnavailableError();
    return this.fetchImage(photoUri);
  }

  private async request(url: string, init: RequestInit, photoNotFound = false) {
    if (!this.apiKey) throw new ProviderUnavailableError();
    if (!(await this.consumeBudget())) throw new ProviderQuotaError();
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
      if (!response.ok) {
        if (photoNotFound && (response.status === 400 || response.status === 404)) {
          throw new PlacePhotoNotFoundError();
        }
        if (response.status === 429) throw new ProviderQuotaError();
        throw new ProviderUnavailableError();
      }
      const bytes = await this.readBoundedBytes(response, 256 * 1024);
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch (error) {
      if (error instanceof ProviderUnavailableError || error instanceof PlacePhotoNotFoundError) throw error;
      throw new ProviderUnavailableError();
    } finally {
      clearTimeout(timer);
    }
  }

  private placeId(rawProviderPlaceId: string) {
    const providerPlaceId = rawProviderPlaceId.trim();
    if (!/^[A-Za-z0-9_-]{8,300}$/.test(providerPlaceId)) {
      throw new TypeError("Invalid Google place ID");
    }
    return providerPlaceId;
  }

  private photos(rawPhotos: unknown, providerPlaceId: string, limit = 3): GoogleProviderPhoto[] {
    if (!Array.isArray(rawPhotos) || rawPhotos.length === 0) return [];
    const count = Math.min(rawPhotos.length, limit);
    const photos = new Array<GoogleProviderPhoto>(count);
    for (let index = 0; index < count; index += 1) {
      const photo = this.photo(rawPhotos[index], providerPlaceId);
      if (photo === null) return [];
      photos[index] = photo;
    }
    return photos;
  }

  private photo(rawPhoto: unknown, providerPlaceId: string): GoogleProviderPhoto | null {
    const photo = record(rawPhoto);
    const photoName = typeof photo?.name === "string" ? photo.name : null;
    const identity = photoName === null
      ? null
      : /^places\/([A-Za-z0-9_-]{8,300})\/photos\/([A-Za-z0-9_-]{1,1000})$/.exec(photoName);
    if (!photo
      || photoName === null
      || !identity
      || identity[1] !== providerPlaceId
      || typeof photo.widthPx !== "number"
      || !Number.isSafeInteger(photo.widthPx)
      || photo.widthPx < 1
      || photo.widthPx > 50_000
      || typeof photo.heightPx !== "number"
      || !Number.isSafeInteger(photo.heightPx)
      || photo.heightPx < 1
      || photo.heightPx > 50_000) return null;
    const rawAuthors = photo.authorAttributions;
    if (rawAuthors !== undefined && (!Array.isArray(rawAuthors) || rawAuthors.length > 50)) return null;
    const authors: GoogleProviderPhoto["authors"] = [];
    for (const rawAuthor of rawAuthors ?? []) {
      const author = record(rawAuthor);
      if (!author || typeof author.displayName !== "string"
        || !author.displayName.trim() || author.displayName.length > 500) return null;
      authors.push({ displayName: author.displayName, uri: providerHttpsUrl(author.uri) });
    }
    return {
      name: photoName,
      width: photo.widthPx,
      height: photo.heightPx,
      authors,
      googleMapsUri: providerHttpsUrl(photo.googleMapsUri),
    };
  }

  private async readBoundedBytes(response: Response, maximumBytes: number): Promise<Uint8Array<ArrayBuffer>> {
    const rawContentLength = response.headers.get("Content-Length");
    const contentLength = rawContentLength === null ? null : Number(rawContentLength);
    if (contentLength !== null
      && (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > maximumBytes)) {
      throw new ProviderUnavailableError();
    }
    if (!response.body) throw new ProviderUnavailableError();
    const reader = response.body.getReader();
    // Fetch may transparently decode compressed bodies while retaining the wire
    // Content-Length. Preallocate only when those lengths describe the same bytes.
    const knownBytes = contentLength === null || response.headers.has("Content-Encoding")
      ? null
      : new Uint8Array(contentLength);
    const chunks: Uint8Array[] | null = knownBytes ? null : [];
    let byteLength = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const nextByteLength = byteLength + value.byteLength;
      if (nextByteLength > maximumBytes || (knownBytes && nextByteLength > knownBytes.byteLength)) {
        await reader.cancel();
        throw new ProviderUnavailableError();
      }
      if (knownBytes) knownBytes.set(value, byteLength);
      else chunks!.push(value);
      byteLength = nextByteLength;
    }
    if (byteLength === 0 || (knownBytes && byteLength !== knownBytes.byteLength)) throw new ProviderUnavailableError();
    if (knownBytes) return knownBytes;
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks!) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  private async fetchImage(url: URL): Promise<PlacePhotoMedia> {
    if (!isGooglePhotoUri(url)) throw new ProviderUnavailableError();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      let current = url;
      let followedRedirects = 0;
      while (true) {
        const response = await this.fetch(current, {
          signal: controller.signal,
          redirect: "manual",
          headers: { Accept: "image/jpeg,image/png,image/webp" },
        });
        if (response.status >= 300 && response.status < 400) {
          if (followedRedirects >= 2) throw new ProviderUnavailableError();
          const location = response.headers.get("Location");
          if (!location) throw new ProviderUnavailableError();
          let target: URL;
          try {
            target = new URL(location, current);
          } catch {
            throw new ProviderUnavailableError();
          }
          if (!isGooglePhotoUri(target)) throw new ProviderUnavailableError();
          current = target;
          followedRedirects++;
          continue;
        }
        const contentType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
        if (!response.ok
          || (contentType !== "image/jpeg" && contentType !== "image/png" && contentType !== "image/webp")) {
          throw new ProviderUnavailableError();
        }
        return {
          bytes: await this.readBoundedBytes(response, 5 * 1024 * 1024),
          contentType,
        };
      }
    } catch (error) {
      if (error instanceof ProviderUnavailableError) throw error;
      throw new ProviderUnavailableError();
    } finally {
      clearTimeout(timer);
    }
  }

  private candidate(raw: unknown, includePhoto = false): ProviderPlaceCandidate {
    const value = record(raw);
    const displayName = record(value?.displayName);
    const primaryTypeDisplayName = record(value?.primaryTypeDisplayName);
    const location = record(value?.location);
    if (
      !value ||
      typeof value.id !== "string" ||
      !/^[A-Za-z0-9_-]{8,300}$/.test(value.id) ||
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
      typeLabel: typeof primaryTypeDisplayName?.text === "string" && primaryTypeDisplayName.text.trim()
        ? primaryTypeDisplayName.text
        : null,
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
      photo: null,
      ...(includePhoto ? { providerPhoto: this.photos(value.photos, value.id, 1)[0] ?? null } : {}),
    };
  }
}
