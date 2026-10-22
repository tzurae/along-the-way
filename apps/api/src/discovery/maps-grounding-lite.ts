import { ProviderQuotaError, ProviderUnavailableError } from "../trip-places/google-places-provider";
import { straightLineMeters } from "../planning/day-route-order";
import {
  SEARCH_CENTER_RADIUS_METERS,
  type DiscoveredPlaceGroup,
  type DiscoverySearchCenter,
  type DiscoverySearchQuery,
} from "./discovery-model";

const MCP_URL = "https://mapstools.googleapis.com/mcp";
const MAX_RESPONSE_BYTES = 256 * 1024;

/** One real place Google Maps returned for a search: identity and position only. */
export interface DiscoveredPlace {
  providerPlaceId: string;
  latitude: number | null;
  longitude: number | null;
}

export interface PlaceSearchResult {
  places: DiscoveredPlace[];
  /**
   * Google's natural-language summary of the places, with "[0]"-style citations into `places`.
   * Google Maps Content: read by the research model during this run only, never stored or logged.
   */
  summary: string;
}

export interface PlaceSearchOptions {
  languageCode?: string;
  regionCode?: string;
  /** Prefer places within radiusMeters of this point (search_places locationBias.circle). */
  near?: { latitude: number; longitude: number; radiusMeters: number };
}

export interface PlaceDiscovery {
  readonly available: boolean;
  searchPlaces(query: string, options: PlaceSearchOptions): Promise<PlaceSearchResult>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function coordinate(value: unknown, limit: number) {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit ? value : null;
}

/**
 * MCP Streamable HTTP may answer a request as a server-sent event stream instead of plain JSON;
 * the JSON-RPC response is then the data of the last event.
 */
function jsonRpcText(body: string, contentType: string) {
  if (!contentType.includes("text/event-stream")) return body;
  let last = "";
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart());
    if (data.length) last = data.join("\n");
  }
  return last;
}

/** The tool result: structured content when the server sends it, else the JSON in its text part. */
function toolPayload(result: Record<string, unknown>): Record<string, unknown> | null {
  const structured = record(result.structuredContent);
  if (structured) return structured;
  if (!Array.isArray(result.content)) return null;
  for (const part of result.content) {
    const item = record(part);
    if (item?.type !== "text" || typeof item.text !== "string") continue;
    try {
      return record(JSON.parse(item.text));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Google Maps Grounding Lite (MCP over HTTP): finds real places for a text query, so 調查 picks
 * among places that exist instead of trusting names the research model writes. Billed per call
 * like Places, so each call reserves the same paid-provider budget first.
 */
export class MapsGroundingLite implements PlaceDiscovery {
  readonly available: boolean;
  private readonly apiKey: string | undefined;
  private readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  private readonly timeoutMs: number;
  private readonly consumeBudget: () => Promise<boolean>;
  private nextId = 1;

  constructor(options: {
    apiKey?: string;
    fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    timeoutMs?: number;
    consumeBudget?: () => Promise<boolean>;
  } = {}) {
    this.apiKey = options.apiKey?.trim() || undefined;
    this.available = Boolean(this.apiKey);
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.consumeBudget = options.consumeBudget ?? (async () => true);
  }

  async searchPlaces(rawQuery: string, options: PlaceSearchOptions = {}): Promise<PlaceSearchResult> {
    const query = rawQuery.trim();
    if (!query || query.length > 300) throw new TypeError("Search query must contain 1 to 300 characters");
    if (!this.apiKey) throw new ProviderUnavailableError();
    if (!(await this.consumeBudget())) throw new ProviderQuotaError();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(MCP_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "X-Goog-Api-Key": this.apiKey,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: this.nextId++,
          method: "tools/call",
          params: {
            name: "search_places",
            arguments: {
              textQuery: query,
              ...(options.languageCode ? { languageCode: options.languageCode } : {}),
              ...(options.regionCode ? { regionCode: options.regionCode } : {}),
              // A place named in textQuery wins over this bias (Google's documented behavior).
              ...(options.near ? {
                locationBias: {
                  circle: {
                    center: { latitude: options.near.latitude, longitude: options.near.longitude },
                    radiusMeters: options.near.radiusMeters,
                  },
                },
              } : {}),
            },
          },
        }),
      });
      if (response.status === 429) throw new ProviderQuotaError();
      if (!response.ok) throw new ProviderUnavailableError();
      const length = Number(response.headers.get("content-length") ?? 0);
      if (length > MAX_RESPONSE_BYTES) throw new ProviderUnavailableError();
      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) throw new ProviderUnavailableError();
      const root = record(JSON.parse(jsonRpcText(text, response.headers.get("content-type") ?? "")));
      const result = record(root?.result);
      // A JSON-RPC or tool error (bad key, API not enabled) means the service cannot be used now.
      if (!result || root?.error || result.isError === true) throw new ProviderUnavailableError();
      const payload = toolPayload(result);
      const places = Array.isArray(payload?.places) ? payload.places : [];
      return {
        places: places.flatMap((raw): DiscoveredPlace[] => {
          const place = record(raw);
          const id = typeof place?.id === "string" ? place.id.trim() : "";
          if (!/^[A-Za-z0-9_-]{8,300}$/.test(id)) return [];
          const location = record(place?.location);
          return [{
            providerPlaceId: id,
            latitude: coordinate(location?.latitude, 90),
            longitude: coordinate(location?.longitude, 180),
          }];
        }),
        summary: typeof payload?.summary === "string" ? payload.summary.slice(0, 6_000) : "",
      };
    } catch (error) {
      if (error instanceof ProviderUnavailableError) throw error;
      throw new ProviderUnavailableError("Google Maps Grounding Lite is temporarily unavailable");
    } finally {
      clearTimeout(timer);
    }
  }
}

const DISCOVERY_CONCURRENCY = 4;

/**
 * Runs every planned search. A search that fails is skipped, so one bad query does not end the
 * run; if every search fails, Google Maps is unavailable. Places the trip already has or rejected
 * stay in their position as null, because the summary cites places by position. With a center,
 * every search is biased toward it and each place carries its distance from it.
 */
export async function discoverPlaces(input: {
  queries: readonly DiscoverySearchQuery[];
  discovery: PlaceDiscovery;
  languageCode: string;
  known: ReadonlySet<string>;
  center?: DiscoverySearchCenter | null;
}): Promise<{ groups: DiscoveredPlaceGroup[]; found: number }> {
  const center = input.center ?? null;
  const near = center
    ? { latitude: center.latitude, longitude: center.longitude, radiusMeters: SEARCH_CENTER_RADIUS_METERS }
    : undefined;
  const results = new Array<DiscoveredPlaceGroup | null>(input.queries.length).fill(null);
  let failed = 0;
  let next = 0;
  // After an exhausted quota the run fails; the other workers stop instead of spending more calls.
  let stopped = false;
  await Promise.all(Array.from({ length: Math.min(DISCOVERY_CONCURRENCY, input.queries.length) }, async () => {
    while (!stopped && next < input.queries.length) {
      const index = next;
      next += 1;
      const query = input.queries[index]!;
      try {
        const found = await input.discovery.searchPlaces(query.query, { languageCode: input.languageCode, ...(near ? { near } : {}) });
        results[index] = {
          ...query,
          summary: found.summary,
          placeIds: found.places.map((place) => input.known.has(place.providerPlaceId) ? null : place.providerPlaceId),
          ...(center ? {
            distancesMeters: found.places.map((place) => place.latitude === null || place.longitude === null ? null
              : Math.round(straightLineMeters(
                { id: "center", latitude: center.latitude, longitude: center.longitude },
                { id: place.providerPlaceId, latitude: place.latitude, longitude: place.longitude },
              ))),
          } : {}),
        };
      } catch (error) {
        if (error instanceof ProviderQuotaError) stopped = true;
        if (error instanceof ProviderQuotaError) throw error;
        if (!(error instanceof ProviderUnavailableError)) throw error;
        failed += 1;
      }
    }
  }));
  if (input.queries.length > 0 && failed === input.queries.length) throw new ProviderUnavailableError();
  const groups = results.filter((group): group is DiscoveredPlaceGroup => group !== null);
  const found = new Set(groups.flatMap((group) => group.placeIds.filter((id): id is string => id !== null))).size;
  return { groups, found };
}
