import { describe, expect, it } from "vitest";

import {
  GoogleMapsUrlError,
  googleMapsSearchText,
  resolveGoogleMapsUrl,
  type GoogleMapsUrlResolverDependencies,
} from "../src/trip-places/safe-google-maps-url";

function dependencies(
  responses: Response[],
  addresses: Record<string, string[]> = {
    "maps.app.goo.gl": ["142.250.72.238"],
    "www.google.com": ["142.250.72.228"],
  },
): GoogleMapsUrlResolverDependencies {
  return {
    fetch: async () => {
      const response = responses.shift();
      if (!response) throw new Error("Unexpected fetch");
      return response;
    },
    resolveHost: async (host) => addresses[host] ?? ["127.0.0.1"],
  };
}

function redirect(location: string) {
  return new Response(null, { status: 302, headers: { location } });
}

describe("safe Google Maps URL resolution", () => {
  it("accepts an approved full URL without making a server request", async () => {
    const deps = dependencies([]);
    await expect(
      resolveGoogleMapsUrl(
        "https://www.google.com/maps/place/Kiyomizu-dera/?query_place_id=ChIJ-test",
        deps,
      ),
    ).resolves.toEqual({
      originalUrl:
        "https://www.google.com/maps/place/Kiyomizu-dera/?query_place_id=ChIJ-test",
      resolvedUrl:
        "https://www.google.com/maps/place/Kiyomizu-dera/?query_place_id=ChIJ-test",
      redirectCount: 0,
    });
  });

  it("resolves only approved HTTPS short-link redirects", async () => {
    const deps = dependencies([
      redirect("https://www.google.com/maps/place/Kinkaku-ji/?query_place_id=ChIJ-gold"),
    ]);
    await expect(
      resolveGoogleMapsUrl("https://maps.app.goo.gl/approved", deps),
    ).resolves.toMatchObject({
      resolvedUrl:
        "https://www.google.com/maps/place/Kinkaku-ji/?query_place_id=ChIJ-gold",
      redirectCount: 1,
    });
  });

  it.each([
    ["http://maps.app.goo.gl/insecure", "https_required"],
    ["https://maps.app.goo.gl:444/path", "port_not_allowed"],
    ["https://example.test/maps", "host_not_allowed"],
  ])("rejects unsafe input %s", async (url, code) => {
    await expect(resolveGoogleMapsUrl(url, dependencies([]))).rejects.toMatchObject({
      code,
    });
  });

  it("reports a malformed encoded place name as an invalid URL", () => {
    expect(() =>
      googleMapsSearchText("https://www.google.com/maps/place/%E0%A4%A")
    ).toThrow(expect.objectContaining<Partial<GoogleMapsUrlError>>({
      code: "invalid_url",
    }));
  });

  it("rejects a redirect to a non-Google host before requesting it", async () => {
    const deps = dependencies([redirect("https://example.test/steal")]);
    await expect(
      resolveGoogleMapsUrl("https://maps.app.goo.gl/unsafe", deps),
    ).rejects.toMatchObject({ code: "host_not_allowed" });
  });

  it("rejects a terminal approved redirect whose resolved address is not public", async () => {
    const deps = dependencies(
      [redirect("https://www.google.com/maps/place/Kyoto")],
      {
        "maps.app.goo.gl": ["142.250.72.238"],
        "www.google.com": ["127.0.0.1"],
      },
    );
    await expect(
      resolveGoogleMapsUrl("https://maps.app.goo.gl/private-terminal", deps),
    ).rejects.toMatchObject({ code: "address_not_public" });
  });

  it.each([
    "127.0.0.1",
    "169.254.169.254",
    "10.0.0.3",
    "192.0.2.10",
    "::1",
    "fc00::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
  ])(
    "rejects private, link-local, or loopback address %s",
    async (address) => {
      const deps = dependencies([redirect("https://www.google.com/maps")], {
        "maps.app.goo.gl": [address],
      });
      await expect(
        resolveGoogleMapsUrl("https://maps.app.goo.gl/private", deps),
      ).rejects.toMatchObject({ code: "address_not_public" });
    },
  );

  it("caps redirect depth", async () => {
    const deps = dependencies([
      redirect("https://maps.app.goo.gl/2"),
      redirect("https://maps.app.goo.gl/3"),
      redirect("https://maps.app.goo.gl/4"),
      redirect("https://maps.app.goo.gl/5"),
      redirect("https://maps.app.goo.gl/6"),
    ]);
    await expect(
      resolveGoogleMapsUrl("https://maps.app.goo.gl/1", deps, {
        maxRedirects: 3,
      }),
    ).rejects.toMatchObject({ code: "too_many_redirects" });
  });

  it("caps final response size", async () => {
    const deps = dependencies([
      new Response("x".repeat(33), {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    ]);
    await expect(
      resolveGoogleMapsUrl("https://maps.app.goo.gl/large", deps, {
        maxResponseBytes: 32,
      }),
    ).rejects.toMatchObject({ code: "response_too_large" });
  });

  it("caps a redirect response body before following its location", async () => {
    const deps = dependencies([
      new Response("x".repeat(33), {
        status: 302,
        headers: {
          location: "https://www.google.com/maps/place/Kyoto",
        },
      }),
    ]);
    await expect(
      resolveGoogleMapsUrl("https://maps.app.goo.gl/large-redirect", deps, {
        maxResponseBytes: 32,
      }),
    ).rejects.toMatchObject({ code: "response_too_large" });
  });

  it("cancels a declared oversized redirect body before rejecting it", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const deps = dependencies([
      new Response(body, {
        status: 302,
        headers: {
          "content-length": "33",
          location: "https://www.google.com/maps/place/Kyoto",
        },
      }),
    ]);
    await expect(
      resolveGoogleMapsUrl("https://maps.app.goo.gl/declared-large", deps, {
        maxResponseBytes: 32,
      }),
    ).rejects.toMatchObject({ code: "response_too_large" });
    expect(cancelled).toBe(true);
  });

  it("cancels an HTTP-error response body before rejecting it", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const deps = dependencies([
      new Response(body, { status: 503 }),
    ]);
    await expect(
      resolveGoogleMapsUrl("https://maps.app.goo.gl/provider-error", deps),
    ).rejects.toMatchObject({ code: "unexpected_response" });
    expect(cancelled).toBe(true);
  });

  it("turns fetch aborts into an understandable timeout", async () => {
    const deps: GoogleMapsUrlResolverDependencies = {
      fetch: async () => {
        throw new DOMException("Aborted", "AbortError");
      },
      resolveHost: async () => ["142.250.72.238"],
    };
    await expect(
      resolveGoogleMapsUrl("https://maps.app.goo.gl/timeout", deps, {
        requestTimeoutMs: 1,
        totalTimeoutMs: 2,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<GoogleMapsUrlError>>({ code: "timeout" }),
    );
  });

  it("applies the total timeout while resolving DNS", async () => {
    const deps: GoogleMapsUrlResolverDependencies = {
      fetch: async () => {
        throw new Error("Fetch must not run before DNS resolution");
      },
      resolveHost: () => new Promise(() => undefined),
    };
    await expect(
      resolveGoogleMapsUrl("https://maps.app.goo.gl/dns-timeout", deps, {
        totalTimeoutMs: 5,
      }),
    ).rejects.toMatchObject({ code: "timeout" });
  });
});
