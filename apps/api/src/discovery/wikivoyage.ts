import { placeNamesMatch } from "./place-names";

/** A guide entry: a listing template ({{see|name=…}}, {{listing|…}}, …) or a bolded '''name'''. */
export interface WikivoyageListing {
  names: string[];
  latitude: number | null;
  longitude: number | null;
}

export interface WikivoyagePage {
  url: string;
  title: string;
}

/** Listing coordinates within this distance of the Google location identify the same place. */
export const SAME_PLACE_METERS = 300;

const USER_AGENT = "AlongTheWay/1.0 (https://github.com/tzurae/along-the-way)";

function topLevelTemplates(wikitext: string) {
  const templates: string[] = [];
  let depth = 0;
  let start = -1;
  for (let index = 0; index < wikitext.length - 1; index += 1) {
    const pair = wikitext.slice(index, index + 2);
    if (pair === "{{") {
      if (depth === 0) start = index + 2;
      depth += 1;
      index += 1;
    } else if (pair === "}}" && depth > 0) {
      depth -= 1;
      if (depth === 0) templates.push(wikitext.slice(start, index));
      index += 1;
    }
  }
  return templates;
}

function templateParameters(body: string) {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (let index = 0; index < body.length; index += 1) {
    const pair = body.slice(index, index + 2);
    if (pair === "{{" || pair === "[[") {
      depth += 1;
      current += pair;
      index += 1;
    } else if ((pair === "}}" || pair === "]]") && depth > 0) {
      depth -= 1;
      current += pair;
      index += 1;
    } else if (body[index] === "|" && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += body[index];
    }
  }
  parts.push(current);
  const parameters = new Map<string, string>();
  for (const part of parts.slice(1)) {
    const separator = part.indexOf("=");
    if (separator > 0) parameters.set(part.slice(0, separator).trim().toLowerCase(), part.slice(separator + 1).trim());
  }
  return parameters;
}

function coordinate(value: string | undefined, limit: number) {
  if (!value) return null;
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= limit ? number : null;
}

function plain(value: string) {
  return value.replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, "$1").replace(/'{2,}/g, "").trim();
}

export function parseWikivoyageListings(wikitext: string): WikivoyageListing[] {
  const listings: WikivoyageListing[] = [];
  for (const template of topLevelTemplates(wikitext)) {
    const parameters = templateParameters(template);
    const name = parameters.get("name");
    if (!name) continue;
    const latitude = coordinate(parameters.get("lat"), 90);
    const longitude = coordinate(parameters.get("long"), 180);
    listings.push({
      names: [name, parameters.get("alt"), parameters.get("wikipedia")].filter((entry): entry is string => Boolean(entry)).map(plain),
      latitude: latitude !== null && longitude !== null ? latitude : null,
      longitude: latitude !== null && longitude !== null ? longitude : null,
    });
  }
  for (const match of wikitext.matchAll(/'''([^'\n]{2,80})'''/g)) {
    listings.push({ names: [plain(match[1]!)], latitude: null, longitude: null });
  }
  return listings;
}

function metersBetween(aLat: number, aLon: number, bLat: number, bLon: number) {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const dLat = radians(bLat - aLat);
  const dLon = radians(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(aLat)) * Math.cos(radians(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function listsPlace(
  listings: readonly WikivoyageListing[],
  place: { names: readonly string[]; latitude: number | null; longitude: number | null },
) {
  return listings.some((listing) =>
    listing.names.some((name) => placeNamesMatch(place.names, name))
    || (listing.latitude !== null && listing.longitude !== null && place.latitude !== null && place.longitude !== null
      && metersBetween(listing.latitude, listing.longitude, place.latitude, place.longitude) <= SAME_PLACE_METERS));
}

interface WikivoyageOptions {
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}

/**
 * Checks whether a Wikivoyage guide (in the given language editions) lists a place.
 * One instance serves one research run, so guide pages shared by many places load once.
 */
export class WikivoyageVerifier {
  private readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  private readonly timeoutMs: number;
  private readonly pages = new Map<string, Promise<WikivoyageListing[] | null>>();

  constructor(options: WikivoyageOptions = {}) {
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 4_000;
  }

  async verify(place: {
    names: readonly string[];
    latitude: number | null;
    longitude: number | null;
    languages: readonly string[];
  }): Promise<WikivoyagePage | null> {
    const names = [...new Set(place.names.map((name) => name.trim()).filter(Boolean))];
    if (names.length === 0) return null;
    for (const language of place.languages) {
      const titles = await this.search(language, names);
      for (const title of titles.slice(0, 2)) {
        const listings = await this.listings(language, title);
        if (listings && listsPlace(listings, { ...place, names })) {
          const path = title.replace(/ /g, "_").split("/").map(encodeURIComponent).join("/");
          return { url: `https://${language}.wikivoyage.org/wiki/${path}`, title };
        }
      }
    }
    return null;
  }

  private async api(language: string, parameters: Record<string, string>) {
    if (!/^[a-z]{2,3}$/.test(language)) return null;
    const url = new URL(`https://${language}.wikivoyage.org/w/api.php`);
    for (const [key, value] of Object.entries({ ...parameters, format: "json", formatversion: "2" })) {
      url.searchParams.set(key, value);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(url, {
        signal: controller.signal,
        headers: { Accept: "application/json", "User-Agent": USER_AGENT, "Api-User-Agent": USER_AGENT },
      });
      if (!response.ok) return null;
      const value: unknown = await response.json();
      return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async search(language: string, names: readonly string[]) {
    const value = await this.api(language, {
      action: "query",
      list: "search",
      srnamespace: "0",
      srlimit: "3",
      srsearch: names.map((name) => `"${name.replace(/"/g, "")}"`).join(" OR "),
    });
    const results = (value?.query as { search?: unknown } | undefined)?.search;
    return Array.isArray(results)
      ? results.flatMap((entry) => typeof entry?.title === "string" ? [entry.title as string] : [])
      : [];
  }

  private listings(language: string, title: string) {
    const key = `${language}:${title}`;
    let pending = this.pages.get(key);
    if (!pending) {
      pending = this.api(language, {
        action: "query",
        prop: "revisions",
        rvprop: "content",
        rvslots: "main",
        redirects: "1",
        titles: title,
      }).then((value) => {
        const pages = (value?.query as { pages?: unknown } | undefined)?.pages;
        const content = Array.isArray(pages)
          ? (pages[0] as { revisions?: Array<{ slots?: { main?: { content?: unknown } } }> } | undefined)
            ?.revisions?.[0]?.slots?.main?.content
          : undefined;
        return typeof content === "string" ? parseWikivoyageListings(content) : null;
      });
      this.pages.set(key, pending);
    }
    return pending;
  }
}
