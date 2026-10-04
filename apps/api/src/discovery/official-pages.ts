import { lookup } from "node:dns/promises";

import { isPublicAddress } from "../trip-places/safe-google-maps-url";
import type { WebSourceType } from "./discovery-model";
import { normalizePlaceName } from "./place-names";

// Government domains by suffix. These are naming conventions, not destination rules.
const GOVERNMENT_HOSTS = [
  /\.gov$/, /\.gov\.[a-z]{2}$/, /\.go\.[a-z]{2}$/, /\.gouv\.[a-z]{2}$/, /\.gob\.[a-z]{2}$/,
  /\.govt\.[a-z]{2}$/, /\.lg\.jp$/, /\.gv\.at$/, /\.gc\.ca$/, /\.admin\.ch$/,
];

// Commercial, booking, review, social and reference platforms never count as an official tourism
// source. Domains match themselves and their subdomains; brands match a host label under any TLD.
const PLATFORM_DOMAINS = [
  "booking.com", "trip.com", "klook.com", "kkday.com", "hotels.com", "youtube.com", "facebook.com",
  "instagram.com", "x.com", "twitter.com", "tiktok.com", "reddit.com", "medium.com", "wordpress.com",
  "wikipedia.org", "wikivoyage.org", "xiaohongshu.com", "tabelog.com", "retty.me", "jalan.net",
  "gurunavi.com", "hotpepper.jp", "pixnet.net", "note.com", "ameblo.jp", "naver.com", "daum.net",
  "dcard.tw", "ptt.cc",
];
const PLATFORM_BRANDS = [
  "tripadvisor", "agoda", "expedia", "airbnb", "yelp", "google", "pinterest", "blogspot", "rakuten",
];

function isPlatformHost(host: string) {
  const labels = host.split(".");
  return PLATFORM_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))
    || PLATFORM_BRANDS.some((brand) => labels.includes(brand));
}

function sameSite(host: string, other: string) {
  const a = host.replace(/^www\./, "");
  const b = other.replace(/^www\./, "");
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/**
 * A cited page counts as an official tourism source when its host is a government domain,
 * or the model called it a government or tourism-board page and the host is neither a
 * commercial platform nor the place's own website (which only describes itself).
 */
export function isOfficialTourismSource(url: string, type: WebSourceType, placeWebsite: string | null) {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (placeWebsite) {
    try {
      if (sameSite(host, new URL(placeWebsite).hostname.toLowerCase())) return false;
    } catch {
      // An unparsable place website cannot exclude anything.
    }
  }
  if (isPlatformHost(host)) return false;
  if (GOVERNMENT_HOSTS.some((pattern) => pattern.test(host))) return true;
  return type === "government" || type === "tourism_board";
}

export interface PublicPageDependencies {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  resolveHost(host: string): Promise<string[]>;
}

export const defaultPublicPageDependencies: PublicPageDependencies = {
  fetch: (input, init) => fetch(input, init),
  async resolveHost(host) {
    return (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);
  },
};

export interface PublicPageLimits {
  maxRedirects: number;
  maxBytes: number;
  requestTimeoutMs: number;
  totalTimeoutMs: number;
}

const DEFAULT_LIMITS: PublicPageLimits = {
  maxRedirects: 3,
  maxBytes: 1_000_000,
  requestTimeoutMs: 4_000,
  totalTimeoutMs: 8_000,
};

function allowedUrl(value: URL) {
  return value.protocol === "https:" && (!value.port || value.port === "443") && !value.username && !value.password;
}

/** Resolves the host within the remaining time; any non-public address refuses the page. */
async function publicHost(host: string, dependencies: PublicPageDependencies, signal: AbortSignal) {
  if (signal.aborted) return false;
  let onAbort: (() => void) | undefined;
  try {
    const aborted = new Promise<null>((resolve) => {
      onAbort = () => resolve(null);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    const addresses = await Promise.race([dependencies.resolveHost(host), aborted]);
    return addresses !== null && addresses.length > 0 && addresses.every(isPublicAddress);
  } catch {
    return false;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

async function boundedBytes(response: Response, maximum: number) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (received < maximum) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = maximum - received;
      chunks.push(value.byteLength > room ? value.subarray(0, room) : value);
      received += Math.min(value.byteLength, room);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function decode(bytes: Uint8Array, contentType: string) {
  const declared = /charset=["']?([\w-]+)/i.exec(contentType)?.[1]
    ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(new TextDecoder("latin1").decode(bytes.subarray(0, 4_096)))?.[1]
    ?? "utf-8";
  try {
    return new TextDecoder(declared.toLowerCase()).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };

function decodeEntities(text: string) {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (entity, body: string) => {
    const code = body.startsWith("#x") || body.startsWith("#X")
      ? Number.parseInt(body.slice(2), 16)
      : body.startsWith("#") ? Number.parseInt(body.slice(1), 10) : null;
    if (code === null) return ENTITIES[body.toLowerCase()] ?? entity;
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

const RAW_TEXT_ELEMENT = /^<(script|style|noscript)\b/;

/**
 * Visible text of an HTML page, without scripts, styles or markup. A single forward scan:
 * untrusted pages with unclosed tags cannot make it slow (regex stripping was quadratic).
 */
export function htmlText(html: string) {
  const parts: string[] = [];
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf("<", index);
    if (open === -1) {
      parts.push(html.slice(index));
      break;
    }
    parts.push(html.slice(index, open), " ");
    const element = RAW_TEXT_ELEMENT.exec(html.slice(open, open + 10).toLowerCase())?.[1];
    let end = open;
    if (element) {
      // A literal, case-insensitive search from one position: linear in the page length.
      const closing = new RegExp(`</${element}`, "gi");
      closing.lastIndex = open + 1;
      end = closing.exec(html)?.index ?? -1;
    }
    // An unclosed script or tag hides the rest of the page rather than being scanned again.
    if (end === -1) break;
    const close = html.indexOf(">", end);
    if (close === -1) break;
    index = close + 1;
  }
  return decodeEntities(parts.join(""));
}

/**
 * Fetches an HTTPS page whose every hop resolves only to public addresses, within redirect,
 * size and time limits. Any failure means the page cannot vouch for anything: null.
 */
export async function fetchPublicPageText(
  url: string,
  dependencies: PublicPageDependencies = defaultPublicPageDependencies,
  limits: Partial<PublicPageLimits> = {},
): Promise<string | null> {
  const options = { ...DEFAULT_LIMITS, ...limits };
  let current: URL;
  try {
    current = new URL(url);
  } catch {
    return null;
  }
  const total = new AbortController();
  const totalTimer = setTimeout(() => total.abort(), options.totalTimeoutMs);
  try {
    for (let redirects = 0; redirects <= options.maxRedirects; redirects += 1) {
      if (!allowedUrl(current) || !(await publicHost(current.hostname, dependencies, total.signal)) || total.signal.aborted) return null;
      const request = new AbortController();
      const requestTimer = setTimeout(() => request.abort(), options.requestTimeoutMs);
      const abort = () => request.abort();
      total.signal.addEventListener("abort", abort, { once: true });
      try {
        const response = await dependencies.fetch(current, {
          method: "GET",
          redirect: "manual",
          signal: request.signal,
          headers: {
            Accept: "text/html,application/xhtml+xml,text/plain",
            "User-Agent": "AlongTheWay-SourceCheck/1.0",
          },
        });
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel().catch(() => undefined);
          const location = response.headers.get("location");
          if (!location) return null;
          current = new URL(location, current);
          continue;
        }
        const contentType = response.headers.get("content-type") ?? "";
        if (!response.ok || !/text\/html|application\/xhtml\+xml|text\/plain/i.test(contentType)) {
          await response.body?.cancel().catch(() => undefined);
          return null;
        }
        return htmlText(decode(await boundedBytes(response, options.maxBytes), contentType));
      } catch {
        return null;
      } finally {
        clearTimeout(requestTimer);
        total.signal.removeEventListener("abort", abort);
      }
    }
    return null;
  } finally {
    clearTimeout(totalTimer);
  }
}

function foldedTokens(value: string) {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").normalize("NFKC").toLocaleLowerCase("en")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

// Scripts written without spaces between words, where only substrings can be searched.
const UNSPACED = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}ー々〆]+$/u;
/** A shorter unspaced name ("東寺") also occurs inside unrelated words ("關東寺院"). */
const MIN_UNSPACED_LENGTH = 3;

/**
 * True when the page text names the place. Spaced scripts match whole words, allowing the
 * name's separators to differ ("Tofuku-ji", "Tofukuji"), so "To-ji" is not found in
 * "Kyoto Jidai"; unspaced names match as substrings of at least three characters.
 */
export function pageMentions(text: string, names: readonly string[]) {
  const pageTokens = foldedTokens(text);
  let compactPage: string | null = null;
  return names.some((name) => {
    const joined = foldedTokens(name).join("");
    if (!joined) return false;
    if (UNSPACED.test(joined)) {
      compactPage ??= pageTokens.join("");
      return [...joined].length >= MIN_UNSPACED_LENGTH && compactPage.includes(joined);
    }
    for (let start = 0; start < pageTokens.length; start += 1) {
      let combined = "";
      for (let end = start; end < pageTokens.length && combined.length < joined.length; end += 1) {
        combined += pageTokens[end];
        if (!joined.startsWith(combined)) break;
        if (combined === joined) return true;
      }
    }
    return false;
  });
}
