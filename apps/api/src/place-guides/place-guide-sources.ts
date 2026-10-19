import type { PlaceGuideSourceDto } from "@along-the-way/contracts/place-details";
import { boundedBytes } from "../discovery/official-pages";

const LANGUAGES = ["ja", "zh", "en"] as const;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_EXTRACT_CHARACTERS = 8_000;
const MAX_TOTAL_CHARACTERS = 36_000;

type WikiLanguage = typeof LANGUAGES[number];
type WikiFamily = "wikipedia" | "wikivoyage";

export interface PlaceGuideEvidenceSource extends PlaceGuideSourceDto {
  text: string;
}

interface PlaceGuideSourceFetcherOptions {
  userAgent: string;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}

/** Fetches bounded, plain-text evidence only from fixed Wikimedia API hosts. */
export class PlaceGuideSourceFetcher {
  private readonly userAgent: string;
  private readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  private readonly timeoutMs: number;

  constructor(options: PlaceGuideSourceFetcherOptions) {
    this.userAgent = options.userAgent;
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  async fetchForPlace(placeName: string, wikidataId: string | null): Promise<PlaceGuideEvidenceSource[]> {
    const sources: PlaceGuideEvidenceSource[] = [];
    let sourceFailure: unknown = null;
    let wikipediaTitles = new Map<WikiLanguage, string>();
    if (wikidataId) {
      try {
        wikipediaTitles = await this.wikipediaSitelinks(wikidataId);
      } catch (error) {
        sourceFailure = error;
      }
    }

    for (const language of LANGUAGES) {
      try {
        const preferredTitle = wikipediaTitles.get(language);
        let article = preferredTitle
          ? await this.extract("wikipedia", language, preferredTitle)
          : null;
        if (!article) {
          const searchedTitle = await this.searchTitle("wikipedia", language, placeName);
          if (searchedTitle && searchedTitle !== preferredTitle) {
            article = await this.extract("wikipedia", language, searchedTitle);
          }
        }
        if (article) sources.push(article);
      } catch (error) {
        sourceFailure ??= error;
      }
    }
    for (const language of LANGUAGES) {
      try {
        const title = await this.searchTitle("wikivoyage", language, placeName);
        if (!title) continue;
        const article = await this.extract("wikivoyage", language, title);
        if (article) sources.push(article);
      } catch (error) {
        sourceFailure ??= error;
      }
    }
    if (sources.length === 0 && sourceFailure) throw sourceFailure;

    let remaining = MAX_TOTAL_CHARACTERS;
    const bounded: PlaceGuideEvidenceSource[] = [];
    for (const source of sources) {
      if (remaining <= 0) break;
      const text = source.text.slice(0, remaining).trim();
      if (!text) continue;
      remaining -= text.length;
      bounded.push(text === source.text ? source : { ...source, text });
    }
    return bounded;
  }

  private async wikipediaSitelinks(wikidataId: string) {
    if (!/^Q[1-9][0-9]*$/.test(wikidataId)) return new Map<WikiLanguage, string>();
    const value = await this.api(new URL("https://www.wikidata.org/w/api.php"), {
      action: "wbgetentities",
      ids: wikidataId,
      props: "sitelinks",
      sitefilter: LANGUAGES.map((language) => `${language}wiki`).join("|"),
    });
    const entities = value?.entities;
    if (!entities || typeof entities !== "object" || Array.isArray(entities)) return new Map<WikiLanguage, string>();
    const entity = (entities as Record<string, unknown>)[wikidataId];
    if (!entity || typeof entity !== "object" || Array.isArray(entity)) return new Map<WikiLanguage, string>();
    const sitelinks = (entity as Record<string, unknown>).sitelinks;
    if (!sitelinks || typeof sitelinks !== "object" || Array.isArray(sitelinks)) return new Map<WikiLanguage, string>();
    const result = new Map<WikiLanguage, string>();
    for (const language of LANGUAGES) {
      const sitelink = (sitelinks as Record<string, unknown>)[`${language}wiki`];
      if (!sitelink || typeof sitelink !== "object" || Array.isArray(sitelink)) continue;
      const title = (sitelink as Record<string, unknown>).title;
      if (typeof title === "string" && title.trim()) result.set(language, title.trim());
    }
    return result;
  }

  private async searchTitle(family: WikiFamily, language: WikiLanguage, placeName: string) {
    const value = await this.wikiApi(family, language, {
      action: "query",
      list: "search",
      srnamespace: "0",
      srlimit: "1",
      srsearch: `"${placeName.replace(/"/g, "")}"`,
    });
    const query = value?.query;
    if (!query || typeof query !== "object" || Array.isArray(query)) return null;
    const results = (query as Record<string, unknown>).search;
    if (!Array.isArray(results)) return null;
    const first = results[0];
    if (!first || typeof first !== "object" || Array.isArray(first)) return null;
    const title = (first as Record<string, unknown>).title;
    return typeof title === "string" && title.trim() ? title.trim() : null;
  }

  private async extract(family: WikiFamily, language: WikiLanguage, requestedTitle: string) {
    const value = await this.wikiApi(family, language, {
      action: "query",
      prop: "extracts|info",
      explaintext: "1",
      exsectionformat: "plain",
      inprop: "url",
      redirects: "1",
      titles: requestedTitle,
    });
    const query = value?.query;
    if (!query || typeof query !== "object" || Array.isArray(query)) return null;
    const pages = (query as Record<string, unknown>).pages;
    if (!Array.isArray(pages)) return null;
    const page = pages[0];
    if (!page || typeof page !== "object" || Array.isArray(page)) return null;
    const item = page as Record<string, unknown>;
    const title = typeof item.title === "string" ? item.title.trim() : "";
    const text = typeof item.extract === "string"
      ? item.extract.trim().slice(0, MAX_EXTRACT_CHARACTERS)
      : "";
    if (!title || !text) return null;
    const url = this.articleUrl(family, language, title);
    return { title, url, text } satisfies PlaceGuideEvidenceSource;
  }

  private wikiApi(family: WikiFamily, language: WikiLanguage, parameters: Record<string, string>) {
    return this.api(new URL(`https://${language}.${family}.org/w/api.php`), parameters);
  }

  private articleUrl(family: WikiFamily, language: WikiLanguage, title: string) {
    const path = title.replace(/ /g, "_").split("/").map(encodeURIComponent).join("/");
    return `https://${language}.${family}.org/wiki/${path}`;
  }

  private async api(endpoint: URL, parameters: Record<string, string>): Promise<Record<string, unknown>> {
    for (const [key, value] of Object.entries({ ...parameters, format: "json", formatversion: "2" })) {
      endpoint.searchParams.set(key, value);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(endpoint, {
        signal: controller.signal,
        redirect: "manual",
        headers: {
          Accept: "application/json",
          "Api-User-Agent": this.userAgent,
          "User-Agent": this.userAgent,
        },
      });
      if (!response.ok) throw new Error(`Wikimedia API returned HTTP ${response.status}`);
      if (!/^application\/json\b/i.test(response.headers.get("content-type") ?? "")) {
        throw new Error("Wikimedia API returned a non-JSON response");
      }
      const bytes = await boundedBytes(response, MAX_RESPONSE_BYTES + 1);
      if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error("Wikimedia API response exceeded the size limit");
      const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Wikimedia API returned invalid JSON");
      }
      const result = value as Record<string, unknown>;
      if (result.error !== undefined) throw new Error("Wikimedia API returned an error response");
      return result;
    } finally {
      clearTimeout(timer);
    }
  }
}
