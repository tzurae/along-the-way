import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

const FULL_GOOGLE_MAPS_HOSTS = new Set([
  "google.com",
  "www.google.com",
  "maps.google.com",
  "www.google.co.jp",
  "maps.google.co.jp",
]);
const SHORT_GOOGLE_MAPS_HOST = "maps.app.goo.gl";
const ALLOWED_HOSTS = new Set([...FULL_GOOGLE_MAPS_HOSTS, SHORT_GOOGLE_MAPS_HOST]);

export type GoogleMapsUrlErrorCode =
  | "invalid_url"
  | "https_required"
  | "host_not_allowed"
  | "port_not_allowed"
  | "address_not_public"
  | "redirect_missing_location"
  | "too_many_redirects"
  | "response_too_large"
  | "unexpected_response"
  | "timeout";

export class GoogleMapsUrlError extends Error {
  constructor(
    readonly code: GoogleMapsUrlErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface GoogleMapsUrlResolution {
  originalUrl: string;
  resolvedUrl: string;
  redirectCount: number;
}

export interface GoogleMapsUrlResolverDependencies {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  resolveHost(host: string): Promise<string[]>;
}

export interface GoogleMapsUrlResolverLimits {
  maxRedirects?: number;
  maxResponseBytes?: number;
  requestTimeoutMs?: number;
  totalTimeoutMs?: number;
}

const defaults: Required<GoogleMapsUrlResolverLimits> = {
  maxRedirects: 4,
  maxResponseBytes: 16 * 1024,
  requestTimeoutMs: 2_000,
  totalTimeoutMs: 5_000,
};

export const defaultGoogleMapsUrlResolverDependencies: GoogleMapsUrlResolverDependencies = {
  fetch: (input, init) => fetch(input, init),
  async resolveHost(host) {
    return (await lookup(host, { all: true, verbatim: true })).map(
      (entry) => entry.address,
    );
  },
};

function parseUrl(value: string) {
  try {
    return new URL(value);
  } catch {
    throw new GoogleMapsUrlError("invalid_url", "Enter a valid Google Maps URL");
  }
}

function assertAllowedUrl(url: URL) {
  if (url.protocol !== "https:") {
    throw new GoogleMapsUrlError(
      "https_required",
      "Google Maps links must use HTTPS",
    );
  }
  if (url.port && url.port !== "443") {
    throw new GoogleMapsUrlError(
      "port_not_allowed",
      "Google Maps links cannot use a custom port",
    );
  }
  if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) {
    throw new GoogleMapsUrlError(
      "host_not_allowed",
      "Only approved Google Maps hosts are supported",
    );
  }
  if (url.username || url.password) {
    throw new GoogleMapsUrlError(
      "invalid_url",
      "Google Maps links cannot contain credentials",
    );
  }
}

function privateIpv4(address: string) {
  const octets = address.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some(
      (value) => !Number.isInteger(value) || value < 0 || value > 255,
    )
  ) return true;
  const [a, b, c] = octets as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function ipv6Groups(address: string) {
  const normalized = address.toLowerCase().split("%", 1)[0]!;
  const dotted = normalized.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  let expanded = normalized;
  if (dotted) {
    const octets = dotted.split(".").map(Number);
    if (
      octets.length !== 4 ||
      octets.some(
        (value) => !Number.isInteger(value) || value < 0 || value > 255,
      )
    ) return null;
    expanded = normalized.replace(
      dotted,
      `${((octets[0]! << 8) | octets[1]!).toString(16)}:${(
        (octets[2]! << 8) |
        octets[3]!
      ).toString(16)}`,
    );
  }
  const sides = expanded.split("::");
  if (sides.length > 2) return null;
  const left = sides[0] ? sides[0].split(":") : [];
  const right = sides[1] ? sides[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (
    missing < 0 ||
    (sides.length === 1 && missing !== 0) ||
    [...left, ...right].some((group) => !/^[0-9a-f]{1,4}$/.test(group))
  ) return null;
  return [
    ...left.map((group) => Number.parseInt(group, 16)),
    ...Array.from({ length: missing }, () => 0),
    ...right.map((group) => Number.parseInt(group, 16)),
  ];
}

function privateIpv6(address: string) {
  const groups = ipv6Groups(address);
  if (!groups || groups.length !== 8) return true;
  const first = groups[0]!;
  if (
    groups.every((group) => group === 0) ||
    (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xff00) === 0xff00
  ) return true;
  const mapped =
    groups.slice(0, 5).every((group) => group === 0) &&
    groups[5] === 0xffff;
  if (!mapped) return false;
  const high = groups[6]!;
  const low = groups[7]!;
  return privateIpv4(
    `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`,
  );
}

function isPublicAddress(address: string) {
  const family = isIP(address);
  if (family === 4) return !privateIpv4(address);
  if (family === 6) return !privateIpv6(address);
  return false;
}

async function assertPublicHost(
  host: string,
  dependencies: GoogleMapsUrlResolverDependencies,
  totalSignal: AbortSignal,
) {
  if (totalSignal.aborted) {
    throw new GoogleMapsUrlError(
      "timeout",
      "Google Maps did not resolve the link in time",
    );
  }
  let rejectOnAbort: (() => void) | undefined;
  try {
    const aborted = new Promise<never>((_, reject) => {
      rejectOnAbort = () => reject(new GoogleMapsUrlError(
        "timeout",
        "Google Maps did not resolve the link in time",
      ));
      totalSignal.addEventListener("abort", rejectOnAbort, { once: true });
    });
    const addresses = await Promise.race([
      dependencies.resolveHost(host),
      aborted,
    ]);
    if (
      addresses.length === 0 ||
      addresses.some((address) => !isPublicAddress(address))
    ) {
      throw new GoogleMapsUrlError(
        "address_not_public",
        "The Google Maps link resolved to a non-public address",
      );
    }
  } catch (error) {
    if (error instanceof GoogleMapsUrlError) throw error;
    throw new GoogleMapsUrlError(
      "unexpected_response",
      "The Google Maps host could not be resolved",
    );
  } finally {
    if (rejectOnAbort) {
      totalSignal.removeEventListener("abort", rejectOnAbort);
    }
  }
}

async function consumeBoundedBody(response: Response, maximum: number) {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > maximum) {
    await response.body?.cancel().catch(() => undefined);
    throw new GoogleMapsUrlError(
      "response_too_large",
      "The Google Maps redirect response was too large",
    );
  }
  if (!response.body) return;
  const reader = response.body.getReader();
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      received += value.byteLength;
      if (received > maximum) {
        throw new GoogleMapsUrlError(
          "response_too_large",
          "The Google Maps redirect response was too large",
        );
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export async function resolveGoogleMapsUrl(
  input: string,
  dependencies: GoogleMapsUrlResolverDependencies =
    defaultGoogleMapsUrlResolverDependencies,
  limits: GoogleMapsUrlResolverLimits = {},
): Promise<GoogleMapsUrlResolution> {
  const options = { ...defaults, ...limits };
  const originalUrl = input.trim();
  let current = parseUrl(originalUrl);
  assertAllowedUrl(current);

  if (current.hostname.toLowerCase() !== SHORT_GOOGLE_MAPS_HOST) {
    return { originalUrl, resolvedUrl: current.toString(), redirectCount: 0 };
  }

  const totalController = new AbortController();
  const totalTimer = setTimeout(() => totalController.abort(), options.totalTimeoutMs);
  try {
    for (let redirectCount = 0; ; redirectCount += 1) {
      if (redirectCount > options.maxRedirects) {
        throw new GoogleMapsUrlError(
          "too_many_redirects",
          "The Google Maps short link redirected too many times",
        );
      }
      assertAllowedUrl(current);
      await assertPublicHost(current.hostname, dependencies, totalController.signal);
      const requestController = new AbortController();
      const requestTimer = setTimeout(
        () => requestController.abort(),
        options.requestTimeoutMs,
      );
      const abortRequest = () => requestController.abort();
      totalController.signal.addEventListener("abort", abortRequest, { once: true });
      try {
        const response = await dependencies.fetch(current, {
          method: "GET",
          redirect: "manual",
          signal: requestController.signal,
          headers: {
            Accept: "text/html,application/xhtml+xml",
            "User-Agent": "AlongTheWay-GoogleMapsResolver/1.0",
          },
        });
        if (response.status >= 300 && response.status < 400) {
          await consumeBoundedBody(response, options.maxResponseBytes);
          const location = response.headers.get("location");
          if (!location) {
            throw new GoogleMapsUrlError(
              "redirect_missing_location",
              "The Google Maps short link returned an invalid redirect",
            );
          }
          if (redirectCount === options.maxRedirects) {
            throw new GoogleMapsUrlError(
              "too_many_redirects",
              "The Google Maps short link redirected too many times",
            );
          }
          const next = new URL(location, current);
          assertAllowedUrl(next);
          await assertPublicHost(next.hostname, dependencies, totalController.signal);
          if (next.hostname.toLowerCase() !== SHORT_GOOGLE_MAPS_HOST) {
            return {
              originalUrl,
              resolvedUrl: next.toString(),
              redirectCount: redirectCount + 1,
            };
          }
          current = next;
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new GoogleMapsUrlError(
            "unexpected_response",
            "Google Maps could not resolve this link",
          );
        }
        await consumeBoundedBody(response, options.maxResponseBytes);
        return {
          originalUrl,
          resolvedUrl: current.toString(),
          redirectCount,
        };
      } catch (error) {
        if (error instanceof GoogleMapsUrlError) throw error;
        if (
          requestController.signal.aborted ||
          totalController.signal.aborted ||
          (error instanceof DOMException && error.name === "AbortError")
        ) {
          throw new GoogleMapsUrlError(
            "timeout",
            "Google Maps did not resolve the link in time",
          );
        }
        throw new GoogleMapsUrlError(
          "unexpected_response",
          "Google Maps could not resolve this link",
        );
      } finally {
        clearTimeout(requestTimer);
        totalController.signal.removeEventListener("abort", abortRequest);
      }
    }
  } finally {
    clearTimeout(totalTimer);
  }
}

export function googleMapsPlaceId(url: string) {
  const parsed = parseUrl(url);
  assertAllowedUrl(parsed);
  return (
    parsed.searchParams.get("query_place_id") ??
    parsed.searchParams.get("place_id") ??
    undefined
  );
}

export function googleMapsSearchText(url: string) {
  const parsed = parseUrl(url);
  assertAllowedUrl(parsed);
  const parts = parsed.pathname.split("/");
  const placeIndex = parts.findIndex((part) => part === "place");
  const encodedName = placeIndex >= 0 ? parts[placeIndex + 1] : undefined;
  if (encodedName) {
    try {
      return decodeURIComponent(encodedName.replaceAll("+", " "));
    } catch {
      throw new GoogleMapsUrlError(
        "invalid_url",
        "The Google Maps link contains an invalid place name",
      );
    }
  }
  return parsed.searchParams.get("query")?.trim() || undefined;
}
